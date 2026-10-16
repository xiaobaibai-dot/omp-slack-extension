export interface NetworkClock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}
export const networkClock: NetworkClock = {now: () => Date.now(), random: () => Math.random(),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer)};
export type NetworkCode = "network_timeout" | "network_retry_exhausted" | "network_outcome_uncertain" | "network_failed";
export function networkError(code: NetworkCode, original?: unknown) {
  const message = code === "network_outcome_uncertain" ? "Slack delivery outcome is uncertain; stop and verify before resending." : `Slack network request failed (${code}).`;
  const e = record(original), status = e.statusCode ?? e.status ?? e.response?.status;
  const rawCode = e.original?.code ?? e.cause?.code ?? e.data?.error ?? e.code;
  const allowed = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ECONNABORTED", "network_timeout", "missing_scope", "invalid_auth", "internal_error", "fatal_error", "service_unavailable", "request_timeout", "slack_webapi_request_error", "ERR_BAD_RESPONSE"]);
  const diagnostic = {category: code, ...(Number.isInteger(status) && status >= 100 && status <= 599 ? {httpStatus: status as number} : {}), ...(allowed.has(rawCode) ? {code: rawCode as string} : {})};
  return Object.assign(new Error(message), {code, diagnostic});
}
function record(value: unknown): Record<string, any> {return value && typeof value === "object" ? value as Record<string, any> : {};}
// These outcomes explicitly reject the submitted operation. Unknown transport
// errors and server failures cannot prove that a mutation did not commit.
const rejectedPlatformErrors = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired",
  "missing_scope", "not_allowed_token_type", "no_permission", "access_denied", "restricted_action", "channel_not_found",
  "not_in_channel", "is_archived", "invalid_arguments", "invalid_arg_name", "invalid_array_arg", "invalid_charset",
  "invalid_form_data", "invalid_post_type", "invalid_json", "json_not_object", "invalid_payload", "missing_required_field",
  "msg_too_long", "no_text", "file_not_found", "file_too_large"]);
function mutationRejected(error: unknown): boolean {
  const e = record(error);
  // A request error can contain an incomplete or malformed response. Its nested
  // code is not an authoritative rejection, including ERR_BAD_RESPONSE/no code.
  if (e.code === "slack_webapi_request_error") return false;
  const status = e.statusCode ?? e.status ?? e.response?.status;
  if (e.code === "slack_webapi_rate_limited_error" || status === 429) return true;
  if ([400, 401, 403, 404, 405, 413, 414, 415, 422].includes(status)) return true;
  return e.code === "slack_webapi_platform_error" && rejectedPlatformErrors.has(e.data?.error);
}
function retryHint(error: unknown, now: number) {
  const e = record(error), status = e.statusCode ?? e.status ?? e.response?.status;
  const rateLimited = e.code === "slack_webapi_rate_limited_error" || status === 429;
  const header = e.retryAfter ?? e.headers?.["retry-after"] ?? e.response?.headers?.["retry-after"];
  let after: number | undefined;
  if (typeof header === "number" || (typeof header === "string" && /^\d+(?:\.\d+)?$/.test(header))) after = Number(header) * 1000;
  else if (typeof header === "string" && Number.isFinite(Date.parse(header))) after = Math.max(0, Date.parse(header) - now);
  if (after !== undefined && (!Number.isFinite(after) || after < 0)) after = undefined;
  const code = e.original?.code ?? e.cause?.code ?? e.code;
  const transient = status === 408 || [500, 502, 503, 504].includes(status) ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ECONNABORTED", "network_timeout"].includes(code) ||
    e.name === "TimeoutError" || e.code === "fetch_network_error" ||
    (e.code === "slack_webapi_platform_error" && ["internal_error", "fatal_error", "service_unavailable", "request_timeout"].includes(e.data?.error));
  return {rateLimited, after, transient};
}
export function responseError(response: Response) {
  return Object.assign(new Error("Slack returned an unsuccessful HTTP response."), {statusCode: response.status,
    headers: {"retry-after": response.headers.get("retry-after")}});
}
/** Only use at the validated fetch boundary, not for arbitrary TypeErrors. */
export function fetchError(error: unknown) {
  return record(error).name === "TypeError" ? Object.assign(new Error("Slack file network connection failed."), {code: "fetch_network_error"}) : error;
}
function wait(ms: number, signal: AbortSignal, clock: NetworkClock): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {clock.clearTimeout(timer);signal.removeEventListener("abort", abort);reject(signal.reason);};
    const timer = clock.setTimeout(() => {signal.removeEventListener("abort", abort);resolve();}, ms);
    signal.addEventListener("abort", abort, {once: true});if (signal.aborted) abort();
  });
}
async function attempt<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number, clock: NetworkClock): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined, abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => {controller.abort(signal.reason);reject(signal.reason);};
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) {abort();return;}
      timer = clock.setTimeout(() => {const error = networkError("network_timeout");controller.abort(error);reject(error);}, timeoutMs);
      // Catch late settlements as well: cancelling never admits a new attempt.
      Promise.resolve().then(() => {controller.signal.throwIfAborted();return operation(controller.signal);}).then(resolve, reject);
    });
  } finally {if (timer) clock.clearTimeout(timer);signal.removeEventListener("abort", abort);}
}
/** Own the only HTTP retry layer. The Slack SDK must use retries:0 and rejectRateLimitedCalls:true. */
export async function retryNetwork<T>(operation: (signal: AbortSignal) => Promise<T>, options: {
  signal: AbortSignal; kind: "read" | "mutation"; timeoutMs?: number; clock?: NetworkClock;
}): Promise<T> {
  const {signal, kind} = options, clock = options.clock ?? networkClock, start = clock.now();
  // At most four attempts and two minutes, including server-directed waits.
  for (let index = 0; index < 4; index++) {
    signal.throwIfAborted();
    const remaining = 120_000 - (clock.now() - start);
    if (remaining <= 0) throw networkError("network_retry_exhausted");
    try {return await attempt(operation, signal, Math.min(options.timeoutMs ?? 10_000, remaining), clock);}
    catch (error) {
      if (signal.aborted) {
        // A cancelled write may already have committed. Never send it again.
        if (kind === "mutation") throw networkError("network_outcome_uncertain", error);
        throw signal.reason;
      }
      const hint = retryHint(error, clock.now());
      // Certainty of mutation failure is independent of the read retry allowlist.
      // Any unproven outcome stops subsequent explicit and automatic delivery.
      if (kind === "mutation" && !mutationRejected(error)) throw networkError("network_outcome_uncertain", error);
      if (!hint.transient && !(hint.rateLimited && hint.after !== undefined)) throw networkError("network_failed", error);
      if (index === 3) throw networkError("network_retry_exhausted");
      const backoff = Math.min(8000, 500 * 2 ** index) * (0.5 + clock.random() * 0.5);
      const delay = hint.rateLimited ? Math.max(backoff, hint.after!) + clock.random() * 250 : backoff;
      if (clock.now() - start + delay >= 120_000) throw networkError("network_retry_exhausted");
      await wait(delay, signal, clock);
    }
  }
  throw networkError("network_retry_exhausted");
}
