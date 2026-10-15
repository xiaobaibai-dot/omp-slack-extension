export type CancellationReason = "task_timeout" | "user_cancelled" | "session_cancelled" | "binding_taken_over" | "transport_disconnected";
export type FailureReason = CancellationReason | import("./network.ts").NetworkCode | "operation_failed";
export type RequestReason = FailureReason | "completed";
const failures = new Set<string>(["task_timeout", "user_cancelled", "session_cancelled", "binding_taken_over", "transport_disconnected", "network_timeout", "network_retry_exhausted", "network_outcome_uncertain", "network_failed", "operation_failed"]);
function cancellationCode(error: unknown): FailureReason | undefined {
  const code = error && typeof error === "object" ? (error as {code?: unknown}).code : undefined;
  return typeof code === "string" && failures.has(code) ? code as FailureReason : undefined;
}
export function requestError(code: FailureReason, message = `Slack request was cancelled (${code}).`) {
  return Object.assign(new Error(message), {code});
}
export function abortReason(signal: AbortSignal): FailureReason {
  return cancellationCode(signal.reason) ?? "user_cancelled";
}
export function failureReason(error: unknown, signal?: AbortSignal): Exclude<RequestReason, "completed"> {
  if (signal?.aborted) return abortReason(signal);
  const known = cancellationCode(error);
  if (known) return known;
  if (error && typeof error === "object") {
    const {name, code} = error as {name?: unknown; code?: unknown};
    if (name === "AbortError" || code === "ABORT_ERR") return "user_cancelled";
  }
  return "operation_failed";
}
/** Fixed fields only: no request bodies, replies, errors, configuration or tokens. */
export interface RequestLog {
  phase: "start" | "end";
  eventId: string;
  requestId: string;
  teamId: string;
  channelId: string;
  threadId: string;
  messageTs: string;
  startedAt: string;
  endedAt?: string;
  reason: "started" | RequestReason;
}
