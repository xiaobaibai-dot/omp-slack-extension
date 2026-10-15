import { randomUUID } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { RunInput } from "./bridge.ts";
import { finalText } from "./sdk-runner.ts";
import {abortReason, failureReason, requestError} from "./request-lifecycle.ts";
type HostSession = Pick<AgentSession, "prompt" | "subscribe" | "waitForIdle" | "abort" | "removeQueuedMessage" | "getQueuedMessages" | "messages" | "isStreaming">;
const activityEvents = new Set(["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_stream_update", "tool_execution_end"]);
export interface HostActivity {event: string; observedAt: string; activeToolCalls: number}
function isUserInput(message: any): boolean {
  return message?.role === "user" || ((message?.role === "custom" || message?.role === "developer") &&
    (message.attribution === "user" || message.userInitiated === true));
}
function userText(messages: unknown[]): string | undefined {
  const message = [...messages].reverse().find(isUserInput) as any;
  if (!message) return;
  return typeof message.content === "string" ? message.content : message.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
}
async function waitForHostIdle(session: HostSession, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancel = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = () => reject(requestError(abortReason(signal)));
      signal.addEventListener("abort", cancel, {once: true});
      if (signal.aborted) {cancel();return;}
      // Observe late idle completion/rejection even after cancellation has won.
      Promise.resolve().then(() => {signal.throwIfAborted();return session.waitForIdle();}).then(resolve, reject);
    });
  } finally {signal.removeEventListener("abort", cancel);}
}
export async function runShared(session: HostSession, input: RunInput, signal: AbortSignal, setOwned: (owned: boolean) => void = () => {}, onActivity?: (activity: HostActivity) => void): Promise<string> {
  signal.throwIfAborted();
  const prompt = `[OMP Slack request ${input.requestId ?? randomUUID()}]\nThis is an external Slack request in the manually bound main session. Existing OMP tools and approval rules apply. Respond to this request in its original source. The bridge automatically sends your final answer unless you already replied using slack_reply; after an explicit reply, your final explanation stays in OMP. Upload files only when this request explicitly asks.\n` + JSON.stringify({eventId: input.job.id, route: input.job.route, request: input.job.text, files: input.job.files});
  const result = Promise.withResolvers<string>();
  // A cancellation may reject before the dispatch await returns.
  void result.promise.catch(() => {});
  let started = false;
  let tainted = false;
  let ownsSetup = false;
  let terminalFinished = false;
  const tools = new Set<string>();
  const unsubscribe = session.subscribe((event: any) => {
    if (activityEvents.has(event.type)) {
      if (event.type === "tool_execution_start") tools.add(event.toolCallId);
      if (event.type === "tool_execution_end") tools.delete(event.toolCallId);
      if (event.type === "agent_end" && event.isTerminal === true) tools.clear();
      // Event names/counts only; never copy thinking, tool arguments or results.
      try {onActivity?.({event: event.type, observedAt: new Date().toISOString(), activeToolCalls: tools.size});} catch {}
    }
    if (event.type === "message_start" && isUserInput(event.message)) {
      ownsSetup = false;
      if (event.message.role === "user" && userText([event.message]) === prompt) {
        started = true; setOwned(!tainted && !signal.aborted);
      } else if (started) {tainted = true; setOwned(false);}
    }
    if (event.type !== "agent_end" || event.isTerminal !== true || !started) return;
    if (tainted || userText(event.messages ?? []) !== prompt) {
      result.reject(requestError("session_cancelled", "Slack turn was mixed with other terminal input; no reply was forwarded.")); return;
    }
    if (signal.aborted) {result.reject(requestError(abortReason(signal)));return;}
    const lastAssistant = [...(event.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") {result.reject(requestError("user_cancelled"));return;}
    const answer = finalText(event);
    if (answer) {terminalFinished = true;ownsSetup = false;setOwned(false);result.resolve(answer);}
    else result.reject(new Error("No successful terminal Slack reply."));
  });
  const abort = () => {
    // Withdraw only our own race-queued follow-up; never clear the terminal's other inputs.
    const removed = session.removeQueuedMessage(prompt, "followUp");
    const ownsTurn = !terminalFinished && started && !tainted && userText(session.messages) === prompt;
    if (!removed && (ownsSetup || ownsTurn) && session.isStreaming) void session.abort().catch(() => {});
    setOwned(false);
    result.reject(requestError(abortReason(signal)));
  };
  signal.addEventListener("abort", abort, {once: true});
  try {
    // Rechecks inside prompt use followUp if local input starts after the bridge's idle check.
    void session.prompt(prompt, {
      streamingBehavior: "followUp", expandPromptTemplates: false, throwOnDrop: true,
      onPromptAdmitted: () => {
        // SDK 18.10.4 calls this after a queue push, or before an idle turn's preflight.
        // It still runs if cancellation ended runShared during earlier preprocessing.
        ownsSetup = !session.getQueuedMessages().followUp.includes(prompt);
        if (signal.aborted) {
          ownsSetup = false;
          session.removeQueuedMessage(prompt, "followUp");
          throw requestError(abortReason(signal));
        }
      },
    }).catch(error => {
      const reason = failureReason(error, signal);
      result.reject(reason === "operation_failed" ? error : requestError(reason));
    });
    if (signal.aborted) abort();
    const answer = await result.promise;
    await waitForHostIdle(session, signal);
    signal.throwIfAborted();
    if (tainted || userText(session.messages) !== prompt) throw requestError("session_cancelled", "Terminal ownership changed; no reply was forwarded.");
    return answer;
  } finally {
    signal.removeEventListener("abort", abort); unsubscribe(); setOwned(false);
    // The bound main session belongs to the user: it is never disposed here.
  }
}
