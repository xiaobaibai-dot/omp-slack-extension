import { test } from "node:test";
import assert from "node:assert/strict";
import { phasedUpload } from "../src/upload.ts";
import type { UploadApi } from "../src/upload.ts";
import { deferred,job,settle } from "./helpers.ts";
const target={ok:true,upload_url:"https://files.slack.com/upload/v1/FAKE",file_id:"F123"};
test("file completion preserves source channel/thread",async()=>{
  let complete:unknown;const api:UploadApi={getURL:async()=>target,complete:async a=>{complete=a;}};
  const uploaded=await phasedUpload(api,async()=>{},job().route,Buffer.from("x"),"a.txt","a",new AbortController().signal,()=>{});
  assert.deepEqual(complete,{files:[{id:"F123",title:"a"}],channel_id:"C111",thread_ts:job().route.thread});
  assert.deepEqual(uploaded,{fileId:"F123"});
});
test("off during URL allocation prevents binary upload and share",async()=>{
  const gate=deferred<typeof target>();let puts=0;let shares=0;let stopped=false;
  const promise=phasedUpload({getURL:()=>gate.promise,complete:async()=>{shares++;}},async()=>{puts++;},job().route,Buffer.from("x"),"a","a",new AbortController().signal,()=>{if(stopped)throw new Error("off");});
  stopped=true;gate.resolve(target);await assert.rejects(promise);assert.equal(puts,0);assert.equal(shares,0);
});
test("cancellation during binary upload prevents later share even when listener remains on",async()=>{
  const gate=deferred<void>();let shares=0;const controller=new AbortController();
  const promise=phasedUpload({getURL:async()=>target,complete:async()=>{shares++;}},()=>gate.promise,job().route,Buffer.from("x"),"a","a",controller.signal,()=>{});
  await settle();controller.abort();gate.resolve();await assert.rejects(promise);assert.equal(shares,0);
});
test("untrusted upload destination is refused without transmitting bytes",async()=>{
  let puts=0;await assert.rejects(phasedUpload({getURL:async()=>({...target,upload_url:"https://evil.example/upload"}),complete:async()=>{}},async()=>{puts++;},job().route,Buffer.from("secret"),"a","a",new AbortController().signal,()=>{}));assert.equal(puts,0);
});
