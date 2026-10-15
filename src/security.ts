import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import type { Config, Job } from "./types.ts";
export function requesterAllowed(config: Config, user: string, channel: string): boolean {
  return config.owners.has(user) || Boolean(config.channels.has(channel) && config.channelAllUsers?.has(channel));
}
const TS = /^\d{9,16}\.\d{1,12}$/;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
export function parseEvent(body: unknown, config: Config, botUserId: string): Job | undefined {
  const b = record(body);
  if (!b || b.type !== "event_callback" || b.team_id !== config.teamId || b.api_app_id !== config.appId) return;
  // Bind the incoming installation to the authenticated outbound bot without users:read.
  if (!Array.isArray(b.authorizations) || !b.authorizations.some(value => {
    const authorization = record(value);
    return authorization?.is_bot === true && authorization.team_id === config.teamId && authorization.user_id === botUserId;
  })) return;
  const e = record(b.event);
  if (!e) return;
  const profile = record(e.bot_profile);
  const sender = typeof e.user === "string" ? e.user : typeof profile?.user_id === "string" ? profile.user_id : typeof e.bot_id === "string" ? e.bot_id : undefined;
  if (!sender || typeof e.channel !== "string" || !requesterAllowed(config, sender, e.channel)) return;
  // Supported incoming mention/DM events determine admission, without a bot identity filter.
  if ((e.subtype && e.subtype !== "file_share" && e.subtype !== "bot_message") || e.hidden) return;
  const files = Array.isArray(e.files) ? e.files.map(record).filter(f => typeof f?.id === "string" && /^F[A-Z0-9]{2,}$/.test(f.id)).slice(0, 20).map(f => Object.freeze({id: f!.id as string, ...(typeof f!.name === "string" ? {name: f!.name.slice(0, 200)} : {})})) : [];
  if (e.subtype === "file_share" && !files.length) return;
  if (typeof e.channel !== "string" || !/^[CGD][A-Z0-9]{2,}$/.test(e.channel)) return;
  const mention = e.type === "app_mention" && /^[CG]/.test(e.channel);
  const dm = e.type === "message" && e.channel_type === "im" && e.channel.startsWith("D");
  if (!mention && !dm) return;
  if (config.channels.size && !config.channels.has(e.channel)) return;
  if (typeof e.ts !== "string" || !TS.test(e.ts)) return;
  const thread = e.thread_ts ?? e.ts;
  if (typeof thread !== "string" || !TS.test(thread)) return;
  if (typeof e.text !== "string" || !e.text.trim() || e.text.length > 12_000) return;
  if (typeof b.event_id !== "string" || !/^Ev[A-Za-z0-9]+$/.test(b.event_id)) return;
  const text = e.text.split(`<@${botUserId}>`).join("").trim();
  if (!text) return;
  return Object.freeze({
    id: b.event_id, ts: e.ts, text, ...(files.length ? {files: Object.freeze(files)} : {}),
    route: Object.freeze({team: config.teamId, channel: e.channel, thread, user: sender}),
  });
}
export function safeError(error: unknown): string {
  // Never forward raw SDK errors (which may include HTTP headers or request details).
  const e = record(error);
  const code = typeof e?.code === "string" && /^[a-zA-Z0-9_]{1,70}$/.test(e.code) ? e.code : "operation_failed";
  return code;
}
export function plainText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function slackText(text: string): string {
  // Slack parses canonical user-ID mentions only in mrkdwn text. Preserve those
  // tokens while escaping other angle-bracket syntax and literal ampersands.
  return plainText(text).replace(/&lt;@([UW][A-Z0-9]{2,})&gt;/g, "<@$1>");
}
export async function readUpload(root: string | undefined, relativePath: string): Promise<{bytes: Buffer; filename: string}> {
  if (!root) throw new Error("File upload is disabled; configure a dedicated OMP_SLACK_UPLOAD_ROOT.");
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("Upload requires a relative path.");
  // Reject both path separator styles, including Windows drive syntax when tested on Linux.
  if (relativePath.split(/[\\/]/).includes("..") || /^[A-Za-z]:/.test(relativePath)) throw new Error("Upload path escapes output directory.");
  const actualRoot = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(actualRoot, relativePath));
  const relative = path.relative(actualRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Upload path escapes output directory.");
  if (relative.split(path.sep).some(p => p.startsWith("."))) throw new Error("Hidden files cannot be uploaded.");
  const before = await fs.stat(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    if (before.dev !== st.dev || before.ino !== st.ino || await fs.realpath(target) !== target) throw new Error("Upload path changed during validation.");
    if (!st.isFile() || st.size > 10 * 1024 * 1024) throw new Error("Upload must be a regular file of at most 10 MiB.");
    // Read through the verified descriptor, not a path handed to a network library.
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    return {bytes: bytes.subarray(0, offset), filename: path.basename(target)};
  } finally { await handle.close(); }
}
export async function readHostUpload(cwd: string, filePath: string): Promise<{bytes: Buffer; filename: string}> {
  if (!filePath || filePath.includes("\0")) throw new Error("A file path is required.");
  const target = await fs.realpath(path.resolve(cwd, filePath));
  const before = await fs.stat(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > 10 * 1024 * 1024) throw new Error("Upload must be a regular file of at most 10 MiB.");
    if (before.dev !== current.dev || before.ino !== current.ino || await fs.realpath(target) !== target) throw new Error("Upload file changed during validation.");
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    return {bytes: bytes.subarray(0, offset), filename: path.basename(target)};
  } finally {await handle.close();}
}
