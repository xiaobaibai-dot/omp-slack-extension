import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { phasedUpload } from "./upload.ts";
import { sourceFile } from "./download.ts";
import { slackText } from "./security.ts";
import {retryNetwork, responseError, fetchError, networkClock} from "./network.ts";
import type {NetworkClock} from "./network.ts";
import type { Config, Route, Transport } from "./types.ts";
export class SlackTransport implements Transport {
  #socket: SocketModeClient;
  #stopped = false;
  #ready = false;
  #abort = new AbortController();
  #reconnect?: NodeJS.Timeout;
  #onDisconnect?: (error: unknown) => void;
  readonly config: Config;
  readonly clock: NetworkClock;
  readonly logger = {debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, setName() {}, getLevel: () => LogLevel.ERROR};
  constructor(config: Config, clock: NetworkClock = networkClock) {
    this.config = config;
    this.clock = clock;
    // Disable SDK HTTP retries and its rate-limit queue wait. Only our bounded,
    // cancellable operation-aware layer retries Web API requests.
    const options = {retryConfig: {retries: 0}, rejectRateLimitedCalls: true, timeout: 10_000, logger: this.logger,
      requestInterceptor: (args: any) => ({...args, signal: this.#abort.signal})};
    // 2.0.7's internal reconnect leaves rejected/pending promises unhandled. Own the wait instead.
    this.#socket = new SocketModeClient({appToken: config.appToken, autoReconnectEnabled: false, logger: this.logger, clientOptions: options});
    // Avoid uncaught EventEmitter error events. Raw errors are not printed (may contain secrets).
    this.#socket.on("error", () => {});
    // A request already in flight must not create a late socket after off/timeout.
    this.#socket.on("authenticated", () => this.#abort.signal.throwIfAborted());
    this.#socket.on("connecting", () => this.#abort.signal.throwIfAborted());
    this.#socket.on("connected", () => { if (!this.#stopped) this.#ready = true; });
    this.#socket.on("disconnected", () => {
      const wasReady = this.#ready;
      this.#ready = false;
      if (!wasReady || this.#stopped || this.#reconnect) return;
      this.#reconnect = setTimeout(() => {
        this.#reconnect = undefined;
        if (this.#stopped) return;
        void this.#connect().catch(error => {
          if (this.#stopped) return;
          void this.stop().catch(() => {});
          this.#onDisconnect?.(error);
        });
      }, 1000);
      this.#reconnect.unref?.();
    });
  }
  async start(onEvent: (body: unknown) => void, onDisconnect?: (error: unknown) => void) {
    this.#abort.signal.throwIfAborted();
    this.#onDisconnect = onDisconnect;
    const auth = await this.#api(web => web.auth.test(), "read");
    const appId = (auth as {app_id?: string}).app_id;
    if (!auth.ok || !auth.bot_id || !auth.team_id || !auth.user_id || auth.team_id !== this.config.teamId || (appId && appId !== this.config.appId)) throw new Error("Bot identity/workspace verification failed.");
    if (this.#stopped) throw new Error("Slack start was cancelled.");
    this.#socket.on("slack_event", (input: {ack: () => Promise<void>; type: string; body: unknown}) => {
      // ACK even ignored, unauthorized and duplicate payloads, before any LLM or file work.
      void input.ack().catch(() => {});
      if (!this.#stopped && input.type === "events_api") onEvent(input.body);
    });
    await this.#connect();
    return {teamId: auth.team_id, botUserId: auth.user_id};
  }
  async #wait<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let abort = () => {};
    try {
      return await new Promise<T>((resolve, reject) => {
        operation.then(resolve, reject);
        abort = () => reject(new Error("Slack connection was cancelled."));
        this.#abort.signal.addEventListener("abort", abort, {once: true});
        timer = setTimeout(() => reject(new Error("Slack connection timed out.")), 30_000);
        timer.unref?.();
        if (this.#abort.signal.aborted) abort();
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.#abort.signal.removeEventListener("abort", abort);
    }
  }
  async #connect() {
    this.#abort.signal.throwIfAborted();
    await this.#wait(this.#socket.start());
    this.#abort.signal.throwIfAborted();
    if (!this.#ready) throw new Error("Slack disconnected during connection setup.");
  }
  isReady() { return this.#ready && !this.#stopped; }
  #client(signal: AbortSignal) {
    return new WebClient(this.config.botToken, {retryConfig: {retries: 0}, rejectRateLimitedCalls: true,
      timeout: 10_000, logger: this.logger, requestInterceptor: args => ({...args, signal})});
  }
  #api<T>(operation: (web: WebClient) => Promise<T>, kind: "read" | "mutation", requestSignal?: AbortSignal) {
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.#abort.signal]) : this.#abort.signal;
    return retryNetwork(inner => operation(this.#client(inner)), {signal, kind, clock: this.clock});
  }
  async stop() {
    this.#stopped = true;
    this.#ready = false;
    this.#abort.abort();
    if (this.#reconnect) { clearTimeout(this.#reconnect); this.#reconnect = undefined; }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.#socket.disconnect().catch(() => {}), new Promise<void>(resolve => {timer = setTimeout(resolve, 2000);})]);
    } finally {
      if (timer) clearTimeout(timer);
      // A second public disconnect force-closes a ws close handshake still awaiting its peer.
      this.#socket.websocket?.disconnect();
    }
  }
  #check() { if (!this.isReady()) throw new Error("Slack is off or reconnecting."); }
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
    return retryNetwork(inner => sourceFile(id => this.#client(inner).files.info({file: id}),
      async (url, downloadSignal) => {
        const response = await fetch(url, {headers: {Authorization: `Bearer ${this.config.botToken}`}, redirect: "error", signal: downloadSignal}).catch(error => {throw downloadSignal.aborted ? downloadSignal.reason : fetchError(error);});
        if (!response.ok) {await response.body?.cancel();throw responseError(response);}
        return response;
      }, route, fileId, inner, () => this.#check()), {signal, kind: "read", timeoutMs: 30_000, clock: this.clock});
  }
}
