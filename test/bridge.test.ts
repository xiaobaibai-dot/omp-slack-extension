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
test("busy host submits every request to the native runner without an external execution queue",async()=>{
  const h=host();h.idle=false;const t=new FakeTransport();const gates=[deferred<void>(),deferred<void>(),deferred<void>()];
  const order:string[]=[];const b=new SlackBridge(config(),h,()=>t,async({job})=>{const i=order.length;order.push(job.route.channel);await gates[i]!.promise;return job.route.channel;});
  await b.start();b.accept(envelope("Ev1","C111"));b.accept(envelope("Ev2","G222"));b.accept(envelope("Ev3","D333"));await settle();
  assert.deepEqual(order,["C111","G222","D333"]);assert.equal(b.status().pending,3);
  gates[2]!.resolve();gates[0]!.resolve();gates[1]!.resolve();await settle();
  assert.deepEqual(t.posts.map(post=>[post.route.channel,post.text]),[["D333","D333"],["C111","C111"],["G222","G222"]]);await b.stop();
});
test("duplicates and outstanding admission bound do not create extra native submissions",async()=>{
  const t=new FakeTransport(),gate=deferred<void>();let runs=0;
  const b=new SlackBridge(config({maxQueue:1}),host(),()=>t,async()=>{runs++;await gate.promise;return "ok";});
  await b.start();b.accept(envelope());b.accept(envelope());b.accept(envelope("Ev2"));await settle();
  assert.equal(b.status().pending,1);assert.equal(runs,1);gate.resolve();await settle();assert.equal(t.posts.length,1);await b.stop();
});
test("off revokes request signals and held tools and suppresses late results",async()=>{
  const t=new FakeTransport();const gate=deferred<void>();let caps:Capabilities|undefined;let signal:AbortSignal|undefined;
  const b=new SlackBridge(config(),host(),()=>t,async(_input,c,s)=>{caps=c;signal=s;await gate.promise;return "late secret";});
  await b.start();b.accept(envelope());b.accept(envelope("Ev2"));await settle();await b.stop();
  assert.equal(signal?.aborted,true);assert.equal(b.status().pending,0);await assert.rejects(caps!.reply("late"));
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
test("explicit reply suppresses automatic final explanation even when the text differs",async()=>{
  const t=new FakeTransport();let n=0;
  const b=new SlackBridge(config(),host(),()=>t,async(_i,c)=>{n++;await c.reply(n===1?"progress":"final");return "final";});
  await b.start();b.accept(envelope());await settle();b.accept(envelope("Ev2"));await settle();
  assert.deepEqual(t.posts.map(x=>x.text),["progress","final"]);await b.stop();
});
test("without an explicit reply the final answer is sent automatically",async()=>{
  const t=new FakeTransport();
  const b=new SlackBridge(config(),host(),()=>t,async()=>"automatic final");
  await b.start();b.accept(envelope());await settle();
  assert.deepEqual(t.posts.map(x=>x.text),["automatic final"]);await b.stop();
});
test("explicit-send suppression is per request and history records the delivered reply",async()=>{
  const t=new FakeTransport();let count=0;const history:string[][]=[];
  const b=new SlackBridge(config(),host(),()=>t,async(input,c)=>{
    history.push(input.history.map(h=>h.reply));
    if(++count===1){await c.reply("requested body");return "Sent the body. §7§";}
    return "next automatic final";
  });
  const thread=`${Math.floor(Date.now()/1000)}.000001`;
  await b.start();b.accept(envelope("EvExplicit","C111","first","UOWNER",thread));await settle();
  b.accept(envelope("EvAutomatic","C111","second","UOWNER",thread));await settle();
  assert.deepEqual(t.posts.map(x=>x.text),["requested body","next automatic final"]);
  assert.deepEqual(history,[[],["requested body"]]);await b.stop();
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
  const b=new SlackBridge(config(),host(),()=>t,async()=>"answer");await b.start();b.accept(envelope());await settle();b.accept(envelope());await settle();assert.equal(t.posts.length,1);await b.stop();
});
test("stale callback from prior enable cannot enqueue after re-enable",async()=>{
  const transports:FakeTransport[]=[];const b=new SlackBridge(config(),host(),()=>{const t=new FakeTransport();transports.push(t);return t;},async()=>"answer");
  await b.start();const old=transports[0]!.onEvent!;await b.stop();await b.start();old(envelope());await settle();assert.equal(transports[1]!.posts.length,0);await b.stop();
});
