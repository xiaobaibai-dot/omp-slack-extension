import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { phasedUpload } from "./upload.ts";
import { sourceFile } from "./download.ts";
import { slackText, safeError } from "./security.ts";
import {retryNetwork, responseError, fetchError, networkClock} from "./network.ts";
import type {NetworkClock} from "./network.ts";
import {connectionError, connectionFailure, connectionWait, credentialFailure, reconnectDelay} from "./reconnect.ts";
import type {ConnectionStatus} from "./reconnect.ts";
import type { Config, Route, Transport } from "./types.ts";
export class SlackTransport implements Transport {
  #stopped = false;
  #ready = false;
  #verified = false;
  #abort = new AbortController();
  #attempt?: {socket: SocketModeClient; controller: AbortController; lost: Promise<unknown>; lose(error: unknown): void; connectedAt?: number; error?: unknown};
  #onEvent?: (body: unknown) => void;
  #onDisconnect?: (error: unknown) => void;
  #onState?: (status: ConnectionStatus) => void;
  #status: ConnectionStatus = {state: "starting", failures: 0};
  #stopPromise?: Promise<void>;
  #closing?: Promise<void>;
  readonly config: Config;
  readonly clock: NetworkClock;
  readonly logger = {debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, setName() {}, getLevel: () => LogLevel.ERROR};
  constructor(config: Config, clock: NetworkClock = networkClock) {this.config = config; this.clock = clock;}
  connectionStatus(): ConnectionStatus {return {...this.#status};}
  #state(status: ConnectionStatus) {this.#status = status;this.#onState?.({...status});}
  async start(onEvent: (body: unknown) => void, onDisconnect?: (error: unknown) => void, onState?: (status: ConnectionStatus) => void) {
    this.#abort.signal.throwIfAborted();
    if (this.#onEvent) throw new Error("Slack transport has already started.");
    this.#onEvent = onEvent;this.#onDisconnect = onDisconnect;this.#onState = onState;
    try {
      let authError: unknown;
      const auth = await this.#api(async web => {try {return await web.auth.test();} catch (error) {authError = error;throw error;}}, "read")
        .catch(error => {if (authError && connectionFailure(authError, this.clock.now()).kind === "fatal") throw connectionError(connectionFailure(authError, this.clock.now()).reason);throw error;});
      const appId = (auth as {app_id?: string}).app_id;
      if (!auth.ok || !auth.bot_id || !auth.team_id || !auth.user_id || auth.team_id !== this.config.teamId || (appId && appId !== this.config.appId)) throw new Error("Bot identity/workspace verification failed.");
      this.#abort.signal.throwIfAborted();
      await this.#connect();
      if (!this.#ready || this.#stopped) throw connectionError("socket_closed");
      this.#verified = true;
      this.#state({state: "connected", failures: 0});
      void this.#supervise().catch(error => {if (!this.#stopped) this.#fatal(error);});
      return {teamId: auth.team_id, botUserId: auth.user_id};
    } catch (error) {await this.stop();throw error;}
  }
  async #connect() {
    this.#abort.signal.throwIfAborted();
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.#abort.signal]);
    const options = {retryConfig: {retries: 0}, rejectRateLimitedCalls: true, timeout: 10_000, logger: this.logger,
      requestInterceptor: (args: any) => ({...args, signal})};
    // Only this supervisor retries; every attempt gets a fresh SDK instance and abort signal.
    const socket = new SocketModeClient({appToken: this.config.appToken, autoReconnectEnabled: false, logger: this.logger, clientOptions: options});
    const lost = Promise.withResolvers<unknown>();
    const attempt = {socket, controller, lost: lost.promise, lose: lost.resolve, connectedAt: undefined as number | undefined, error: undefined as unknown};
    this.#attempt = attempt;
    const current = () => this.#attempt === attempt && !signal.aborted && !this.#stopped;
    const guard = () => {signal.throwIfAborted();if (!current()) throw connectionError("socket_stale_attempt");};
    socket.on("error", error => {
      if (!current()) return;
      attempt.error = error; // Retain structured evidence locally; never print the raw SDK error.
      const failure = connectionFailure(error, this.clock.now());
      if (failure.kind === "fatal") this.#fatal(connectionError(failure.reason));
    });
    // The SDK emits authenticated before constructing a websocket. Abort blocks late HTTP completions.
    socket.on("authenticated", guard);socket.on("connecting", guard);
    socket.on("connected", () => {
      if (!current()) {socket.websocket?.disconnect();return;}
      attempt.connectedAt = this.clock.now();this.#ready = true;
    });
    socket.on("disconnected", () => {if (current()) {this.#ready = false;lost.resolve(connectionError("socket_closed"));}});
    // Public SDK raw websocket event is the only surface retaining Slack's disconnect reason.
    socket.on("ws_message", (data: {toString(): string}, binary: boolean) => {
      if (!current() || binary) return;
      try {const event = JSON.parse(data.toString());if (event.type === "disconnect" && event.reason === "link_disabled") {
        this.#ready = false;this.#fatal(connectionError("link_disabled"));
      }} catch { /* SDK ignores malformed payloads too. */ }
    });
    socket.on("slack_event", (input: {ack: () => Promise<void>; type: string; body: unknown}) => {
      // ACK even ignored/old envelopes. Never admit an old socket's payload after replacement.
      void input.ack().catch(() => {});
      if (current() && this.#ready && input.type === "events_api") this.#onEvent?.(input.body);
    });
    let timer: NodeJS.Timeout | undefined, abort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(connectionError("socket_cancelled"));
        signal.addEventListener("abort", abort, {once: true});
        timer = this.clock.setTimeout(() => {const error = connectionError("socket_connect_timeout");reject(error);controller.abort(error);}, 30_000);
        timer.unref?.();
        Promise.resolve().then(() => {guard();return socket.start();}).then(() => resolve(), reject);
        if (signal.aborted) abort();
      });
      guard();
      if (!this.#ready) throw connectionError("socket_closed");
    } catch (error) {throw attempt.error ?? error;}
    finally {if (timer) this.clock.clearTimeout(timer);signal.removeEventListener("abort", abort);}
  }
  #closeAttempt(): Promise<void> {
    if (this.#closing) return this.#closing;
    const attempt = this.#attempt;
    if (!attempt) return Promise.resolve();
    this.#attempt = undefined;this.#ready = false;
    attempt.controller.abort(connectionError("socket_cancelled"));
    const closing = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {await Promise.race([attempt.socket.disconnect().catch(() => {}), new Promise<void>(resolve => {
        timer = this.clock.setTimeout(resolve, 2000);timer.unref?.();
      })]);} finally {if (timer) this.clock.clearTimeout(timer);attempt.socket.websocket?.disconnect();}
    })();
    const joined = closing.finally(() => {if (this.#closing === joined) this.#closing = undefined;});
    this.#closing = joined;return joined;
  }
  async #supervise() {
    let failures = 0, unknowns = 0;
    while (!this.#stopped) {
      const attempt = this.#attempt!;
      let error = await attempt.lost;
      error = attempt.error ?? error;
      if (this.#stopped) return;
      if (attempt.connectedAt !== undefined && this.clock.now() - attempt.connectedAt >= 60_000) {failures = 0;unknowns = 0;}
      for (;;) {
        const failure = connectionFailure(error, this.clock.now());
        if (failure.kind === "fatal" || (failure.kind === "unknown" && ++unknowns >= 3)) {
          this.#fatal(connectionError(failure.reason));return;
        }
        const delay = reconnectDelay(failures++, failure.retryAfterMs, this.clock);
        const retryAt = this.clock.now() + delay;
        this.#state({state: "reconnecting", failures, reason: failure.reason, nextAttemptAt: new Date(retryAt).toISOString()});
        await this.#closeAttempt();
        await connectionWait(Math.max(0, retryAt - this.clock.now()), this.#abort.signal, this.clock);
        try {
          await this.#connect();
          if (!this.#ready || this.#stopped) throw connectionError("socket_closed");
          this.#state({state: "connected", failures});break;
        } catch (next) {if (this.#stopped) return;error = next;}
      }
    }
  }
  #fatal(error: unknown) {
    if (this.#stopped) return;
    this.#status = {...this.#status, reason: safeError(error)};
    void this.stop().catch(() => {});
    this.#onDisconnect?.(error);
  }
  isReady() { return this.#ready && !this.#stopped; }
  #client(signal: AbortSignal) {
    return new WebClient(this.config.botToken, {retryConfig: {retries: 0}, rejectRateLimitedCalls: true,
      timeout: 10_000, logger: this.logger, requestInterceptor: args => ({...args, signal})});
  }
  #api<T>(operation: (web: WebClient) => Promise<T>, kind: "read" | "mutation", requestSignal?: AbortSignal) {
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.#abort.signal]) : this.#abort.signal;
    return retryNetwork(inner => this.#inspectCredentials(() => operation(this.#client(inner))), {signal, kind, clock: this.clock});
  }
  async #inspectCredentials<T>(operation: () => Promise<T>): Promise<T> {
    try {return await operation();}
    catch (error) {
      // Keep structured credential evidence until classified; retryNetwork intentionally redacts it.
      if (this.#verified && credentialFailure(error)) this.#fatal(connectionError(connectionFailure(error, this.clock.now()).reason));
      throw error;
    }
  }
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;this.#ready = false;
    this.#abort.abort(connectionError("socket_cancelled"));
    this.#attempt?.lose(connectionError("socket_cancelled"));
    this.#state({state: "stopped", failures: this.#status.failures, reason: this.#status.reason});
    this.#stopPromise = this.#closeAttempt();return this.#stopPromise;
  }
  // Socket Mode receives events; HTTP Web API sends replies. A temporary socket outage
  // alone must not revoke an existing request's HTTP permissions or cancel its native work.
  #check() {if (this.#stopped || !this.#verified) throw new Error("Slack is off or not authenticated.");}
  async post(route: Route, text: string, requestSignal?: AbortSignal) {
    this.#check();
    await this.#api(web => {this.#check();return web.chat.postMessage({channel: route.channel, thread_ts: route.thread,
      text: slackText(text), mrkdwn: true, parse: "none", link_names: false,
      reply_broadcast: false, unfurl_links: false, unfurl_media: false});}, "mutation", requestSignal);
  }
  async readThread(route: Route, cursor?: string, requestSignal?: AbortSignal) {
    this.#check();
    const page = await this.#api(web => {this.#check();return web.conversations.replies({channel: route.channel, ts: route.thread, cursor, limit: 15});}, "read", requestSignal);
    this.#check();
    return {messages: (page.messages ?? []).slice(0, 15).map(m => ({user: m.user ?? m.bot_id ?? "unknown", ts: m.ts ?? "", text: (m.text ?? "").slice(0, 2000)})),
      nextCursor: page.response_metadata?.next_cursor || undefined,
      truncated: Boolean(page.has_more || page.response_metadata?.next_cursor || page.messages?.some(m => (m.text?.length ?? 0) > 2000))};
  }
  async upload(route: Route, content: Buffer, filename: string, title: string, requestSignal: AbortSignal) {
    const signal = AbortSignal.any([requestSignal, this.#abort.signal]);
    return phasedUpload({
      getURL: args => this.#api(web => web.files.getUploadURLExternal(args), "mutation", signal),
      complete: args => this.#api(web => web.files.completeUploadExternal(args), "mutation", signal),
    }, async (url, bytes, uploadSignal) => {
      await retryNetwork(async inner => {
        const response = await fetch(url, {method: "POST", body: bytes as Uint8Array<ArrayBuffer>, redirect: "error", signal: inner, headers: {"Content-Type": "application/octet-stream"}}).catch(error => {throw inner.aborted ? inner.reason : fetchError(error);});
        if (!response.ok) {await response.body?.cancel();throw responseError(response);}
        await response.body?.cancel();
      }, {signal: uploadSignal, kind: "mutation", timeoutMs: 30_000, clock: this.clock});
    }, route, content, filename, title, signal, () => this.#check());
  }
  async list(cursor?: string) {
    this.#check();
    const page = await this.#api(web => {this.#check();return web.users.conversations({types: "public_channel,private_channel,im", exclude_archived: true, limit: 100, cursor});}, "read");
    this.#check();
    return {conversations: (page.channels ?? []).slice(0, 100).filter(c => c.id).map(c => ({id: c.id!, name: c.name ?? c.id!, isPrivate: Boolean(c.is_private), isIm: Boolean(c.is_im)})), nextCursor: page.response_metadata?.next_cursor || undefined};
  }
  async download(route: Route, fileId: string, requestSignal: AbortSignal) {
    const signal = AbortSignal.any([requestSignal, this.#abort.signal]);
    return retryNetwork(inner => this.#inspectCredentials(() => sourceFile(id => this.#client(inner).files.info({file: id}),
      async (url, downloadSignal) => {
        const response = await fetch(url, {headers: {Authorization: `Bearer ${this.config.botToken}`}, redirect: "error", signal: downloadSignal}).catch(error => {throw downloadSignal.aborted ? downloadSignal.reason : fetchError(error);});
        if (!response.ok) {await response.body?.cancel();throw responseError(response);}
        return response;
      }, route, fileId, inner, () => this.#check())), {signal, kind: "read", timeoutMs: 30_000, clock: this.clock});
  }
}
