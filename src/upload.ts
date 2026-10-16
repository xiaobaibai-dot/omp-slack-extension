import type {UploadPhase} from "./delivery.ts";
import type { Route } from "./types.ts";
export interface UploadApi {
  getURL(args: {filename:string; length:number}): Promise<{ok?:boolean; upload_url?:string; file_id?:string}>;
  complete(args: {files:[{id:string; title:string}]; channel_id:string; thread_ts:string}): Promise<unknown>;
}
export type PutBytes = (url:string, bytes:Uint8Array, signal:AbortSignal) => Promise<void>;
export async function phasedUpload(api:UploadApi, put:PutBytes, route:Route, content:Buffer, filename:string, title:string, signal:AbortSignal, guard:()=>void):Promise<{fileId:string}> {
  let phase: UploadPhase = "allocate", fileId: string | undefined;
  try {
  guard(); signal.throwIfAborted();
  const target=await api.getURL({filename,length:content.byteLength});
  guard(); signal.throwIfAborted();
  if(!target.ok || !target.upload_url || !target.file_id) throw new Error("Slack upload URL unavailable.");
  fileId = target.file_id;
  const url=new URL(target.upload_url);
  if(url.protocol!=="https:" || url.hostname!=="files.slack.com" || url.username || url.password) throw new Error("Unexpected Slack upload destination.");
  phase = "transfer";
  await put(target.upload_url,new Uint8Array(content),signal);
  guard(); signal.throwIfAborted();
  // This is the only phase that shares the uploaded file with the conversation.
  phase = "complete";
  await api.complete({files:[{id:target.file_id,title}],channel_id:route.channel,thread_ts:route.thread});
  // A confirmed completion is a receipt, even if off/cancellation happened meanwhile.
  // The bridge records it before rechecking authority to return a tool result.
  return {fileId:target.file_id};
  } catch (error) {
    // Fixed, non-secret evidence only. Never retain upload URL or raw SDK error.
    const e = error as {code?: string; diagnostic?: unknown};
    throw Object.assign(new Error(`Slack upload failed at ${phase}; inspect delivery status before retrying.`), {
      code: e?.code, phase, ...(fileId ? {fileId} : {}), ...(e?.diagnostic ? {diagnostic: e.diagnostic} : {})});
  }
}
