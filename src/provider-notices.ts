import type {Route} from "./types.ts";

export interface ProviderNotice {kind: "limited" | "recovered"; text: string}
export interface ProviderIdentity {provider?: string; model?: string; id?: string}
export interface RetryTime {at: number; source: "Retry-After" | "rate-limit reset"}
type LimitKind = "quota" | "rate";
interface Episode {route: Route; model: string; sent: Promise<boolean>; recovered: boolean}
const routeKey = (route: Route) => JSON.stringify([route.team, route.channel, route.thread, route.user]);
function modelKey(model: ProviderIdentity): string | undefined {
  const id = typeof model.model === "string" ? model.model : model.id;
  if (typeof model.provider !== "string" || !model.provider || typeof id !== "string" || !id || model.provider.length > 256 || id.length > 256) return;
  return JSON.stringify([model.provider, id]);
}
/** Pinned OMP 18.10.4 error Flag.UsageLimit; never interpreted as a reset date. */
const usageLimitFlag = 0x0008_0000;
export function limitKind(message: any): LimitKind | undefined {
  if (message?.role !== "assistant" || message.stopReason !== "error") return;
  if (Number.isInteger(message.errorId) && (message.errorId & usageLimitFlag)) return "quota";
  // Provider error text is inspected only for bounded classification, never sent.
  const text = typeof (message.errorClassificationMessage ?? message.errorMessage) === "string" ?
    (message.errorClassificationMessage ?? message.errorMessage).slice(0, 8192) : "";
  if (/\b(?:insufficient_quota|usage_limit_reached|quota[_ -](?:exceeded|exhausted)|exceeded your current quota)\b/i.test(text)) return "quota";
  if (message.errorStatus === 429 || message.errorId === 429 || /(?:\brate[_ -]limit(?:[_ -]exceeded)?\b|\btoo many requests\b|\bHTTP(?:\/[12](?:\.\d)?)?[\s:]+429\b)/i.test(text)) return "rate";
}
function validAt(at: number, now: number) {return Number.isFinite(at) && at >= now && at <= now + 366 * 86400_000;}
/** Only response-header values, never natural-language error text or SDK backoff. */
export function retryTime(headers: Record<string, unknown>, now: number): RetryTime | undefined {
  const h = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const retry = h.get("retry-after");
  if (typeof retry === "string" && retry.length <= 128) {
    const value = retry.trim();
    const at = /^\d+(?:\.\d+)?$/.test(value) ? now + Number(value) * 1000 :
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) : NaN;
    if (validAt(at, now)) return {at, source: "Retry-After"};
  }
  const reset: number[] = [];
  // Documented Anthropic RFC3339 timestamps and OpenAI duration headers only.
  for (const name of ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-input-tokens-reset", "anthropic-ratelimit-output-tokens-reset"]) {
    const value = h.get(name);
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
      const at = Date.parse(value);if (validAt(at, now)) reset.push(at);
    }
  }
  for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const value = h.get(name);
    if (typeof value !== "string" || value.length > 100 || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(value)) continue;
    let delay = 0;
    for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) delay += Number(part[1]) * ({ms: 1,s: 1000,m: 60_000,h: 3600_000,d: 86400_000}[part[2]!]!);
    const at = now + delay;if (validAt(at, now)) reset.push(at);
  }
  // Multiple buckets: never announce an earlier reset than one supplied bucket.
  if (reset.length) return {at: Math.max(...reset), source: "rate-limit reset"};
}
function textFor(kind: LimitKind, timing?: RetryTime): string {
  const issue = kind === "quota" ? "模型报告额度或使用量限制。" : "模型请求遇到限流（429）。";
  const time = timing ? `服务端建议最早重试时间：${new Date(timing.at).toISOString().replace("T", " ").replace("Z", " UTC")}（${timing.source}；不保证届时恢复）。` :
    "服务端未提供可用的恢复时间，恢复时间未知。";
  return `${issue}\n${time}\n重试仍由 OMP 原有策略决定；插件不会额外探测或重跑任务。`;
}
/** Per binding: no scheduler, probe, retry timer, transcript storage or Slack outbox. */
export class ProviderNotices {
  #episodes = new Map<string, Episode>();
  #hints = new Map<string, {timing: RetryTime; status: number}>();
  #disposed = false;
  readonly send: (route: Route, notice: ProviderNotice) => Promise<boolean>;
  readonly now: () => number;
  constructor(send: (route: Route, notice: ProviderNotice) => Promise<boolean>, now = () => Date.now()) {this.send = send;this.now = now;}
  beginTurn() {this.#hints.clear();}
  response(event: {status: number; headers: Record<string, unknown>; requestId?: string | null}, model: ProviderIdentity) {
    if (this.#disposed) return;
    const key = modelKey(model);if (!key) return;
    // A response hook is also used by auxiliary models. Model/time proximity is
    // not request identity. Require the same explicit opaque ID on the failure.
    if (typeof event.requestId !== "string" || !event.requestId || event.requestId.length > 256) return;
    const requestKey = `${key}:${event.requestId}`;this.#hints.delete(requestKey);
    // Never borrow a prior 200's reset headers for a later failed call.
    if (event.status < 400) return;
    const hint = retryTime(event.headers, this.now());
    if (hint) {this.#hints.set(requestKey, {timing: hint, status: event.status});while (this.#hints.size > 8) this.#hints.delete(this.#hints.keys().next().value!);}
  }
  observe(message: any, routes: readonly Route[]) {
    if (this.#disposed || message?.role !== "assistant") return;
    const model = modelKey(message);if (!model) return;
    const requestKey = typeof message.responseId === "string" ? `${model}:${message.responseId}` : undefined;
    const kind = limitKind(message), response = requestKey ? this.#hints.get(requestKey) : undefined;
    const hint = response && (message.errorStatus === undefined || message.errorStatus === response.status) ? response.timing : undefined;
    if (requestKey) this.#hints.delete(requestKey);
    if (kind) {
      for (const route of routes) {
        const key = `${model}:${routeKey(route)}`;
        const previous = this.#episodes.get(key);
        if (previous && !previous.recovered) continue;
        const episode: Episode = {model, route: {...route}, sent: Promise.resolve(false), recovered: false};
        this.#episodes.set(key, episode);
        while (this.#episodes.size > 128) this.#episodes.delete(this.#episodes.keys().next().value!);
        // Mark before sending: an uncertain result is never blindly retried.
        episode.sent = Promise.resolve().then(() => this.#disposed ? false : this.send(episode.route, {kind: "limited", text: textFor(kind, hint)})).catch(() => false);
      }
      return;
    }
    const success = (message.stopReason === "stop" || message.stopReason === "toolUse") && message.stopDetails?.type !== "pause_turn" &&
      message.content?.some((part: any) => part.type === "toolCall" || (part.type === "text" && typeof part.text === "string" && part.text.trim()));
    if (!success) return;
    for (const [key, episode] of this.#episodes) {
      if (episode.model !== model || episode.recovered) continue;
      episode.recovered = true;
      void episode.sent.then(async sent => {
        if (sent && !this.#disposed && this.#episodes.get(key) === episode) {
          await this.send(episode.route, {kind: "recovered", text: "模型请求已再次成功返回，可以继续处理。这是实际成功响应，不代表原账号额度已重置；OMP 可能已切换凭据。"}).catch(() => false);
        }
        if (this.#episodes.get(key) === episode) this.#episodes.delete(key);
      });
    }
  }
  dispose() {this.#disposed = true;this.#episodes.clear();this.#hints.clear();}
}
