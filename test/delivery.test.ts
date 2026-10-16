import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {DeliveryLedger} from "../src/delivery.ts";
import {SlackBridge} from "../src/bridge.ts";
import {NativeSession} from "../src/shared-runner.ts";
import {NativeHost} from "./native-host.ts";
import {networkError} from "../src/network.ts";
import {phasedUpload} from "../src/upload.ts";
import {config, deferred, envelope, FakeTransport, host, job, settle} from "./helpers.ts";
import type {Capabilities, Transport} from "../src/types.ts";

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "slack-delivery-"));
  await fs.writeFile(path.join(cwd,"zip"), "zip-bytes");await fs.writeFile(path.join(cwd,"renamed"), "zip-bytes");
  await fs.writeFile(path.join(cwd,"sidecar"), "hash-bytes");
  const nativeHost = new NativeHost();nativeHost.isStreaming = false;
  const n = new NativeSession(nativeHost as never, () => true), t = new FakeTransport(), h = host(), ledger = new DeliveryLedger();
  const b = new SlackBridge(config({uploadMode:"host",cwd}), h, () => t, (i,c,s) => n.run(i,c,s), undefined, undefined, ledger);
  await b.start();
  const begin = async (id: string, thread = "1700000000.000001") => {
    b.accept(envelope("Ev"+id,"C111","deliver", "UOWNER", thread));await settle();
    const requestId = h.logs.filter(l=>l.phase==="start").at(-1)!.requestId;
    return {id: requestId, c: n.capabilities(requestId)};
  };
  return {cwd,n,nativeHost,t,h,b,ledger,begin,async close(){await b.stop();n.dispose();await fs.rm(cwd,{recursive:true,force:true});}};
}
const uncertain = (phase: "allocate" | "transfer" | "complete") => Object.assign(networkError("network_outcome_uncertain", {statusCode:503}), {phase,...(phase!=="allocate"?{fileId:"FZIP"}:{})});

test("successful upload does not consume source binding and remains replyable", async()=>{
  const f=await fixture();try {f.t.upload=async()=>({fileId:"FZIP"});const a=await f.begin("E1");
    await a.c.upload("zip");assert.equal(f.n.snapshot().consumed,1);await a.c.reply("done");
    f.nativeHost.answer("summary",true);await settle();assert.equal(f.t.posts.length,1);assert.equal(f.n.snapshot().consumed,0);
    assert.throws(()=>f.n.capabilities(a.id),/consumed/);
  }finally{await f.close();}
});

test("completion uncertainty isolates ZIP; parallel sidecar succeeds, reads and distinct reply survive, final stays suppressed",async()=>{
  const f=await fixture();try {
    const zip=deferred<void>(),side=deferred<void>();const calls:string[]=[];
    f.t.upload=async(_r,_b,name)=>{calls.push(name);if(name==="zip"){await zip.promise;throw uncertain("complete");}await side.promise;return {fileId:"FSIDE"};};
    const a=await f.begin("E2"),upload=a.c.upload("zip"),sidecar=a.c.upload("sidecar");void upload.catch(()=>{});
    await settle();zip.resolve();await assert.rejects(upload,{code:"network_outcome_uncertain"});
    assert.equal(f.n.snapshot().consumed,1);side.resolve();assert.deepEqual(await sidecar,{fileId:"FSIDE"});
    await a.c.readThread();await assert.rejects(a.c.upload("renamed"),/no repeat sent/);
    assert.deepEqual(await a.c.upload("sidecar"),{fileId:"FSIDE"});assert.equal(calls.length,2);assert.equal(calls.filter(name=>name==="zip").length,1);assert.equal(calls.filter(name=>name==="sidecar").length,1);
    const state=await a.c.deliveryStatus!();assert.equal(state.find(e=>e.fileId==="FZIP")?.state,"uncertain");
    await a.c.reply("ZIP outcome unknown; sidecar delivered.");f.nativeHost.answer("duplicate automatic explanation",true);await settle();
    assert.equal(f.t.posts.length,1);assert.equal(f.h.logs.at(-1)?.reason,"network_outcome_uncertain");assert.equal(f.nativeHost.abortCalls,0);
  }finally{await f.close();}
});

for(const phase of ["allocate","transfer"] as const) test(`${phase} uncertainty retains source and requires explicit evidence inspection before fresh upload`,async()=>{
  const f=await fixture();try {let calls=0;f.t.upload=async()=>{if(++calls===1)throw uncertain(phase);return {fileId:"FRECOVERED"};};
    const a=await f.begin("E3"+phase);await assert.rejects(a.c.upload("zip"));await a.c.readThread();
    await assert.rejects(a.c.upload("zip"),/no repeat/);assert.equal(calls,1);
    const status=(await a.c.deliveryStatus!())[0]!;assert.equal(status.state,"not_shared");assert.equal(status.phase,phase);
    await a.c.deliveryStatus!(status.operationId);assert.deepEqual(await a.c.upload("zip"),{fileId:"FRECOVERED"});
    await a.c.reply("recovered");f.nativeHost.answer("final",true);await settle();assert.equal(calls,2);assert.equal(f.t.posts.length,1);
  }finally{await f.close();}
});

test("uncertain ZIP survives request retirement and off/on ledger; missing share never authorizes resend, positive evidence dedupes",async()=>{
  const f=await fixture();try {let uploads=0;f.t.upload=async()=>{uploads++;throw uncertain("complete");};
    const a=await f.begin("E4");await assert.rejects(a.c.upload("zip"));const op=(await a.c.deliveryStatus!())[0]!;
    f.nativeHost.answer("suppressed",true);await settle();assert.equal(f.t.posts.length,0);assert.throws(()=>f.n.capabilities(a.id),/consumed/);
    const b=await f.begin("E5");assert.notEqual(a.id,b.id);await b.c.readThread();
    (f.t as Transport).verifyUpload=async()=>false;
    assert.equal((await b.c.deliveryStatus!(op.operationId))[0]?.state,"uncertain");await assert.rejects(b.c.upload("renamed"));assert.equal(uploads,1);
    (f.t as Transport).verifyUpload=async()=>true;
    assert.equal((await b.c.deliveryStatus!(op.operationId))[0]?.state,"delivered");assert.deepEqual(await b.c.upload("zip"),{fileId:"FZIP"});assert.equal(uploads,1);
    await b.c.reply("Verified existing file FZIP");f.nativeHost.answer("no duplicate",true);await settle();
    await f.b.stop();const again=new SlackBridge(config(),host(),()=>new FakeTransport(),async()=>"",undefined,undefined,f.ledger);
    assert.equal(again.status().deliveries[0]?.state,"delivered");await again.stop();
  }finally{await f.close();}
});

test("uncertain message blocks paraphrase and new-request final while source inspection still works",async()=>{
  const f=await fixture();try {let sends=0;f.t.post=async()=>{sends++;throw networkError("network_outcome_uncertain");};
    const a=await f.begin("E6");await assert.rejects(a.c.reply("first"));await a.c.readThread();await assert.rejects(a.c.reply("paraphrase"));
    f.nativeHost.answer("automatic",true);await settle();const b=await f.begin("E7");await b.c.readThread();
    await assert.rejects(b.c.reply("new request duplicate"));f.nativeHost.answer("automatic again",true);await settle();assert.equal(sends,1);
  }finally{await f.close();}
});

test("operation scope, concurrent duplicate and full ledger fail closed without revealing content",async()=>{
  const l=new DeliveryLedger(1),r=job().route,a=l.begin(r,"upload",Buffer.from("PRIVATE CONTENT"));
  assert.throws(()=>l.begin(r,"upload",Buffer.from("PRIVATE CONTENT")),/no repeat/);
  assert.throws(()=>l.begin(r,"upload",Buffer.from("different")),/full/);
  await assert.rejects(l.verify({...r,thread:"other"},a.entry.operationId),/does not belong/);
  assert.doesNotMatch(JSON.stringify(l.list()),/PRIVATE|fingerprint|scope|xoxb/);
});

for(const phase of ["allocate","transfer","complete"] as const) test(`phased upload preserves safe ${phase} evidence and stops later phases`,async()=>{
  const calls:string[]=[],r=job().route;
  const error=()=>networkError("network_outcome_uncertain",{statusCode:503,code:"xoxb-SECRET",message:"raw secret"});
  await assert.rejects(phasedUpload({getURL:async()=>{calls.push("allocate");if(phase==="allocate")throw error();return {ok:true,file_id:"FZIP",upload_url:"https://files.slack.com/upload/SECRET"};},
    complete:async()=>{calls.push("complete");throw error();}},async()=>{calls.push("transfer");if(phase==="transfer")throw error();},r,Buffer.from("private"),"a","a",new AbortController().signal,()=>{}),e=>{
      const value=e as any;assert.equal(value.phase,phase);assert.equal(value.fileId,phase==="allocate"?undefined:"FZIP");assert.equal(value.diagnostic.httpStatus,503);
      assert.doesNotMatch(JSON.stringify(e),/SECRET|raw secret|private/);return true;
    });
  assert.deepEqual(calls,["allocate","transfer","complete"].slice(0,["allocate","transfer","complete"].indexOf(phase)+1));
});

test("parallel distinct uploads cannot race past the per-request mutation bound",async()=>{
  const f=await fixture();try {let calls=0;f.t.upload=async()=>{calls++;return {fileId:"FOK"};};
    for(let i=0;i<4;i++)await fs.writeFile(path.join(f.cwd,`file${i}`),`unique ${i}`);
    const a=await f.begin("Bound"),results=await Promise.allSettled([0,1,2,3].map(i=>a.c.upload(`file${i}`)));
    assert.equal(calls,3);assert.equal(results.filter(r=>r.status==="rejected").length,1);
    f.nativeHost.answer("done",true);await settle();
  }finally{await f.close();}
});
test("a fresh attempt discards stale staged file IDs; source verification is bounded",async()=>{
  const f=await fixture();try {let calls=0;f.t.upload=async()=>{throw uncertain(++calls===1?"transfer":"allocate");};
    const a=await f.begin("Fresh");await assert.rejects(a.c.upload("zip"));const id=(await a.c.deliveryStatus!())[0]!.operationId;
    await a.c.deliveryStatus!(id);await assert.rejects(a.c.upload("zip"));assert.equal((await a.c.deliveryStatus!())[0]!.fileId,undefined);
    await a.c.deliveryStatus!(id);await a.c.deliveryStatus!(id);await assert.rejects(a.c.deliveryStatus!(id),/verification limit/);
  }finally{await f.close();}
});

test("off after confirmed completion preserves delivered ledger receipt and prevents a new same-bytes mutation",async()=>{
  const f=await fixture();try {let shares=0;(f.t as Transport).upload=async(route,bytes,name,title,signal)=>phasedUpload({
    getURL:async()=>({ok:true,file_id:"FRECEIPT",upload_url:"https://files.slack.com/upload/fixture"}),
    complete:async()=>{shares++;await f.b.stop();},
  },async()=>{},route,bytes,name,title,signal,()=>{if(f.b.state==="off")throw new Error("off");});
    const a=await f.begin("Receipt");await assert.rejects(a.c.upload("zip"));
    const state=f.b.status().deliveries[0]!;assert.equal(state.state,"delivered");assert.equal(state.fileId,"FRECEIPT");
    const prior=f.ledger.begin({...job().route,thread:"1700000000.000001"},"upload",Buffer.from("zip-bytes"));
    assert.equal(prior.duplicate,true);assert.equal(shares,1);
  }finally{await f.close();}
});

for(const first of ["reply","control","provider"] as const) test(`${first} uncertain locks control, provider and explicit text but retains source reads`,async()=>{
  const f=await fixture();try {
    let sends=0;f.t.post=async()=>{sends++;throw networkError("network_outcome_uncertain");};
    const a=await f.begin("System"+first),route={...job().route,thread:"1700000000.000001"};
    if(first==="reply")await assert.rejects(a.c.reply("first uncertain"));
    if(first==="provider")assert.equal(await f.b.providerNotice(route,{kind:"limited",text:"first uncertain"}),false);
    if(first==="control"){f.b.accept(envelope("EvFirstStatus","C111","!status","UOWNER",route.thread));await settle();}
    assert.equal(sends,1);assert.equal(f.b.status().deliveries[0]?.state,"uncertain");
    f.b.accept(envelope("EvSecondStatus","C111","!status","UOWNER",route.thread));await settle();
    assert.equal(await f.b.providerNotice(route,{kind:"recovered",text:"different system message"}),false);
    await assert.rejects(a.c.reply("paraphrased explicit message"));await a.c.readThread();await a.c.deliveryStatus!();
    assert.equal(sends,1);assert.equal(f.n.snapshot().consumed,1);
    f.nativeHost.answer("no automatic fallback",true);await settle();assert.equal(sends,1);
  }finally{await f.close();}
});
test("confirmed system notices may recur for new events but never bypass uncertain text",async()=>{
  const f=await fixture();try {const route={...job().route,thread:"1700000000.000001"},notice={kind:"limited" as const,text:"same quota notice"};
    assert.equal(await f.b.providerNotice(route,notice),true);assert.equal(await f.b.providerNotice(route,notice),true);assert.equal(f.t.posts.length,2);
    f.t.post=async()=>{throw networkError("network_outcome_uncertain");};
    assert.equal(await f.b.providerNotice(route,notice),false);assert.equal(await f.b.providerNotice(route,notice),false);
    assert.equal(f.b.status().deliveries.filter(e=>e.state==="uncertain").length,1);
  }finally{await f.close();}
});
