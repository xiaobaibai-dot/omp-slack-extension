import {randomUUID} from "node:crypto";
import type {AgentSession} from "@oh-my-pi/pi-coding-agent";
import type {RunInput} from "./bridge.ts";
import type {Capabilities, NativeStatus, Route} from "./types.ts";
import {abortReason, requestError} from "./request-lifecycle.ts";

type HostSession = Pick<AgentSession, "prompt" | "subscribe" | "removeQueuedMessage" | "getQueuedMessages" | "messages" | "isStreaming">;
export interface HostActivity {event: string; observedAt: string; activeToolCalls: number}
const activityEvents = new Set(["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_stream_update", "tool_execution_end"]);
function isUserInput(message: any): boolean {
  return message?.role === "user" || ((message?.role === "custom" || message?.role === "developer") &&
    (message.attribution === "user" || message.userInitiated === true));
}
function textOf(message: any): string | undefined {
  return typeof message?.content === "string" ? message.content : message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}
function answerOf(message: any): string | undefined {
  if (message?.role !== "assistant" || message.stopReason !== "stop" || message.stopDetails?.type === "pause_turn" ||
    message.content?.some((part: any) => part.type === "toolCall")) return;
  return textOf(message)?.trim() || undefined;
}
function sameRoute(a: Route, b: Route) {return a.team === b.team && a.channel === b.channel && a.thread === b.thread && a.user === b.user;}
interface Request {
  id: string; input: RunInput; prompt: string; header: string; capabilities: Capabilities; signal: AbortSignal;
  admitted: boolean; consumed: boolean; explicitReply: boolean; settled: boolean;
  admission: PromiseWithResolvers<void>; result: PromiseWithResolvers<string>; cancel: () => void;
}

/** One observer per bound session. OMP, not this class, owns execution and its queues. */
export class NativeSession {
  readonly session: HostSession;
  readonly isCurrent: () => boolean;
  #records = new Map<string, Request>();
  #consumed = new Set<Request>();
  #tools = new Set<string>();
  #admissionTail: Promise<void> = Promise.resolve();
  #unsubscribe: () => void;
  #disposed = false;
  #mixed = false;
  #localActive: boolean;
  #boundary = false;
  #candidate?: string;
  #liveSteered = 0;
  #activity?: HostActivity;
  constructor(session: HostSession, isCurrent: () => boolean, onActivity?: (activity: HostActivity) => void) {
    this.session = session;this.isCurrent = isCurrent;this.#localActive = session.isStreaming;
    this.#liveSteered = session.getQueuedMessages().liveSteered;
    this.#unsubscribe = session.subscribe((event: any) => {
      if (this.#disposed) return;
      if (!this.isCurrent()) {this.dispose();return;}
      if (activityEvents.has(event.type)) {
        if (event.type === "tool_execution_start") this.#tools.add(event.toolCallId);
        if (event.type === "tool_execution_end") this.#tools.delete(event.toolCallId);
        if (event.type === "agent_end" && event.isTerminal === true) this.#tools.clear();
        this.#activity = {event: event.type, observedAt: new Date().toISOString(), activeToolCalls: this.#tools.size};
        try {onActivity?.(this.#activity);} catch {}
      }
      this.#observe(event);
    });
  }
  get localTurn(): boolean {
    const lastInput = [...this.session.messages].reverse().find(isUserInput);
    return this.#consumed.size === 0 && !textOf(lastInput)?.startsWith("[OMP Slack request ");
  }
  snapshot(route?: Route): NativeStatus {
    const queues = this.session.getQueuedMessages();
    const records = [...this.#records.values()].filter(record => !route || sameRoute(record.input.job.route, route));
    const pending = records.filter(record => record.admitted && !record.consumed);
    const followUp = pending.filter(record => queues.followUp.some(text => this.#owner(text) === record)).length;
    const editableSteering = queues.steering.slice(queues.liveSteered);
    const steering = pending.filter(record => editableSteering.some(text => this.#owner(text) === record)).length;
    return {streaming: this.session.isStreaming, submitting: records.filter(record => !record.admitted).length,
      followUp, steering, consumed: records.filter(record => record.consumed).length,
      // Includes admitted preflight, claimed/live-steered, and removed-but-not-yet-settled input.
      // OMP places the claimed live-steered prefix before editable steering chips.
      claimed: pending.length - followUp - steering, activeToolCalls: this.#tools.size,
      ...(this.#activity ? {lastEvent: this.#activity.event, lastObservedAt: this.#activity.observedAt} : {})};
  }
  run(input: RunInput, capabilities: Capabilities, signal: AbortSignal): Promise<string> {
    if (this.#disposed || !this.isCurrent()) return Promise.reject(requestError("session_cancelled"));
    if (signal.aborted) return Promise.reject(requestError(abortReason(signal)));
    const id = input.requestId ?? randomUUID();
    if (this.#records.has(id)) return Promise.reject(new Error("Duplicate request identifier."));
    const prompt = `[OMP Slack request ${id}]\nExternal Slack input in the manually bound main session. Existing OMP tools and approvals apply. This request uses native ${input.job.delivery ?? "followUp"}. The request_id for origin-bound Slack tools is ${id}. Only reply to this request's source. When multiple Slack requests or local input share a turn, use slack_reply with the correct request_id; a mixed final answer is never broadcast. Upload/download files only when explicitly requested.\n` + JSON.stringify({eventId: input.job.id, route: input.job.route, request: input.job.text, files: input.job.files});
    const record: Request = {id, input, prompt, header: prompt.slice(0, prompt.lastIndexOf("\n") + 1), capabilities, signal, admitted: false, consumed: false,
      explicitReply: false, settled: false, admission: Promise.withResolvers<void>(), result: Promise.withResolvers<string>(), cancel: () => {}};
    // Attach now, before any admission callback can reject synchronously.
    void record.result.promise.catch(() => {});
    record.cancel = () => {this.#finish(record, undefined, requestError(abortReason(signal)));this.#withdraw(record);};
    this.#records.set(id, record);
    signal.addEventListener("abort", record.cancel, {once: true});
    // Serialize only admission, NOT execution. The next request is submitted as soon
    // as OMP has accepted this one, while its model/tools may still be running.
    this.#admissionTail = this.#admissionTail.then(async () => {
      if (record.settled || signal.aborted) return;
      if (this.#disposed || !this.isCurrent()) {this.#finish(record, undefined, requestError("session_cancelled"));return;}
      try {
        const dispatched = this.session.prompt(prompt, {
          streamingBehavior: input.job.delivery ?? "followUp", expandPromptTemplates: false,
          runCommands: false, throwOnDrop: true,
          onPromptAdmitted: () => {
            if (record.settled || signal.aborted || this.#disposed || !this.isCurrent()) {
              this.#withdraw(record);
              throw requestError(signal.aborted ? abortReason(signal) : "session_cancelled");
            }
            record.admitted = true;record.admission.resolve();
          },
        });
        void dispatched.then(() => {
          if (!record.admitted && !record.settled) this.#finish(record, undefined, new Error("OMP did not admit the Slack prompt."));
        }, error => this.#finish(record, undefined, error));
      } catch (error) {this.#finish(record, undefined, error);}
      await record.admission.promise;
    }).catch(error => this.#finish(record, undefined, error));
    if (signal.aborted) record.cancel();
    return record.result.promise;
  }
  /** Resolver is rechecked on every tool call; queued or retired IDs grant no access. */
  capabilities(requestId?: string): Capabilities {
    const select = () => {
      if (this.#disposed || !this.isCurrent()) throw new Error("Slack binding has ended.");
      const record = requestId ? this.#records.get(requestId) :
        this.#consumed.size === 1 && !this.#mixed && !this.#localActive && !this.#liveSteered ? [...this.#consumed][0] : undefined;
      if (!record || !record.consumed || record.settled || !this.#consumed.has(record)) throw new Error("Supply an active, consumed Slack request_id; no unambiguous source is active.");
      const lastInput = [...this.session.messages].reverse().find(isUserInput);
      const lastOwner = this.#owner(textOf(lastInput));
      if (!lastOwner || !this.#consumed.has(lastOwner)) throw new Error("Local input changed the Slack tool scope.");
      record.signal.throwIfAborted();return record;
    };
    const call = async <T>(action: (record: Request) => Promise<T>): Promise<T> => {
      const record = select();const result = await action(record);if (select() !== record) throw new Error("Slack reply owner changed.");return result;
    };
    // Calling the resolver without executing a method must not capture stale authority.
    select();
    return {
      reply: text => call(async record => {await record.capabilities.reply(text);record.explicitReply = true;}),
      readThread: cursor => call(record => record.capabilities.readThread(cursor)),
      upload: (file, title) => call(record => record.capabilities.upload(file, title)),
      download: (id, target) => call(record => {
        if (!record.capabilities.download) throw new Error("Slack downloads are unavailable.");
        return record.capabilities.download(id, target);
      }),
      listConversations: () => call(record => record.capabilities.listConversations()),
    };
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of [...this.#records.values()]) {
      this.#withdraw(record);this.#finish(record, undefined, requestError("session_cancelled"));
    }
    this.#unsubscribe();this.#tools.clear();
  }
  #owner(text: string | undefined): Request | undefined {
    // OMP can expand ^model mentions in the payload even with template expansion
    // disabled. Match only an active generated ID at the very beginning AND its
    // full immutable instruction header. Never search user JSON/body for markers.
    const id = text && /^\[OMP Slack request ([^\]\n]+)\]\n/.exec(text)?.[1];
    const record = id ? this.#records.get(id) : undefined;
    return record && text?.startsWith(record.header) ? record : undefined;
  }
  #withdraw(record: Request) {
    // Public queue editing only. A message may have been promoted in the TUI.
    // False means claimed/consumed/removed: NEVER escalate to a session-wide abort.
    this.session.removeQueuedMessage(record.prompt, "followUp");
    this.session.removeQueuedMessage(record.prompt, "steering");
  }
  #finish(record: Request, answer?: string, error?: unknown) {
    if (record.settled) return;
    // Cancellation of consumed work revokes its route, not the work itself.
    // Until the next clean boundary it remains an unattributed participant.
    if (error !== undefined && record.consumed) {this.#mixed = true;this.#localActive = true;}
    record.settled = true;record.admission.resolve();
    record.signal.removeEventListener("abort", record.cancel);
    this.#records.delete(record.id);this.#consumed.delete(record);
    if (error !== undefined) record.result.reject(error);else record.result.resolve(answer ?? "");
  }
  #finishGroup(error?: unknown) {
    const sole = this.#consumed.size === 1 && !this.#mixed && !this.#localActive && !this.#liveSteered;
    for (const record of [...this.#consumed]) {
      if (error !== undefined) this.#finish(record, undefined, error);
      else if (record.explicitReply) this.#finish(record, "");
      else if (sole && this.#candidate) this.#finish(record, this.#candidate);
      else this.#finish(record, undefined, requestError("reply_ambiguous", "No automatic reply: the native turn had mixed input or no attributable final answer."));
    }
    this.#mixed = false;this.#localActive = false;this.#candidate = undefined;this.#boundary = false;
  }
  #observe(event: any) {
    if (event.type === "queue_update") {
      this.#liveSteered = event.liveSteered ?? 0;
      if (this.#liveSteered) {this.#mixed = true;this.#candidate = undefined;}
      return;
    }
    if (event.type === "message_start" && isUserInput(event.message)) {
      const record = event.message.role === "user" ? this.#owner(textOf(event.message)) : undefined;
      if (this.#boundary && !event.message.liveSteered) this.#finishGroup();
      if (!record || record.settled || record.consumed) {
        // A local user message, including custom skill input, immediately revokes
        // old request tools. Its later output is never assigned to Slack.
        this.#finishGroup(requestError("session_cancelled", "Local input changed the reply owner."));
        this.#localActive = true;return;
      }
      if (this.#consumed.size || this.#localActive || event.message.liveSteered) this.#mixed = true;
      record.consumed = true;record.admitted = true;record.admission.resolve();this.#consumed.add(record);
      this.#boundary = false;this.#candidate = undefined;return;
    }
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.#candidate = undefined;this.#boundary = false;return;
    }
    if (event.type === "turn_end") {
      const lastInput = [...this.session.messages].reverse().find(isUserInput);
      const owner = this.#owner(textOf(lastInput));
      if (this.#consumed.size && (!owner || !this.#consumed.has(owner))) this.#mixed = true;
      this.#candidate = answerOf(event.message);
      this.#boundary = Boolean(this.#candidate);
      // Error/aborted turns can trigger OMP recovery. Keep their consumed owners
      // until a real terminal settle; a later steer must remain a mixed turn.
      return;
    }
    if (event.type !== "agent_end") return;
    if (event.isTerminal !== true) {
      // Maintenance/recovery may continue after a superficially successful turn.
      // A later source cannot inherit its continuation as a fresh clean turn.
      this.#candidate = undefined;this.#boundary = false;return;
    }
    const messages = event.messages ?? this.session.messages;
    const lastInputIndex = messages.findLastIndex(isUserInput);
    const lastInput = messages[lastInputIndex];
    const lastRecord = this.#owner(textOf(lastInput));
    // Never reuse an assistant response from before the consumed request.
    const lastAssistant = messages.slice(lastInputIndex + 1).findLast((message: any) => message?.role === "assistant");
    if (this.#consumed.size && (!lastRecord || !this.#consumed.has(lastRecord))) this.#mixed = true;
    this.#candidate = answerOf(lastAssistant);
    this.#liveSteered = this.session.getQueuedMessages().liveSteered;
    this.#finishGroup(lastAssistant?.stopReason === "aborted" ? requestError("user_cancelled") :
      lastAssistant?.stopReason === "error" ? new Error("OMP model failed.") : undefined);
    const queued = this.session.getQueuedMessages();
    for (const record of [...this.#records.values()]) {
      if (record.admitted && !queued.followUp.some(text => this.#owner(text) === record) && !queued.steering.some(text => this.#owner(text) === record))
        this.#finish(record, undefined, requestError("user_cancelled", "Native pending input was removed or not consumed."));
    }
  }
}
