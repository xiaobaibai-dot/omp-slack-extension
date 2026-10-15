import { parseEvent, readUpload, readHostUpload, requesterAllowed, safeError } from "./security.ts";
import * as fs from "node:fs/promises";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {failureReason, requestError} from "./request-lifecycle.ts";
import type {CancellationReason, RequestLog, RequestReason} from "./request-lifecycle.ts";
import type { Capabilities, Config, Host, Job, Transport } from "./types.ts";
export interface HistoryTurn { request: string; reply: string }
export interface RunInput { job: Job; history: readonly HistoryTurn[]; requestId?: string }
export type IsolatedRunner = (input: RunInput, capabilities: Capabilities, signal: AbortSignal) => Promise<string>;
export type State = "off" | "starting" | "on";
export interface TaskClock {
  now(): number;
}
const taskClock: TaskClock = {now: () => Date.now()};
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
  #stopping?: Promise<void>;
  readonly config: Config;
  readonly host: Host;
  readonly makeTransport: () => Transport;
  readonly run: IsolatedRunner;
  readonly clock: TaskClock;
  constructor(config: Config, host: Host, makeTransport: () => Transport, run: IsolatedRunner, clock: TaskClock = taskClock) {
    this.config = config; this.host = host; this.makeTransport = makeTransport; this.run = run;
    this.clock = clock;
  }
  get state(): State { return this.#state; }
  status() { return {state: this.#state, queued: this.#queue.length, busy: Boolean(this.#active), historyRoutes: this.#history.size}; }
  async start(): Promise<void> {
    if (this.#state !== "off") return;
    if (this.#transport) throw new Error("Close the previous Slack connection before starting again.");
    if (!this.config.owners.size) throw new Error("Default deny: owner allowlist is empty.");
    this.#state = "starting";
    const generation = ++this.#generation;
    const transport = this.makeTransport();
    this.#transport = transport;
    this.#startedAt = Date.now();
    try {
      const identity = await transport.start(body => this.accept(body, generation), error => {
        if (generation !== this.#generation || this.#state === "off") return;
        void this.stop("transport_disconnected").catch(() => {});
        this.host.notify(`Slack disconnected (${safeError(error)}). Requests were cancelled; run /slack to reconnect.`, "warning");
      });
      if (generation !== this.#generation || this.#state !== "starting") { await this.stop(); return; }
      if (identity.teamId !== this.config.teamId || !identity.botUserId) throw new Error("Slack bot workspace does not match configured workspace.");
      this.#botUserId = identity.botUserId;
      this.#state = "on";
      this.host.notify("Slack is on; bound to this OMP main session. Approved channel members and DM owners can request work; replies stay in their source thread.");
    } catch (error) {
      if (generation === this.#generation) this.#state = "off";
      await this.stop().catch(() => {});
      throw error;
    }
  }
  stop(reason: CancellationReason = "user_cancelled"): Promise<void> {
    if (this.#stopping) return this.#stopping;
    // Close admission and invalidate every capability BEFORE any await.
    this.#state = "off";
    ++this.#generation;
    this.#queue = [];
    this.#history.clear();
    this.#active?.controller.abort(requestError(reason));
    const transport = this.#transport;
    const stopped = Promise.resolve().then(() => transport?.stop()).then(() => {
      if (this.#transport === transport) this.#transport = undefined;
    });
    const pending = stopped.finally(() => {if (this.#stopping === pending) this.#stopping = undefined;});
    this.#stopping = pending;
    return pending;
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
    if (transport.isReady?.() === false) return;
    const job = this.#queue.shift()!;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#active = {job, controller};
    const requestId = randomUUID();
    const startedAt = new Date(this.clock.now()).toISOString();
    let reason: RequestReason = "completed";
    const log = (phase: "start" | "end") => {
      const entry: RequestLog = {phase, eventId: job.id, requestId, teamId: job.route.team,
        channelId: job.route.channel, threadId: job.route.thread, messageTs: job.ts, startedAt,
        ...(phase === "end" ? {endedAt: new Date(this.clock.now()).toISOString()} : {}),
        reason: phase === "start" ? "started" : reason};
      try {
        if (this.host.log) this.host.log(entry);
        else this.host.notify(`Slack request log ${JSON.stringify(entry)}`, "info");
      } catch {this.host.notify("Slack request log could not be saved.", "warning");}
    };
    log("start");
    let replies = 0;
    let lastReply = "";
    let explicitlyReplied = false;
    let reads = 0;
    let uploads = 0;
    const guard = () => {
      controller.signal.throwIfAborted();
      if (this.#state !== "on" || this.#generation !== generation || this.#active?.job !== job) throw new Error("Slack request is no longer active.");
      if (!requesterAllowed(this.config, job.route.user, job.route.channel)) throw new Error("Request sender is no longer authorized.");
    };
    const capabilities: Capabilities = {
      reply: async text => {
        guard();
        if (!text.trim() || text.length > 6000 || replies >= 3) throw new Error("Reply bound exceeded (3 replies, 6000 characters each).");
        ++replies;
        try {await transport.post(job.route, text, controller.signal);}
        catch (error) {if (failureReason(error) === "network_outcome_uncertain") controller.abort(error);throw error;}
        explicitlyReplied = true;
        guard();
        lastReply = text.trim();
      },
      readThread: async cursor => {
        guard();
        if (++reads > 3) throw new Error("Thread read limit exceeded (3 pages per request).");
        if (cursor && cursor.length > 512) throw new Error("Invalid thread cursor.");
        const page = await transport.readThread(job.route, cursor, controller.signal);
        guard();
        return page;
      },
      upload: async (relativePath, title) => {
        guard();
        if (++uploads > 3) throw new Error("Upload limit exceeded (3 files per request).");
        const file = this.config.uploadMode === "host" ? await readHostUpload(this.config.cwd ?? process.cwd(), relativePath) : await readUpload(this.config.uploadRoot, relativePath);
        guard();
        let uploaded: void | {fileId: string};
        try {uploaded = await transport.upload(job.route, file.bytes, file.filename, (title ?? file.filename).slice(0, 200), controller.signal);}
        catch (error) {if (failureReason(error) === "network_outcome_uncertain") controller.abort(error);throw error;}
        guard();
        return uploaded;
      },
      // A remote model may only discover its own authorized conversation.
      download: async (fileId, targetPath) => {
        guard();
        if (!transport.download) throw new Error("Slack downloads are unavailable.");
        if (!targetPath || targetPath.includes("\0")) throw new Error("A local target path is required.");
        const file = await transport.download(job.route, fileId, controller.signal);
        guard();
        const destination = path.resolve(this.config.cwd ?? process.cwd(), targetPath);
        await fs.mkdir(path.dirname(destination), {recursive: true});
        guard();
        const handle = await fs.open(destination, "wx");
        try {guard(); await handle.writeFile(file.bytes, {signal: controller.signal}); guard();}
        catch (error) {await handle.close(); await fs.unlink(destination).catch(() => {}); throw error;}
        finally {await handle.close();}
        return {path: destination, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex")};
      },
      listConversations: async () => {
        guard();
        return {conversations: [{id: job.route.channel, name: "current source conversation", isIm: job.route.channel.startsWith("D")}], scope: "Current request only. Use /slack channels in the local terminal to list all bot-accessible conversations."};
      },
    };
    const key = routeKey(job);
    const history = structuredClone(this.#history.get(key) ?? []);
    try {
      guard();
      const rawReply = (await this.run({job, history, requestId}, capabilities, controller.signal)).trim();
      const reply = rawReply.length > 6000 ? rawReply.slice(0, 5890) + "\n[Truncated at 6000 characters. Ask for a shorter answer or an explicitly requested output file.]" : rawReply;
      guard();
      if (reply && !explicitlyReplied) {
        await transport.post(job.route, reply.slice(0, 6000), controller.signal);
      }
      guard();
      const deliveredReply = explicitlyReplied ? lastReply : reply;
      if (deliveredReply) {
        const turns = [...history, {request: job.text.slice(0, 6000), reply: deliveredReply.slice(0, 6000)}].slice(-6);
        while (JSON.stringify(turns).length > 32_000) turns.shift();
        this.#history.delete(key);
        this.#history.set(key, turns);
        while (this.#history.size > 32) this.#history.delete(this.#history.keys().next().value!);
      }
    } catch (error) {
      reason = failureReason(error, controller.signal);
      if (reason === "user_cancelled" || reason === "session_cancelled") controller.abort(requestError(reason));
      // No raw errors or partial model text sent to Slack. No automatic retry of uncertain writes.
      if (this.#state === "on" && generation === this.#generation) {
        this.host.notify(`Slack request ${job.id} failed or was cancelled (${reason}). No automatic retry.`, "warning");
      }
    } finally {
      log("end");
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
