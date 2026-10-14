import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackBridge } from "../src/bridge.ts";
import type { Capabilities } from "../src/types.ts";
import { config, deferred, envelope, FakeTransport, host, settle } from "./helpers.ts";

test("default off and unauthorized events cannot create a worker or post",async()=>{
  const transport=new FakeTransport(); let runs=0;
  const bridge=new SlackBridge(config(),host(),()=>transport,async()=>{runs++;return "answer";});
  bridge.accept(envelope()); assert.equal(runs,0); assert.equal(transport.starts,0);
  await bridge.start(); bridge.accept(envelope("Ev2","C111","rm -rf","UOTHER")); await settle();
  assert.equal(runs,0); assert.equal(transport.posts.length,0); await bridge.stop();
});
test("host busy queues without steering; FIFO keeps two channel and DM destinations",async()=>{
  const h=host();h.idle=false;const transport=new FakeTransport(); const gate=deferred<void>();const order:string[]=[];
  const bridge=new SlackBridge(config(),h,()=>transport,async({job})=>{order.push(job.route.channel); if(order.length===1)await gate.promise; return job.route.channel;});
  await bridge.start(); bridge.accept(envelope("Ev1","C111"));bridge.accept(envelope("Ev2","G222"));bridge.accept(envelope("Ev3","D333"));
  assert.deepEqual(order,[]);h.idle=true;void bridge.tick();await settle();assert.deepEqual(order,["C111"]);
  await bridge.tick();assert.equal(order.length,1);gate.resolve();await settle();await bridge.tick();await bridge.tick();
  assert.deepEqual(order,["C111","G222","D333"]);assert.deepEqual(transport.posts.map(p=>p.route.channel),order); await bridge.stop();
});
test("duplicates are suppressed; queue bound drops excess without running",async()=>{
  const h=host();h.idle=false;const t=new FakeTransport();let runs=0;
  const b=new SlackBridge(config({maxQueue:1}),h,()=>t,async()=>{runs++;return "ok";});
  await b.start();b.accept(envelope());b.accept(envelope());b.accept(envelope("Ev2"));
  assert.equal(b.status().queued,1);h.idle=true;await b.tick();assert.equal(runs,1);assert.equal(t.posts.length,1);await b.stop();
});
test("off aborts active work, clears queue, invalidates held tools and suppresses late results",async()=>{
  const t=new FakeTransport();const gate=deferred<void>();let caps:Capabilities|undefined;let signal:AbortSignal|undefined;
  const b=new SlackBridge(config(),host(),()=>t,async(_input,c,s)=>{caps=c;signal=s;await gate.promise;return "late secret";});
  await b.start();b.accept(envelope());b.accept(envelope("Ev2"));await settle();await b.stop();
  assert.equal(signal?.aborted,true);assert.equal(b.status().queued,0);await assert.rejects(caps!.reply("late"));
  gate.resolve();await settle();assert.equal(t.posts.length,0);assert.equal(t.stops,1);
});
test("off while starting never enables or dispatches the late socket",async()=>{
  const t=new FakeTransport();const gate=deferred<void>();t.startGate=gate.promise;
  const b=new SlackBridge(config(),host(),()=>t,async()=>"x");const starting=b.start();await b.stop();gate.resolve();await starting;
  assert.equal(b.state,"off");b.accept(envelope());assert.equal(t.posts.length,0);assert.ok(t.stops>=1);
});
test("repeat start is idempotent and restart is off with no history",async()=>{
  const t=new FakeTransport();const b=new SlackBridge(config(),host(),()=>t,async()=>"x");await b.start();await b.start();assert.equal(t.starts,1);await b.stop();
  const fresh=new SlackBridge(config(),host(),()=>new FakeTransport(),async()=>"x");assert.equal(fresh.state,"off");assert.equal(fresh.status().historyRoutes,0);
});
test("same-thread continuity is bounded and never passed to another channel or another DM owner",async()=>{
  const t=new FakeTransport();const inputs:{channel:string;history:string[]}[]=[];
  const b=new SlackBridge(config({owners:new Set(["UOWNER","UOTHER"])}),host(),()=>t,async(input)=>{inputs.push({channel:input.job.route.channel,history:input.history.map(x=>x.request)});return "answer";});
  await b.start(); const thread=`${Math.floor(Date.now()/1000)}.000001`;
  for(const event of [envelope("Ev1","C111","secret A","UOWNER",thread),envelope("Ev2","C111","follow A","UOWNER",thread),envelope("Ev3","C222","B"),envelope("Ev4","D333","private","UOWNER"),envelope("Ev5","D333","other","UOTHER")]){b.accept(event);await settle();}
  assert.deepEqual(inputs.map(x=>x.history),[[],["secret A"],[],[],[]]);await b.stop();assert.equal(b.status().historyRoutes,0);
});
test("progress reply does not hide final answer; duplicate final is not reposted",async()=>{
  const t=new FakeTransport();let n=0;
  const b=new SlackBridge(config(),host(),()=>t,async(_i,c)=>{n++;await c.reply(n===1?"progress":"final");return "final";});
  await b.start();b.accept(envelope());await settle();b.accept(envelope("Ev2"));await settle();
  assert.deepEqual(t.posts.map(x=>x.text),["progress","final","final"]);await b.stop();
});
test("origin-bound tools cannot enumerate unrelated private channels and cap thread pages",async()=>{
  const t=new FakeTransport();const b=new SlackBridge(config(),host(),()=>t,async(_i,c)=>{
    const page=await c.listConversations();assert.deepEqual(page.conversations.map(x=>x.id),["C111"]);
    await c.readThread();await c.readThread();await c.readThread();await assert.rejects(c.readThread(),/limit/);
    await assert.rejects(c.reply("x".repeat(6001)),/bound/);return "ok";
  });await b.start();b.accept(envelope());await settle();assert.equal(t.reads.length,3);assert.ok(t.reads.every(r=>r.channel==="C111"));await b.stop();
});
test("uncertain Slack post is never automatically retried",async()=>{
  const t=new FakeTransport();t.post=async(route,text)=>{t.posts.push({route,text});throw new Error("network lost after send");};
  const b=new SlackBridge(config(),host(),()=>t,async()=>"answer");await b.start();b.accept(envelope());await settle();await b.tick();b.accept(envelope());await settle();assert.equal(t.posts.length,1);await b.stop();
});
test("stale callback from prior enable cannot enqueue after re-enable",async()=>{
  const transports:FakeTransport[]=[];const b=new SlackBridge(config(),host(),()=>{const t=new FakeTransport();transports.push(t);return t;},async()=>"answer");
  await b.start();const old=transports[0]!.onEvent!;await b.stop();await b.start();old(envelope());await settle();assert.equal(transports[1]!.posts.length,0);await b.stop();
});
