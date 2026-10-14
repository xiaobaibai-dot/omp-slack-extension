import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { phasedUpload } from "./upload.ts";
import { plainText } from "./security.ts";
import type { Config, Route, Transport } from "./types.ts";
export class SlackTransport implements Transport {
  #socket: SocketModeClient;
  #web: WebClient;
  #stopped = false;
  #abort = new AbortController();
  #starting?: Promise<unknown>;
  readonly config: Config;
  constructor(config: Config) {
    this.config = config;
    // SDK retries are disabled for Web API mutations: uncertain sends must not duplicate.
    const options = {retryConfig: {retries: 0}, rejectRateLimitedCalls: true, timeout: 10_000, logLevel: LogLevel.ERROR};
    this.#web = new WebClient(config.botToken, options);
    this.#socket = new SocketModeClient({appToken: config.appToken, autoReconnectEnabled: true, logLevel: LogLevel.ERROR, clientOptions: options});
    // Avoid uncaught EventEmitter error events. Raw errors are not printed (may contain secrets).
    this.#socket.on("error", () => {});
  }
  async start(onEvent: (body: unknown) => void) {
    const auth = await this.#web.auth.test();
    if (!auth.ok || !auth.bot_id || !auth.team_id || !auth.user_id || auth.team_id !== this.config.teamId) throw new Error("Bot identity/workspace verification failed.");
    if (this.#stopped) throw new Error("Slack start was cancelled.");
    this.#socket.on("slack_event", (input: {ack: () => Promise<void>; type: string; body: unknown}) => {
      // ACK even ignored, unauthorized and duplicate payloads, before any LLM or file work.
      void input.ack().catch(() => {});
      if (!this.#stopped && input.type === "events_api") onEvent(input.body);
    });
    this.#starting = this.#socket.start();
    await this.#starting;
    if (this.#stopped) { await this.#socket.disconnect(); throw new Error("Slack start was cancelled."); }
    return {teamId: auth.team_id, botUserId: auth.user_id};
  }
  async stop() {
    this.#stopped = true;
    this.#abort.abort();
    await this.#socket.disconnect();
    // A start already in flight can connect after disconnect; start's continuation disconnects it again.
  }
  #check() { if (this.#stopped) throw new Error("Slack is off."); }
  async post(route: Route, text: string) {
    this.#check();
    await this.#web.chat.postMessage({channel: route.channel, thread_ts: route.thread,
      text: plainText(text), mrkdwn: false, parse: "none", link_names: false,
      reply_broadcast: false, unfurl_links: false, unfurl_media: false});
  }
  async readThread(route: Route, cursor?: string) {
    this.#check();
    const page = await this.#web.conversations.replies({channel: route.channel, ts: route.thread, cursor, limit: 15});
    this.#check();
    return {messages: (page.messages ?? []).slice(0, 15).map(m => ({user: m.user ?? m.bot_id ?? "unknown", ts: m.ts ?? "", text: (m.text ?? "").slice(0, 2000)})),
      nextCursor: page.response_metadata?.next_cursor || undefined,
      truncated: Boolean(page.has_more || page.response_metadata?.next_cursor || page.messages?.some(m => (m.text?.length ?? 0) > 2000))};
  }
  async upload(route: Route, content: Buffer, filename: string, title: string, requestSignal: AbortSignal) {
    const signal = AbortSignal.any([requestSignal, this.#abort.signal, AbortSignal.timeout(30_000)]);
    await phasedUpload({
      getURL: args => this.#web.files.getUploadURLExternal(args),
      complete: args => this.#web.files.completeUploadExternal(args),
    }, async (url, bytes, uploadSignal) => {
      const response = await fetch(url, {method: "POST", body: bytes as Uint8Array<ArrayBuffer>, redirect: "error", signal: uploadSignal, headers: {"Content-Type": "application/octet-stream"}});
      if (!response.ok) throw new Error("Slack binary upload failed.");
      await response.body?.cancel();
    }, route, content, filename, title, signal, () => this.#check());
  }
  async list(cursor?: string) {
    this.#check();
    const page = await this.#web.users.conversations({types: "public_channel,private_channel,im", exclude_archived: true, limit: 100, cursor});
    this.#check();
    return {conversations: (page.channels ?? []).slice(0, 100).filter(c => c.id).map(c => ({id: c.id!, name: c.name ?? c.id!, isPrivate: Boolean(c.is_private), isIm: Boolean(c.is_im)})), nextCursor: page.response_metadata?.next_cursor || undefined};
  }
}
