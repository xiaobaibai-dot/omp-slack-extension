import {test} from "node:test";
import assert from "node:assert/strict";
import {NativeSession} from "../src/shared-runner.ts";
import {NativeHost,input,caps} from "./native-host.ts";
import {settle,deferred,config,envelope,FakeTransport,host as bridgeHost} from "./helpers.ts";
import {requestError} from "../src/request-lifecycle.ts";
import {SlackBridge} from "../src/bridge.ts";
function bind(host:NativeHost,isCurrent=()=>true) {return new NativeSession(host as never,isCurrent);}
function run(native:NativeSession,id:string,delivery:"steer"|"followUp"="followUp",channel="C111",controller=new AbortController()) {
  const c=caps();const result=native.run(input(id,delivery,channel),c.capabilities,controller.signal);
  return {...c,result,controller};
}

test("busy input immediately enters native followUp; three sources receive distinct FIFO replies before global idle",async()=>{
  const h=new NativeHost(),n=bind(h);const a=run(n,"A"),b=run(n,"B","followUp","G222"),c=run(n,"C","followUp","D333");
  await settle();assert.equal(h.submissions.length,3);assert.deepEqual(h.followUp,h.submissions.map(s=>s.text));
  assert.ok(h.submissions.every(s=>s.options.streamingBehavior==="followUp"&&s.options.runCommands===false&&s.options.expandPromptTemplates===false));
  const [pa,pb,pc]=h.followUp;h.answer("LOCAL RESULT");h.consume([pa!]);h.answer("A only");h.consume([pb!]);
  assert.equal(await a.result,"A only");assert.equal(h.isStreaming,true);
  h.answer("B only");h.consume([pc!]);assert.equal(await b.result,"B only");h.answer("C only",true);
  assert.equal(await c.result,"C only");assert.equal(h.abortCalls,0);n.dispose();
});
test("idle prompt wakes normally with selected native streaming behavior",async()=>{
  for(const mode of ["followUp","steer"] as const){const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"Wake",mode);
    await settle();assert.equal(h.idleStarted,1);assert.equal(n.snapshot().consumed,1);h.answer("awake",true);
    assert.equal(await a.result,"awake");assert.equal(h.abortCalls,0);n.dispose();}
});
test("admission is ordered but never waits for earlier model work",async()=>{
  const h=new NativeHost(),gate=deferred<void>();h.beforeAdmission=gate.promise;const n=bind(h),a=run(n,"A"),b=run(n,"B");
  await settle();assert.equal(h.submissions.length,1);assert.equal(n.snapshot().submitting,2);
  h.beforeAdmission=undefined;gate.resolve();await settle();assert.equal(h.submissions.length,2);
  assert.equal(n.snapshot().followUp,2);a.controller.abort();b.controller.abort();await Promise.allSettled([a.result,b.result]);n.dispose();
});
test("native admission is not consumption and queued request IDs cannot execute Slack tools",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A");await settle();assert.equal(n.snapshot().followUp,1);assert.equal(n.snapshot().consumed,0);
  assert.throws(()=>n.capabilities("A"),/consumed/);h.answer("local");h.consume([h.followUp[0]!]);
  await n.capabilities("A").reply("explicit");h.answer("summary",true);assert.equal(await a.result,"");assert.deepEqual(a.replies,["explicit"]);n.dispose();
});
test("explicit steer enters the native steering lane even with a running wait; no host abort",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"Insert","steer");await settle();
  assert.equal(h.steering.length,1);assert.equal(h.followUp.length,0);assert.equal(h.isStreaming,true);
  h.listener({type:"tool_execution_start",toolCallId:"trainingWait",args:{private:"hidden"}});
  assert.equal(n.snapshot().activeToolCalls,1);h.consume([h.steering[0]!]);
  assert.throws(()=>n.capabilities(),/unambiguous/);await n.capabilities("Insert").reply("insert-specific response");
  h.answer("local training plus insert mixed final",true);assert.equal(await a.result,"");assert.equal(h.abortCalls,0);n.dispose();
});
test("a steer mixed into local training without explicit reply never broadcasts the mixed final",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"Insert","steer");await settle();h.consume([h.steering[0]!]);h.answer("PRIVATE LOCAL TRAINING",true);
  await assert.rejects(a.result,{code:"reply_ambiguous"});assert.equal(h.abortCalls,0);n.dispose();
});
test("native all-mode batching requires explicit source IDs and never guesses a final destination",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A"),b=run(n,"B","followUp","G222");await settle();h.answer("local finished");h.consume([...h.followUp]);
  assert.throws(()=>n.capabilities(),/unambiguous/);await n.capabilities("A").reply("for A");await n.capabilities("B").reply("for B");
  h.answer("combined secret A+B",true);assert.equal(await a.result,"");assert.equal(await b.result,"");assert.deepEqual(a.replies,["for A"]);assert.deepEqual(b.replies,["for B"]);n.dispose();
});
test("mixed cross-source native batch with no explicit replies fails closed",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A"),b=run(n,"B","followUp","D333");await settle();h.answer("local");h.consume([...h.followUp]);h.answer("mixed",true);
  await assert.rejects(a.result,{code:"reply_ambiguous"});await assert.rejects(b.result,{code:"reply_ambiguous"});n.dispose();
});
test("insert over a different active Slack request does not steal its final or its tools",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();
  h.answer("still working",false,"toolUse",true);const b=run(n,"B","steer","D333");await settle();h.consume([h.steering[0]!]);
  assert.throws(()=>n.capabilities(),/unambiguous/);await n.capabilities("B").reply("B explicit");h.answer("mixed A and B",true);
  await assert.rejects(a.result,{code:"reply_ambiguous"});assert.equal(await b.result,"");assert.deepEqual(b.replies,["B explicit"]);n.dispose();
});
test("live-steering claimed before transcript consumption suppresses old automatic final",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();const b=run(n,"B","steer");await settle();
  h.liveSteered=1;h.queueChanged();h.answer("response may already include B");const pb=h.steering[0]!;h.consume([pb],true);h.answer("mixed live final",true);
  await assert.rejects(a.result,{code:"reply_ambiguous"});await assert.rejects(b.result,{code:"reply_ambiguous"});n.dispose();
});
test("off removes only own native messages from either queue, including a TUI promotion",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A"),b=run(n,"B","steer");h.followUp.push("local followup");h.steering.push("local steer");await settle();
  const pa=h.followUp.find(t=>t.includes("request A]"))!;h.followUp.splice(h.followUp.indexOf(pa),1);h.steering.push(pa);
  a.controller.abort();b.controller.abort();await Promise.allSettled([a.result,b.result]);
  assert.deepEqual(h.followUp,["local followup"]);assert.deepEqual(h.steering,["local steer"]);assert.equal(h.abortCalls,0);assert.equal(h.isStreaming,true);n.dispose();
});
test("cancel before late native queue admission withdraws the late item and preserves local work",async()=>{
  const h=new NativeHost(),gate=deferred<void>();h.beforeAdmission=gate.promise;h.followUp.push("local");const n=bind(h),a=run(n,"A");await settle();
  a.controller.abort(requestError("binding_taken_over"));await assert.rejects(a.result,{code:"binding_taken_over"});gate.resolve();await settle();
  assert.deepEqual(h.followUp,["local"]);assert.equal(h.abortCalls,0);n.dispose();
});
test("cancel before idle admission rejects own setup without calling session.abort",async()=>{
  const h=new NativeHost(),gate=deferred<void>();h.isStreaming=false;h.beforeAdmission=gate.promise;const n=bind(h),a=run(n,"A");await settle();
  a.controller.abort();await assert.rejects(a.result);gate.resolve();await settle();assert.equal(h.idleStarted,0);assert.equal(h.abortCalls,0);n.dispose();
});
test("off after idle admission revokes replies but explicitly permits admitted preflight work to continue",async()=>{
  const h=new NativeHost(),gate=deferred<void>();h.isStreaming=false;h.afterAdmission=gate.promise;const n=bind(h),a=run(n,"A");await settle();
  assert.equal(h.idleStarted,0);a.controller.abort();await assert.rejects(a.result);gate.resolve();await settle();assert.equal(h.idleStarted,1);
  assert.throws(()=>n.capabilities("A"));h.answer("late answer",true);assert.deepEqual(a.replies,[]);assert.equal(h.abortCalls,0);n.dispose();
});
test("claimed live steer cannot be recalled; off never aborts or grants its late tools",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A","steer");await settle();const prompt=h.steering.shift()!;
  h.liveSteered=1;h.queueChanged();a.controller.abort();await assert.rejects(a.result);h.consume([prompt],true);h.answer("late",true);
  assert.throws(()=>n.capabilities("A"));assert.equal(h.abortCalls,0);n.dispose();
});
test("local user/custom input revokes held tools immediately without aborting local work",async()=>{
  for(const custom of [false,true]){const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();const held=n.capabilities("A");
    h.local("PRIVATE",true,custom);await assert.rejects(held.reply("must not send"));h.answer("local only",true);
    await assert.rejects(a.result,{code:"session_cancelled"});assert.equal(h.abortCalls,0);assert.equal(a.replies.length,0);n.dispose();}
});
test("terminal checks and held tools reject silent local transcript changes",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();const held=n.capabilities("A");h.local("PRIVATE",false,true);
  await assert.rejects(held.reply("forbidden"));h.answer("local only",true);await assert.rejects(a.result,{code:"reply_ambiguous"});n.dispose();
});
test("agent-attributed background messages do not revoke a clean request",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();
  const message={role:"custom",attribution:"agent",content:"background"};h.messages.push(message);h.listener({type:"message_start",message});h.answer("clean",true);
  assert.equal(await a.result,"clean");n.dispose();
});
test("session switch withdraws queued records, drops late preflight, and cannot run the old request in the new session",async()=>{
  const h=new NativeHost(),gate=deferred<void>();h.isStreaming=false;h.afterAdmission=gate.promise;const id=h.sessionId;const n=bind(h,()=>h.sessionId===id),a=run(n,"A");await settle();
  n.dispose();h.switchSession();gate.resolve();await assert.rejects(a.result,{code:"session_cancelled"});await settle();
  assert.equal(h.idleStarted,0);assert.deepEqual(h.messages,[]);assert.equal(h.abortCalls,0);
});
test("session change racing preprocessing never admits old native text",async()=>{
  const h=new NativeHost(),gate=deferred<void>();h.beforeAdmission=gate.promise;const id=h.sessionId;const n=bind(h,()=>h.sessionId===id),a=run(n,"A");await settle();
  n.dispose();h.switchSession();gate.resolve();await assert.rejects(a.result);await settle();assert.deepEqual(h.followUp,[]);assert.equal(h.abortCalls,0);
});
test("nonterminal agent_end never forwards a premature final",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();let done=false;void a.result.then(()=>{done=true;});
  h.answer("early");h.end(false);await settle();assert.equal(done,false);h.answer("real final",true);assert.equal(await a.result,"real final");n.dispose();
});
test("error, abort, tool-only and empty finals never reuse a stale successful answer",async()=>{
  for(const [stop,text,tool,code] of [["error","fail",false,"operation_failed"],["aborted","stop",false,"user_cancelled"],["toolUse","intermediate",true,"reply_ambiguous"],["stop","",false,"reply_ambiguous"]] as const){
    const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();h.answer("stale candidate");h.answer(text,true,stop,tool);
    await assert.rejects(a.result,error=>code==="operation_failed"?error instanceof Error:(error as any).code===code);assert.equal(h.abortCalls,0);n.dispose();}
});
test("native queue removal settles without replay at the next terminal boundary",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A");await settle();h.removeQueuedMessage(h.followUp[0]!,"followUp");h.answer("local result",true);
  await assert.rejects(a.result,{code:"user_cancelled"});assert.equal(h.submissions.length,1);n.dispose();
});
test("snapshot contains scoped counts and activity metadata, never another request or tool content",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A"),b=run(n,"B","steer","D333");await settle();
  h.listener({type:"tool_execution_start",toolCallId:"t1",args:{secret:"PRIVATE"}});
  h.listener({type:"tool_execution_update",toolCallId:"t1",partialResult:"PRIVATE_RESULT"});
  const snapshot=n.snapshot(input("A").job.route);assert.equal(snapshot.followUp,1);assert.equal(snapshot.steering,0);assert.equal(snapshot.activeToolCalls,1);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE|D333|request B/);n.dispose();await Promise.allSettled([a.result,b.result]);
});
test("retired Slack turns cannot regain unrestricted local directory access",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();h.answer("done",true);await a.result;
  assert.equal(n.localTurn,false);h.local();assert.equal(n.localTurn,true);n.dispose();
});
test("real bridge preserves two channels and DM routes while native followups drain without global idle",async()=>{
  const h=new NativeHost(),n=bind(h),t=new FakeTransport(),host=bridgeHost();host.status=route=>n.snapshot(route);
  const bridge=new SlackBridge(config(),host,()=>t,(i,c,s)=>n.run(i,c,s));await bridge.start();
  for(const [id,ch] of [["Ev1","C111"],["Ev2","G222"],["Ev3","D333"]])bridge.accept(envelope(id,ch));await settle();
  h.answer("LOCAL");for(const text of [...h.followUp]){h.consume([text]);h.answer(JSON.parse(text.split("\n").at(-1)!).route.channel);}
  h.end();await settle();assert.deepEqual(t.posts.map(p=>[p.route.channel,p.text]),[["C111","C111"],["G222","G222"],["D333","D333"]]);
  await bridge.stop();n.dispose();assert.equal(h.abortCalls,0);
});

test("terminal with no assistant after consumption cannot reuse a previous local answer",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A");await settle();h.answer("PRIVATE EARLIER ANSWER");h.consume([h.followUp[0]!]);h.end();
  await assert.rejects(a.result,{code:"reply_ambiguous"});assert.equal(a.replies.length,0);n.dispose();
});
test("truncated model output is not treated as a successful attributable final",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();h.answer("incomplete",true,"length");
  await assert.rejects(a.result,{code:"reply_ambiguous"});n.dispose();
});
test("cancelled consumed work remains mixed until a clean boundary without aborting the host",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();
  a.controller.abort(requestError("network_outcome_uncertain"));await assert.rejects(a.result,{code:"network_outcome_uncertain"});
  const b=run(n,"B","steer","D333");await settle();h.consume([h.steering[0]!]);h.answer("A plus B mixed",true);
  await assert.rejects(b.result,{code:"reply_ambiguous"});assert.equal(h.abortCalls,0);n.dispose();
});
test("silent local input before a turn boundary cannot leak its answer to the previous route",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A"),b=run(n,"B");await settle();
  h.local("PRIVATE",false);h.answer("PRIVATE LOCAL ANSWER");h.consume([h.followUp[0]!]);h.answer("B final",true);
  await assert.rejects(a.result,{code:"reply_ambiguous"});assert.equal(await b.result,"B final");n.dispose();
});
test("session disposal suppresses the completion of an already-started Slack read",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),gate=deferred<any>(),c=caps();
  c.capabilities.readThread=()=>gate.promise;const a=n.run(input("A"),c.capabilities,new AbortController().signal);await settle();
  const reading=n.capabilities("A").readThread();n.dispose();gate.resolve({messages:[{text:"late private result"}],truncated:false});
  await assert.rejects(reading,/ended/);await assert.rejects(a,{code:"session_cancelled"});assert.equal(h.abortCalls,0);
});

test("status does not mislabel OMP live-steered display chips as still-editable steering",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A","steer"),b=run(n,"B","steer");await settle();
  // The real SDK displays claimed live messages at the beginning of steering.
  h.liveSteered=1;h.queueChanged();const status=n.snapshot();assert.equal(status.steering,1);assert.equal(status.claimed,1);
  n.dispose();await Promise.allSettled([a.result,b.result]);
});

test("pause_turn is not a clean boundary and cannot turn an inserted mixed result into B-only output",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();
  h.answer("A still working",false,"stop",false,{type:"pause_turn"});const b=run(n,"B","steer","D333");await settle();
  h.consume([h.steering[0]!]);h.answer("PRIVATE A + B mixed final",true);
  await assert.rejects(a.result,{code:"reply_ambiguous"});await assert.rejects(b.result,{code:"reply_ambiguous"});n.dispose();
});
test("a terminal event never forwards pause_turn output as a final fallback",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();
  h.answer("still working",true,"stop",false,{type:"pause_turn"});await assert.rejects(a.result,{code:"reply_ambiguous"});n.dispose();
});
test("SDK model-mention payload expansion preserves request identity and queue status through the fixed header",async()=>{
  const h=new NativeHost(),n=bind(h),c=caps(),i=input("A");i.job.text="Inspect ^provider/model now";
  const result=n.run(i,c.capabilities,new AbortController().signal);await settle();
  const raw=h.followUp[0]!,expanded=raw.replace("^provider/model","expanded model reference");h.followUp[0]=expanded;h.queueChanged();
  assert.equal(n.snapshot().followUp,1);h.answer("local");h.consume([expanded]);assert.equal(n.snapshot().consumed,1);
  await n.capabilities("A").reply("for A");h.answer("final explanation",true);assert.equal(await result,"");assert.deepEqual(c.replies,["for A"]);n.dispose();
});
test("transformed queue chips are withdrawn by original raw text using the SDK removal contract",async()=>{
  const h=new NativeHost(),n=bind(h),a=run(n,"A");await settle();const raw=h.followUp[0]!,expanded=raw.replace('"request":"hello"','"request":"expanded"');
  h.followUp[0]=expanded;const remove=h.removeQueuedMessage.bind(h);
  h.removeQueuedMessage=(text,queue)=>{assert.equal(text,raw);return remove(expanded,queue);};
  a.controller.abort();await assert.rejects(a.result);assert.equal(h.followUp.length,0);n.dispose();
});
test("body marker, unknown ID or altered fixed header never claim a pending Slack request",async()=>{
  for(const alter of [(text:string)=>"local preface\n"+text,(text:string)=>text.replace("request A]","request unknown]"),(text:string)=>text.replace("Existing OMP tools and approvals apply.","different instructions.")]){
    const h=new NativeHost(),n=bind(h),a=run(n,"A");await settle();h.answer("local");const raw=h.followUp.shift()!;h.consume([alter(raw)]);
    assert.equal(n.snapshot().consumed,0);assert.throws(()=>n.capabilities("A"));h.answer("not owned",true);await assert.rejects(a.result);n.dispose();
  }
});

test("nonterminal error/aborted recovery preserves owners when another source steers into the retry",async()=>{
  for(const stopReason of ["error","aborted"]){const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();
    h.answer("temporary failure",false,stopReason);h.end(false);const b=run(n,"B","steer","D333");await settle();h.consume([h.steering[0]!]);
    h.answer("retried PRIVATE A plus B",true);await assert.rejects(a.result,{code:"reply_ambiguous"});await assert.rejects(b.result,{code:"reply_ambiguous"});n.dispose();}
});
test("a single-source native recovery may finish successfully without prematurely losing its owner",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();h.answer("retrying",false,"error");h.end(false);
  assert.equal(n.snapshot().consumed,1);h.answer("recovered final",true);assert.equal(await a.result,"recovered final");n.dispose();
});

test("nonterminal maintenance invalidates a superficial stop boundary before inserted work",async()=>{
  const h=new NativeHost();h.isStreaming=false;const n=bind(h),a=run(n,"A");await settle();h.answer("apparent final");h.end(false);
  const b=run(n,"B","steer","D333");await settle();h.consume([h.steering[0]!]);h.answer("maintenance A plus B",true);
  await assert.rejects(a.result,{code:"reply_ambiguous"});await assert.rejects(b.result,{code:"reply_ambiguous"});n.dispose();
});

test("same-channel and same-DM requests retain distinct immutable source threads",async()=>{
  const h=new NativeHost(),n=bind(h),t=new FakeTransport(),host=bridgeHost();
  const bridge=new SlackBridge(config(),host,()=>t,(i,c,s)=>n.run(i,c,s));await bridge.start();
  const routes=[["C111","1800000000.000001"],["C111","1800000000.000002"],["D333","1800000000.000003"],["D333","1800000000.000004"]];
  routes.forEach(([channel,thread],index)=>bridge.accept(envelope(`EvThread${index}`,channel,"reply here","UOWNER",thread)));await settle();
  h.answer("LOCAL");for(const text of [...h.followUp]){h.consume([text]);h.answer(JSON.parse(text.split("\n").at(-1)!).route.thread);}
  h.end();await settle();assert.deepEqual(t.posts.map(p=>[p.route.channel,p.route.thread]),routes);
  assert.deepEqual(t.posts.map(p=>p.text),routes.map(route=>route[1]));await bridge.stop();n.dispose();
});
