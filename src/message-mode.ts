import type {Job} from "./types.ts";

/** Only interpret control prefixes after parseEvent has authenticated the source. */
export function messageMode(job: Job): {kind: "request"; job: Job} | {kind: "status" | "usage"} {
  const match = /^!(insert|steer|queue|status)(?:\s+([\s\S]*))?$/i.exec(job.text);
  if (!match) return {kind: "request", job: Object.freeze({...job, delivery: "followUp"})};
  const command = match[1]!.toLowerCase(), text = match[2]?.trim();
  if (command === "status") return {kind: text ? "usage" : "status"};
  if (!text) return {kind: "usage"};
  return {kind: "request", job: Object.freeze({...job, text, delivery: command === "queue" ? "followUp" : "steer"})};
}
