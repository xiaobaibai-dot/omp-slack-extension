import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {LocalBinding} from "../src/binding.ts";
import {SlackBridge} from "../src/bridge.ts";
import {config,FakeTransport,host,deferred,settle,envelope} from "./helpers.ts";
const options=()=>({key:"TFIXTURE:AFIXTURE",namespace:`omp-slack-tests-${randomUUID()}`});
test("new binding waits for old transport shutdown before it can become owner",async()=>{
  const opts=options(),oldTransport=new FakeTransport(),stopped=deferred<void>();
  const work=deferred<void>();let oldSignal:AbortSignal|undefined;
  const oldBridge=new SlackBridge(config(),host(),()=>oldTransport,async(_input,_caps,signal)=>{oldSignal=signal;await work.promise;return "old late reply";});
  oldTransport.stop=async()=>{oldTransport.stops++;await stopped.promise;};
  await oldBridge.start();
  const old=await LocalBinding.acquire({...opts,onTakeover:()=>oldBridge.stop("binding_taken_over")});
  oldBridge.accept(envelope());await settle();
  let replacement:LocalBinding|undefined,acquired=false;
  const claim=LocalBinding.acquire({...opts,onTakeover:async()=>{}}).then(value=>{replacement=value;acquired=true;return value;});
  try {
    for(let i=0;i<100&&old.isOwner();i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(old.isOwner(),false);assert.equal(oldBridge.state,"off");assert.equal(acquired,false);assert.equal(oldSignal?.aborted,true);
    assert.equal(oldSignal?.reason.code,"binding_taken_over");
    work.resolve();await settle();assert.equal(oldTransport.posts.length,0);
    oldBridge.accept(envelope());await settle();assert.equal(oldTransport.posts.length,0);
    stopped.resolve();await claim;assert.equal(replacement!.isOwner(),true);
  } finally {work.resolve();stopped.resolve();await claim;await replacement?.release();await old.release();await oldBridge.stop();}
});
test("takeover during an already-running off waits for the same physical stop",async()=>{
  const opts=options(),transport=new FakeTransport(),gate=deferred<void>();
  transport.stop=async()=>{transport.stops++;await gate.promise;};
  const bridge=new SlackBridge(config(),host(),()=>transport,async()=>"unused");await bridge.start();
  const old=await LocalBinding.acquire({...opts,onTakeover:()=>bridge.stop()});
  const stopping=bridge.stop();let next:LocalBinding|undefined,claimed=false;
  const pending=LocalBinding.acquire({...opts,onTakeover:async()=>{}}).then(value=>{claimed=true;next=value;return value;});
  try {
    for(let i=0;i<100&&old.isOwner();i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(claimed,false);assert.equal(transport.stops,1);
    gate.resolve();await stopping;await pending;assert.equal(next!.isOwner(),true);
  }finally{gate.resolve();await pending;await next?.release();await old.release();}
});
test("simultaneous claims leave one owner and can cleanly release",async()=>{
  const opts=options();const bindings:LocalBinding[]=[];
  try {
    bindings.push(...await Promise.all([1,2,3].map(()=>LocalBinding.acquire({...opts,onTakeover:async()=>{}}))));
    assert.equal(bindings.filter(value=>value.isOwner()).length,1);
  } finally {await Promise.all(bindings.map(value=>value.release()));}
});
test("off aborts a waiting claim and never returns a live replacement",async()=>{
  const opts=options(),gate=deferred<void>(),controller=new AbortController();
  const old=await LocalBinding.acquire({...opts,onTakeover:()=>gate.promise});
  const pending=LocalBinding.acquire({...opts,signal:controller.signal,onTakeover:async()=>{}});
  void pending.catch(()=>{});
  try {
    for(let i=0;i<100&&old.isOwner();i++)await new Promise(resolve=>setTimeout(resolve,5));
    controller.abort();await assert.rejects(pending);
    gate.resolve();await old.release();
    const fresh=await LocalBinding.acquire({...opts,onTakeover:async()=>{}});assert.equal(fresh.isOwner(),true);await fresh.release();
  } finally {gate.resolve();await old.release();}
});
test("two real processes hand over ownership; forced fixture exit leaves no stale owner",async()=>{
  const opts=options();
  const flags=process.versions.bun?[]:["--experimental-strip-types"];
  const child=spawn(process.execPath,[...flags,fileURLToPath(new URL("./fixtures/binding-worker.ts",import.meta.url)),opts.key,opts.namespace],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  const events:string[]=[];let buffer="",errors="";
  child.stdout.on("data",chunk=>{buffer+=chunk.toString();for(;;){const i=buffer.indexOf("\n");if(i<0)break;events.push(JSON.parse(buffer.slice(0,i)).type);buffer=buffer.slice(i+1);}});
  child.stderr.on("data",chunk=>errors+=chunk.toString());
  const wait=async(type:string)=>{const until=Date.now()+10000;while(Date.now()<until){if(events.includes(type))return;if(child.exitCode!==null)throw new Error(`Fixture exited: ${errors}`);await new Promise(resolve=>setTimeout(resolve,10));}throw new Error(`Fixture timed out: ${type}`);};
  let next:LocalBinding|undefined;
  try {
    await wait("owned");next=await LocalBinding.acquire({...opts,onTakeover:async()=>{}});
    assert.ok(events.includes("revoked"));assert.ok(events.includes("closed"));assert.equal(next.isOwner(),true);
    await next.release();next=undefined;child.stdin.write("release\n");await wait("released");
  } finally {child.kill();await next?.release();}
  const killed=spawn(process.execPath,[...flags,fileURLToPath(new URL("./fixtures/binding-worker.ts",import.meta.url)),opts.key,opts.namespace],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  try {
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Crash fixture timed out")),10000);killed.stdout.on("data",chunk=>{if(chunk.toString().includes('"owned"')){clearTimeout(timer);resolve();}});killed.on("error",reject);});
    const exited=new Promise(resolve=>killed.once("exit",resolve));killed.kill("SIGKILL");await exited;
    const recovered=await LocalBinding.acquire({...opts,onTakeover:async()=>{}});assert.equal(recovered.isOwner(),true);await recovered.release();
  } finally {killed.kill();}
});
