import type {NetworkClock} from "./network.ts";
export type ConnectionState = "starting" | "connected" | "reconnecting" | "stopped";
export interface ConnectionStatus {state: ConnectionState; failures: number; nextAttemptAt?: string; reason?: string}
type Failure = {kind: "retry" | "fatal" | "unknown"; reason: string; retryAfterMs?: number};
const httpStatus = (e: Record<string, any>): number | undefined => {const n = e.statusCode ?? e.status ?? e.response?.status;return typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;};
const object = (value: any): Record<string, any> => value && typeof value === "object" ? value : {};
const auth = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type"]);
const fatal = new Set([...auth, "missing_scope", "no_permission", "access_denied", "team_access_not_granted", "forbidden_team", "invalid_arguments", "missing_args", "link_disabled"]);
export function credentialFailure(error: unknown): boolean {
  const e = object(error), status = httpStatus(e);
  return status === 401 || status === 403 || (e.code === "slack_webapi_platform_error" && auth.has(e.data?.error));
}
/** Reconnection is not a message mutation: opening a replacement socket cannot resend a task/reply. */
export function connectionFailure(error: unknown, now: number): Failure {
  const e = object(error), status = httpStatus(e);
  const platform = e.code === "slack_webapi_platform_error" ? e.data?.error : undefined;
  if (credentialFailure(error) || fatal.has(platform) || e.code === "socket_link_disabled") return {kind: "fatal", reason: fatal.has(platform) ? platform : e.code === "socket_link_disabled" ? "link_disabled" : "authentication_rejected"};
  if (e.code === "slack_webapi_rate_limited_error" || status === 429 || platform === "ratelimited") {
    const raw = e.retryAfter ?? e.headers?.["retry-after"] ?? e.response?.headers?.["retry-after"];
    let ms: number | undefined;
    if (typeof raw === "number" || (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw))) ms = Number(raw) * 1000;
    else if (typeof raw === "string" && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) ms = Math.max(0, Date.parse(raw) - now);
    // Never clamp a server wait downwards. An unusably large/invalid hint needs operator inspection.
    if (ms !== undefined && (!Number.isFinite(ms) || ms < 0 || ms > 8_640_000_000_000_000 - 1000 - now)) return {kind: "fatal", reason: "invalid_retry_after"};
    return {kind: "retry", reason: "rate_limited", retryAfterMs: ms ?? 60_000};
  }
  const code = e.original?.code ?? e.cause?.code ?? e.code;
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return {kind: "fatal", reason: "tls_validation_failed"};
  if (status === 408 || (typeof status === "number" && status >= 500 && status <= 599) ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ECONNABORTED", "socket_closed", "socket_connect_timeout"].includes(code) ||
    ["internal_error", "fatal_error", "service_unavailable"].includes(platform)) return {kind: "retry", reason: status ? `http_${status}` : platform ?? (code === "socket_closed" || code === "socket_connect_timeout" ? code : "network_error")};
  if (typeof status === "number" && status >= 400 && status < 500) return {kind: "fatal", reason: `http_${status}`};
  // RequestError alone also covers malformed responses. Do not label it invalid credentials or retry forever.
  return {kind: "unknown", reason: "unclassified_connection_error"};
}
export function reconnectDelay(failures: number, retryAfterMs: number | undefined, clock: NetworkClock): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(16, Math.max(0, failures)));
  return Math.max(base * (0.5 + clock.random() * 0.5), retryAfterMs ?? 0) + (retryAfterMs === undefined ? 0 : clock.random() * 250);
}
export function connectionError(code: string): Error {return Object.assign(new Error(`Slack connection failed (${code}).`), {code});}
export async function connectionWait(ms: number, signal: AbortSignal, clock: NetworkClock): Promise<void> {
  const end = clock.now() + ms;
  // Node timers overflow above 2^31-1. Chunk long Retry-After without retrying early.
  while (clock.now() < end) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const abort = () => {clock.clearTimeout(timer);signal.removeEventListener("abort", abort);reject(signal.reason);};
      timer = clock.setTimeout(() => {signal.removeEventListener("abort", abort);resolve();}, Math.min(2_147_483_647, end - clock.now()));
      timer.unref?.();signal.addEventListener("abort", abort, {once: true});if (signal.aborted) abort();
    });
  }
  signal.throwIfAborted();
}
