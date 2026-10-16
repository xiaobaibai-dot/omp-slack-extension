import {createHash, randomUUID} from "node:crypto";
import {failureReason} from "./request-lifecycle.ts";
import type {Route} from "./types.ts";
export type UploadPhase = "allocate" | "transfer" | "complete";
export type DeliveryState = "in_flight" | "delivered" | "uncertain" | "not_shared" | "rejected";
export interface DeliveryStatus {
  operationId: string; kind: "message" | "upload"; state: DeliveryState;
  phase?: UploadPhase; fileId?: string; diagnostic?: {category: string; httpStatus?: number; code?: string};
}
interface Entry extends DeliveryStatus {scope: string; fingerprint: string}
const scopeOf = (r: Route) => JSON.stringify([r.team, r.channel, r.thread]);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Factory-local ledger. Never evict unresolved/delivered operations to silently permit duplicates. */
export class DeliveryLedger {
  #entries = new Map<string, Entry>();
  #limit: number;
  constructor(limit = 1024) {this.#limit = limit;}
  list(route?: Route): DeliveryStatus[] {
    return [...this.#entries.values()].filter(e => !route || e.scope === scopeOf(route)).map(({scope, fingerprint, ...status}) => structuredClone(status));
  }
  summary(route: Route) {
    const all = this.list(route), unresolved = all.filter(e => e.state === "uncertain" || e.state === "not_shared" || e.state === "in_flight");
    const ordered = [...unresolved, ...all.filter(e => !unresolved.includes(e)).reverse()];
    return {total: all.length, unresolved: unresolved.length, operations: ordered.slice(0, 20), truncated: all.length > 20};
  }
  get(route: Route, id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry || entry.scope !== scopeOf(route)) throw new Error("Delivery operation does not belong to this source thread.");
    return entry;
  }
  begin(route: Route, kind: Entry["kind"], content: string | Buffer, deduplicateDelivered = true): {entry: Entry; duplicate: boolean} {
    const scope = scopeOf(route), fingerprint = digest(content);
    const prior = [...this.#entries.values()].find(e => e.scope === scope && e.kind === kind && e.fingerprint === fingerprint && (deduplicateDelivered || e.state !== "delivered"));
    if (prior?.state === "delivered") return {entry: prior, duplicate: true};
    if (prior && prior.state !== "rejected") throw this.blocked(prior);
    // A paraphrased message may duplicate an uncertain message too. Keep all text blocked.
    const blocked = kind === "message" && [...this.#entries.values()].find(e => e.scope === scope && e.kind === "message" && (e.state === "uncertain" || e.state === "in_flight"));
    if (blocked) throw this.blocked(blocked);
    if (prior) {prior.state = "in_flight";delete prior.diagnostic;delete prior.phase;delete prior.fileId;return {entry: prior, duplicate: false};}
    if (this.#entries.size >= this.#limit) throw new Error("Delivery ledger is full; no mutation sent. Restart loses deduplication history; verify old deliveries first.");
    const entry: Entry = {scope, fingerprint, operationId: randomUUID(), kind, state: "in_flight"};
    this.#entries.set(entry.operationId, entry);return {entry, duplicate: false};
  }
  blocked(entry: DeliveryStatus) {
    return Object.assign(new Error(`Delivery ${entry.operationId} is ${entry.state}; no repeat sent. Use slack_delivery_status to inspect/verify. Source read tools remain available.`), {code: "delivery_blocked"});
  }
  fail(entry: Entry, error: unknown) {
    const e = error as {phase?: UploadPhase; fileId?: string; diagnostic?: DeliveryStatus["diagnostic"]};
    if (["allocate", "transfer", "complete"].includes(e?.phase ?? "")) entry.phase = e.phase;
    if (typeof e?.fileId === "string" && /^F[A-Z0-9]+$/.test(e.fileId)) entry.fileId = e.fileId;
    const uncertain = failureReason(error) === "network_outcome_uncertain";
    entry.state = uncertain ? "uncertain" : "rejected";
    // No complete call was made in these stages. Uncertainty concerns staging only.
    if (uncertain && entry.kind === "upload" && (entry.phase === "allocate" || entry.phase === "transfer")) entry.state = "not_shared";
    entry.diagnostic = e?.diagnostic ?? {category: failureReason(error)};
  }
  suppressFinal(route: Route) {return this.list(route).some(e => e.state === "uncertain" || e.state === "not_shared" || e.state === "in_flight");}
  /** Only observed, affirmative source-thread share evidence can resolve completion uncertainty. */
  async verify(route: Route, id: string, inspect?: (fileId: string) => Promise<boolean>): Promise<DeliveryStatus> {
    const entry = this.get(route, id);
    if (entry.state === "not_shared") entry.state = "rejected"; // Explicit inspection acknowledges local proof: complete never called.
    else if (entry.kind === "upload" && entry.state === "uncertain" && entry.fileId && inspect && await inspect(entry.fileId)) entry.state = "delivered";
    return this.list(route).find(e => e.operationId === id)!;
  }
}
