import { parseEvent, readUpload, readHostUpload, requesterAllowed, safeError } from "./security.ts";
import * as fs from "node:fs/promises";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {failureReason, requestError} from "./request-lifecycle.ts";
import type {ProviderNotice} from "./provider-notices.ts";
import type {CancellationReason, RequestLog, RequestReason} from "./request-lifecycle.ts";
import {messageMode} from "./message-mode.ts";
import type { Capabilities, Config, Host, Job, Route, Transport } from "./types.ts";
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
  // These are request records, not an execution queue. OMP owns all scheduling.
  #requests = new Map<string, {job: Job; controller: AbortController}>();
  #controls = new Set<AbortController>();
  readonly #dedupe: Map<string, number>;
  #history = new Map<string, HistoryTurn[]>();
  #startedAt = 0;
  #stopping?: Promise<void>;
  readonly config: Config;
  readonly host: Host;
  readonly makeTransport: () => Transport;
  readonly run: IsolatedRunner;
  readonly clock: TaskClock;
  constructor(config: Config, host: Host, makeTransport: () => Transport, run: IsolatedRunner, clock: TaskClock = taskClock, eventDedupe = new Map<string, number>()) {
    this.config = config; this.host = host; this.makeTransport = makeTransport; this.run = run;
    this.clock = clock;
    this.#dedupe = eventDedupe;
  }
  get state(): State { return this.#state; }
  status() {
    const native = this.host.status?.();
    return {state: this.#state, pending: this.#requests.size, busy: this.#requests.size > 0, historyRoutes: this.#history.size, connection: this.#transport?.connectionStatus?.(), native};
  }
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
        this.host.notify(`Slack disconnected (${safeError(error)}). Reply routes were revoked; already admitted native work may continue. Run /slack to reconnect.`, "warning");
      }, status => {
        if (generation !== this.#generation || this.#state === "off") return;
        // Transport status only. Temporary outages preserve native work and reply ownership.
        if (status.state === "reconnecting" && status.failures === 1) this.host.notify("Slack connection interrupted; reconnecting automatically. Native work continues.", "warning");
        if (status.state === "connected" && status.failures > 0) this.host.notify("Slack receiving connection restored. Tasks and uncertain deliveries were not replayed.");
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
    for (const request of this.#requests.values()) request.controller.abort(requestError(reason));
    this.#requests.clear();
    for (const controller of this.#controls) controller.abort(requestError(reason));
    this.#controls.clear();
    this.#history.clear();
    const transport = this.#transport;
    const stopped = Promise.resolve().then(() => transport?.stop()).then(() => {
      if (this.#transport === transport) this.#transport = undefined;
      return this.host.onStopped?.();
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
    const mode = messageMode(job);
    if (mode.kind !== "request") {void this.#control(job, mode.kind, generation);return;}
    if (this.#requests.size >= this.config.maxQueue) {
      this.host.notify("Slack outstanding-request bound reached; a new request was not submitted to OMP.", "warning");
      return;
    }
    const transport = this.#transport;
    if (!transport || transport.isReady?.() === false) {
      this.host.notify("Slack is reconnecting; request was not submitted. No automatic retry.", "warning");return;
    }
    const requestId = randomUUID(), controller = new AbortController();
    this.#requests.set(requestId, {job: mode.job, controller});
    void this.#dispatch(mode.job, requestId, controller, transport, generation);
  }
  async #control(job: Job, kind: "status" | "usage", generation: number): Promise<void> {
    // A bounded transport-only lane, never a model prompt or a work queue.
    const transport = this.#transport;
    if (!transport || transport.isReady?.() === false || this.#controls.size >= 4) return;
    const controller = new AbortController();this.#controls.add(controller);
    try {
      if (this.#state !== "on" || generation !== this.#generation) return;
      const status = this.host.status?.(job.route);
      const text = kind === "usage" ? "Use !insert TEXT / !steer TEXT, !queue TEXT, or !status. Ordinary messages use OMP follow-up." :
        JSON.stringify({state: this.#state, scope: "your source thread only", defaultDelivery: "followUp", connection: transport.connectionStatus?.(), native: status ?? null});
      await transport.post(job.route, text, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.host.notify(`Slack control reply failed (${safeError(error)}). No automatic retry.`, "warning");
    } finally {this.#controls.delete(controller);}
  }
  async #dispatch(job: Job, requestId: string, controller: AbortController, transport: Transport, generation: number): Promise<void> {
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
      if (this.#state !== "on" || this.#generation !== generation || this.#requests.get(requestId)?.job !== job) throw new Error("Slack request is no longer active.");
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
      if (this.#requests.get(requestId)?.job === job) this.#requests.delete(requestId);
    }
  }
  async providerNotice(route: Route, notice: ProviderNotice): Promise<boolean> {
    // Internal system notification only; never an agent tool, prompt or task retry.
    const transport = this.#transport, generation = this.#generation;
    if (this.#state !== "on" || !transport ||
      route.team !== this.config.teamId || !requesterAllowed(this.config, route.user, route.channel) || this.#controls.size >= 128) return false;
    const controller = new AbortController();this.#controls.add(controller);
    try {
      if (generation !== this.#generation || this.#state !== "on") return false;
      await transport.post(route, notice.text, controller.signal);
      return generation === this.#generation && this.#state === "on" && !controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted) this.host.notify(`Slack model notice could not be confirmed (${safeError(error)}). No automatic resend.`, "warning");
      return false;
    } finally {this.#controls.delete(controller);}
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
