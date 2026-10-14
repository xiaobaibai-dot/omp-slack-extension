import { parseEvent, readUpload, safeError } from "./security.ts";
import type { Capabilities, Config, Host, Job, Transport } from "./types.ts";
export interface HistoryTurn { request: string; reply: string }
export interface RunInput { job: Job; history: readonly HistoryTurn[] }
export type IsolatedRunner = (input: RunInput, capabilities: Capabilities, signal: AbortSignal) => Promise<string>;
export type State = "off" | "starting" | "on";
export function routeKey(job: Job): string {
  return [job.route.team, job.route.channel, job.route.channel.startsWith("D") ? job.route.user : job.route.thread].join(":");
}
export class SlackBridge {
  #state: State = "off";
  #generation = 0;
  #transport?: Transport;
  #botUserId = "";
  #queue: Job[] = [];
  #dedupe = new Map<string, number>();
  #history = new Map<string, HistoryTurn[]>();
  #active?: { job: Job; controller: AbortController };
  #startedAt = 0;
  readonly config: Config;
  readonly host: Host;
  readonly makeTransport: () => Transport;
  readonly run: IsolatedRunner;
  constructor(config: Config, host: Host, makeTransport: () => Transport, run: IsolatedRunner) {
    this.config = config; this.host = host; this.makeTransport = makeTransport; this.run = run;
  }
  get state(): State { return this.#state; }
  status() { return {state: this.#state, queued: this.#queue.length, busy: Boolean(this.#active), historyRoutes: this.#history.size}; }
  async start(): Promise<void> {
    if (this.#state !== "off") return;
    if (!this.config.owners.size) throw new Error("Default deny: owner allowlist is empty.");
    this.#state = "starting";
    const generation = ++this.#generation;
    const transport = this.makeTransport();
    this.#transport = transport;
    this.#startedAt = Date.now();
    try {
      const identity = await transport.start(body => this.accept(body, generation));
      if (generation !== this.#generation || this.#state !== "starting") { await transport.stop(); return; }
      if (identity.teamId !== this.config.teamId || !identity.botUserId) throw new Error("Slack bot workspace does not match configured workspace.");
      this.#botUserId = identity.botUserId;
      this.#state = "on";
      this.host.notify("Slack is on. Only allowlisted owners can request work; replies stay in their source thread.");
    } catch (error) {
      if (generation === this.#generation) { this.#state = "off"; this.#transport = undefined; }
      await transport.stop().catch(() => {});
      throw error;
    }
  }
  async stop(): Promise<void> {
    // Close admission and invalidate every capability BEFORE any await.
    this.#state = "off";
    ++this.#generation;
    this.#queue = [];
    this.#history.clear();
    this.#active?.controller.abort();
    const transport = this.#transport;
    this.#transport = undefined;
    await transport?.stop();
  }
  accept(body: unknown, generation = this.#generation): void {
    if (this.#state !== "on" || generation !== this.#generation) return;
    const job = parseEvent(body, this.config, this.#botUserId);
    if (!job) return;
    // Do not replay old events on a new enable/start. Brief clock skew allowance.
    if (Number(job.ts) * 1000 < this.#startedAt - 30_000) return;
    const now = Date.now();
    for (const [id, seenAt] of this.#dedupe) if (now - seenAt > 10 * 60_000) this.#dedupe.delete(id);
    const key = `${job.route.team}:${job.id}`;
    if (this.#dedupe.has(key)) return;
    this.#dedupe.set(key, now);
    while (this.#dedupe.size > 2048) this.#dedupe.delete(this.#dedupe.keys().next().value!);
    if (this.#queue.length >= this.config.maxQueue) {
      this.host.notify("Slack queue is full; a new request was dropped. Ask the owner to resend later.", "warning");
      return;
    }
    this.#queue.push(job);
    void this.tick();
  }
  async tick(): Promise<void> {
    if (this.#state !== "on" || this.#active || !this.#queue.length || !this.host.canRun()) return;
    const transport = this.#transport;
    if (!transport) return;
    const job = this.#queue.shift()!;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#active = {job, controller};
    const deadline = setTimeout(() => controller.abort(), this.config.maxTaskMs);
    deadline.unref?.();
    let replies = 0;
    let lastReply = "";
    let reads = 0;
    let uploads = 0;
    const guard = () => {
      controller.signal.throwIfAborted();
      if (this.#state !== "on" || this.#generation !== generation || this.#active?.job !== job) throw new Error("Slack request is no longer active.");
      if (!this.config.owners.has(job.route.user)) throw new Error("Request owner is no longer authorized.");
    };
    const capabilities: Capabilities = {
      reply: async text => {
        guard();
        if (!text.trim() || text.length > 6000 || replies >= 3) throw new Error("Reply bound exceeded (3 replies, 6000 characters each).");
        ++replies;
        await transport.post(job.route, text);
        guard();
        lastReply = text.trim();
      },
      readThread: async cursor => {
        guard();
        if (++reads > 3) throw new Error("Thread read limit exceeded (3 pages per request).");
        if (cursor && cursor.length > 512) throw new Error("Invalid thread cursor.");
        const page = await transport.readThread(job.route, cursor);
        guard();
        return page;
      },
      upload: async (relativePath, title) => {
        guard();
        if (++uploads > 3) throw new Error("Upload limit exceeded (3 files per request).");
        const file = await readUpload(this.config.uploadRoot, relativePath);
        guard();
        await transport.upload(job.route, file.bytes, file.filename, (title ?? file.filename).slice(0, 200), controller.signal);
        guard();
      },
      // A remote model may only discover its own authorized conversation.
      listConversations: async () => {
        guard();
        return {conversations: [{id: job.route.channel, name: "current source conversation", isIm: job.route.channel.startsWith("D")}], scope: "Current request only. Use /slack channels in the local terminal to list all bot-accessible conversations."};
      },
    };
    const key = routeKey(job);
    const history = structuredClone(this.#history.get(key) ?? []);
    try {
      guard();
      const rawReply = (await this.run({job, history}, capabilities, controller.signal)).trim();
      const reply = rawReply.length > 6000 ? rawReply.slice(0, 5890) + "\n[Truncated at 6000 characters. Ask for a shorter answer or an explicitly requested output file.]" : rawReply;
      guard();
      if (reply && reply.slice(0, 6000) !== lastReply) {
        await transport.post(job.route, reply.slice(0, 6000));
      }
      guard();
      if (reply) {
        const turns = [...history, {request: job.text.slice(0, 6000), reply: reply.slice(0, 6000)}].slice(-6);
        while (JSON.stringify(turns).length > 32_000) turns.shift();
        this.#history.delete(key);
        this.#history.set(key, turns);
        while (this.#history.size > 32) this.#history.delete(this.#history.keys().next().value!);
      }
    } catch (error) {
      // No raw errors or partial model text sent to Slack. No automatic retry of uncertain writes.
      if (this.#state === "on" && generation === this.#generation) {
        this.host.notify(`Slack request ${job.id} failed or was cancelled (${safeError(error)}). No automatic retry.`, "warning");
      }
    } finally {
      clearTimeout(deadline);
      if (this.#active?.job === job) this.#active = undefined;
      // Tick from the host timer instead of recursive dispatch inside an event callback.
    }
  }
  async listConversations(cursor?: string) {
    if (this.#state !== "on" || !this.#transport) throw new Error("Run /slack first.");
    if (cursor && cursor.length > 512) throw new Error("Invalid cursor.");
    const generation = this.#generation;
    const page = await this.#transport.list(cursor);
    if (generation !== this.#generation || this.#state !== "on") throw new Error("Slack has been turned off.");
    return page;
  }
}
