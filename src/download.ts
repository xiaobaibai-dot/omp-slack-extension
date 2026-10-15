import type { Route } from "./types.ts";
export interface DownloadInfo {
  ok?: boolean;
  file?: {id?: string; name?: string; size?: number; url_private_download?: string; url_private?: string; channels?: string[]; groups?: string[]; ims?: string[]; shares?: {public?: Record<string, unknown>; private?: Record<string, unknown>}};
}
export async function sourceFile(
  info: (id: string) => Promise<DownloadInfo>,
  get: (url: string, signal: AbortSignal) => Promise<Response>,
  route: Route, fileId: string, signal: AbortSignal, guard: () => void,
): Promise<{bytes: Buffer; filename: string}> {
  guard(); signal.throwIfAborted();
  if (!/^F[A-Z0-9]{2,}$/.test(fileId)) throw new Error("Expected a Slack file ID.");
  const metadata = await info(fileId);
  guard(); signal.throwIfAborted();
  const file = metadata.file;
  if (!metadata.ok || !file || file.id !== fileId) throw new Error("Slack file information unavailable.");
  const sources = [...file.channels ?? [], ...file.groups ?? [], ...file.ims ?? [], ...Object.keys(file.shares?.public ?? {}), ...Object.keys(file.shares?.private ?? {})];
  if (!sources.includes(route.channel)) throw new Error("File is not shared in this request's source conversation.");
  if (typeof file.size !== "number" || file.size < 0 || file.size > 10 * 1024 * 1024) throw new Error("Download is limited to 10 MiB.");
  const url = new URL(file.url_private_download ?? file.url_private ?? "");
  if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password) throw new Error("Unexpected Slack file download destination.");
  const response = await get(url.toString(), signal);
  guard(); signal.throwIfAborted();
  if (!response.ok || !response.body) throw new Error("Slack file download failed.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      guard(); signal.throwIfAborted();
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 10 * 1024 * 1024) throw new Error("Download exceeds 10 MiB.");
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  guard(); signal.throwIfAborted();
  if (size !== file.size) throw new Error("Slack file size did not match downloaded bytes.");
  return {bytes: Buffer.concat(chunks), filename: file.name ?? fileId};
}
