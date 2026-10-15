import {test} from "node:test";
import assert from "node:assert/strict";
import {runShared} from "../src/shared-runner.ts";
import {job, deferred, settle, config, envelope, FakeTransport, host as bridgeHost} from "./helpers.ts";
import {requestError, failureReason} from "../src/request-lifecycle.ts";
import {SlackBridge} from "../src/bridge.ts";
class Host {
  messages: any[] = [{role:"user",content:[{type:"text",text:"existing host context"}]}];
  listener: (event:any)=>void = () => {};
  isStreaming=false; aborted=0; removed:string[]=[]; options:any; promptText="";
  gate?: Promise<void>; mix=false; mixMessage?:any; silentMix=false;
  beforeAdmission?:Promise<void>; beforeMessageStart?:Promise<void>;
  queueOnly=false; followUp:string[]=[]; startedRequests=0; generation=0;
  promptFinished=deferred<void>();
  terminalStop="stop";
  idleGate?:Promise<void>;idleEntered=deferred<void>();unsubscribed=0;
  subscribe(listener:(event:any)=>void) {this.listener=listener; return()=>{this.unsubscribed++;this.listener=()=>{};};}
  async prompt(text:string, options:any) {
    this.options=options; this.promptText=text; const generation=this.generation;
    try {
      await this.beforeAdmission;
      if(this.queueOnly) {this.followUp.push(text);options.onPromptAdmitted?.();return;}
      // Mirrors SDK 18.10.4: queue push or idle setup occurs before this callback.
      this.isStreaming=true;options.onPromptAdmitted?.();await this.beforeMessageStart;
      if(generation!==this.generation) throw new Error("prompt dropped during setup");
      const user={role:"user",content:[{type:"text",text}]}; this.messages.push(user);this.startedRequests++;
      this.listener({type:"message_start",message:user}); await this.gate;
      if(generation!==this.generation) return;
      if(this.mix) {
        const local=this.mixMessage??{role:"user",content:[{type:"text",text:"unrelated local input"}]};
        this.messages.push(local);if(!this.silentMix)this.listener({type:"message_start",message:local});
      }
      this.messages.push({role:"assistant",stopReason:this.terminalStop,content:[{type:"text",text:"shared final"}]});
      this.isStreaming=false; this.listener({type:"agent_end",isTerminal:true,messages:this.messages});
    } finally {if(!this.queueOnly)this.isStreaming=false;this.promptFinished.resolve();}
  }
  async waitForIdle() {this.idleEntered.resolve();await this.idleGate;}
  async abort() {this.aborted++;this.generation++;this.isStreaming=false;}
  getQueuedMessages() {return {steering:[],followUp:[...this.followUp],liveSteered:0};}
  removeQueuedMessage(text:string) {
    this.removed.push(text);const index=this.followUp.indexOf(text);
    if(index<0)return false;this.followUp.splice(index,1);return true;
  }
}
const input={job:job(),history:[]};
test("Slack prompt and answer append to the existing host; dispatch uses followUp and never disposes it",async()=>{
  const host=new Host();const before=host.messages[0];
  assert.equal(await runShared(host as never,input,new AbortController().signal),"shared final");
  assert.equal(host.messages[0],before);assert.equal(host.messages.length,3);
  assert.equal(host.options.streamingBehavior,"followUp");assert.equal(host.options.expandPromptTemplates,false);
});
test("mixed local user input prevents forwarding unrelated terminal final text",async()=>{
  const host=new Host();host.mix=true;
  await assert.rejects(runShared(host as never,input,new AbortController().signal),/mixed/);
  assert.equal(host.aborted,0);
});
test("off cancels only the owned host turn and withdraws only its own queued text",async()=>{
  const host=new Host();const gate=deferred<void>();host.gate=gate.promise;const controller=new AbortController();
  const running=runShared(host as never,input,controller.signal);await settle();controller.abort();
  await assert.rejects(running,/cancelled/);assert.equal(host.aborted,1);assert.deepEqual(host.removed,[host.promptText]);
  gate.resolve();await settle();assert.equal(host.messages[0].content[0].text,"existing host context");
});
test("off after local input takes ownership does not abort the local operation",async()=>{
  const host=new Host();const gate=deferred<void>();host.gate=gate.promise;const controller=new AbortController();
  const running=runShared(host as never,input,controller.signal);await settle();
  const local={role:"user",content:[{type:"text",text:"local ownership"}]};host.messages.push(local);host.listener({type:"message_start",message:local});
  controller.abort();await assert.rejects(running,/cancelled/);assert.equal(host.aborted,0);gate.resolve();await settle();
});
test("off before SDK admission prevents a late idle submission from starting",async()=>{
  const host=new Host();const gate=deferred<void>();host.beforeAdmission=gate.promise;
  const controller=new AbortController();const running=runShared(host as never,input,controller.signal);
  controller.abort();await assert.rejects(running,/cancelled/);
  gate.resolve();await host.promptFinished.promise;
  assert.equal(host.startedRequests,0);assert.equal(host.messages.length,1);assert.equal(host.aborted,0);assert.equal(host.isStreaming,false);
});
test("off before a late queue admission withdraws only the Slack follow-up and preserves local work",async()=>{
  const host=new Host();const gate=deferred<void>();host.beforeAdmission=gate.promise;host.queueOnly=true;
  host.isStreaming=true;host.followUp.push("local queued input");
  const controller=new AbortController();const running=runShared(host as never,input,controller.signal);
  controller.abort();await assert.rejects(running,/cancelled/);
  gate.resolve();await host.promptFinished.promise;
  assert.deepEqual(host.followUp,["local queued input"]);assert.equal(host.startedRequests,0);
  assert.equal(host.aborted,0);assert.equal(host.isStreaming,true);
});
test("off during an admitted idle preflight cancels setup before message_start",async()=>{
  const host=new Host();const gate=deferred<void>();host.beforeMessageStart=gate.promise;
  const controller=new AbortController();const running=runShared(host as never,input,controller.signal);
  await settle();assert.equal(host.startedRequests,0);controller.abort();await assert.rejects(running,/cancelled/);
  gate.resolve();await host.promptFinished.promise;
  assert.equal(host.aborted,1);assert.equal(host.startedRequests,0);assert.equal(host.messages.length,1);
});
test("off withdraws an already-admitted follow-up without aborting the local turn",async()=>{
  const host=new Host();host.queueOnly=true;host.isStreaming=true;host.followUp.push("local queued input");
  const controller=new AbortController();const running=runShared(host as never,input,controller.signal);
  await host.promptFinished.promise;controller.abort();await assert.rejects(running,/cancelled/);
  assert.deepEqual(host.followUp,["local queued input"]);assert.equal(host.aborted,0);assert.equal(host.isStreaming,true);
});
test("a local user-attributed custom prompt immediately revokes source capabilities and cannot be forwarded",async()=>{
  const host=new Host();const gate=deferred<void>();host.gate=gate.promise;
  const controller=new AbortController();let owned=false;
  const running=runShared(host as never,input,controller.signal,value=>{owned=value;});await settle();assert.equal(owned,true);
  const local={role:"custom",customType:"skill-prompt",attribution:"user",display:true,content:[{type:"text",text:"local skill input"}]};
  host.messages.push(local);host.listener({type:"message_start",message:local});assert.equal(owned,false);
  gate.resolve();await assert.rejects(running,/mixed/);assert.equal(host.aborted,0);
});
test("off after local custom input takes ownership does not abort that local operation",async()=>{
  const host=new Host();const gate=deferred<void>();host.gate=gate.promise;const controller=new AbortController();
  const running=runShared(host as never,input,controller.signal);await settle();
  const local={role:"custom",customType:"skill-prompt",attribution:"user",content:"local skill input"};
  host.messages.push(local);host.listener({type:"message_start",message:local});controller.abort();
  await assert.rejects(running,/cancelled/);assert.equal(host.aborted,0);gate.resolve();await host.promptFinished.promise;
});
test("terminal ownership checks include custom user input even without its message_start",async()=>{
  const host=new Host();host.mix=true;host.silentMix=true;
  host.mixMessage={role:"custom",customType:"skill-prompt",attribution:"user",content:"local skill input"};
  await assert.rejects(runShared(host as never,input,new AbortController().signal),/mixed/);
});
test("agent-attributed background custom messages do not revoke the Slack turn",async()=>{
  const host=new Host();host.mix=true;
  host.mixMessage={role:"custom",customType:"async-result",attribution:"agent",content:"background result"};
  assert.equal(await runShared(host as never,input,new AbortController().signal),"shared final");
});
test("OMP terminal abort is reported as user cancellation without another host abort",async()=>{
  const host=new Host();host.terminalStop="aborted";
  await assert.rejects(runShared(host as never,input,new AbortController().signal),{code:"user_cancelled"});
  assert.equal(host.aborted,0);
});
test("model terminal failure remains an unknown operation failure",async()=>{
  const host=new Host();host.terminalStop="error";
  try {await runShared(host as never,input,new AbortController().signal);assert.fail("expected failure");}
  catch(error){assert.equal(failureReason(error),"operation_failed");}
});
test("lifecycle abort retains its reason through the shared runner",async()=>{
  for(const reason of ["session_cancelled","binding_taken_over"] as const){
    const host=new Host(),gate=deferred<void>(),controller=new AbortController();host.gate=gate.promise;
    const pending=runShared(host as never,input,controller.signal);await settle();controller.abort(requestError(reason));
    await assert.rejects(pending,{code:reason});assert.equal(host.aborted,1);gate.resolve();await settle();
  }
});
test("host activity uses SDK events and correlates the prompt without copying tool or thinking content",async()=>{
  const host=new Host(),gate=deferred<void>();host.gate=gate.promise;
  const activity:any[]=[];const pending=runShared(host as never,{...input,requestId:"CORRELATED_REQUEST"},new AbortController().signal,()=>{},event=>activity.push(event));
  await settle();host.listener({type:"message_update",assistantMessageEvent:{thinking:"PRIVATE_THINKING"}});
  host.listener({type:"tool_execution_start",toolCallId:"tool1",args:{token:"PRIVATE_ARG"}});
  assert.equal(activity.at(-1).activeToolCalls,1);
  host.listener({type:"tool_execution_update",toolCallId:"tool1",partialResult:"PRIVATE_RESULT"});
  host.listener({type:"tool_execution_end",toolCallId:"tool1",result:"PRIVATE_RESULT"});
  assert.equal(activity.at(-1).activeToolCalls,0);assert.doesNotMatch(JSON.stringify(activity),/PRIVATE_/);
  assert.match(host.promptText,/CORRELATED_REQUEST/);assert.match(host.promptText,/"eventId":"Ev1"/);
  gate.resolve();assert.equal(await pending,"shared final");
});
test("cancel after terminal reply interrupts deferred idle wait and preserves new local work",async()=>{
  const host=new Host(),idle=deferred<void>(),controller=new AbortController();host.idleGate=idle.promise;
  const pending=runShared(host as never,input,controller.signal);void pending.catch(()=>{});await host.idleEntered.promise;
  const local={role:"user",content:[{type:"text",text:"new local work"}]};host.messages.push(local);host.isStreaming=true;
  host.listener({type:"message_start",message:local});controller.abort(requestError("user_cancelled"));
  await assert.rejects(pending,{code:"user_cancelled"});assert.equal(host.unsubscribed,1);
  assert.equal(host.aborted,0);assert.equal(host.isStreaming,true);
  // The unrelated wait can reject later without becoming an unhandled rejection.
  idle.reject(new Error("fixture late idle failure"));await settle();
});
test("terminal completion relinquishes ownership before a new local preflight emits its user message",async()=>{
  const host=new Host(),idle=deferred<void>(),controller=new AbortController();host.idleGate=idle.promise;
  const pending=runShared(host as never,input,controller.signal);void pending.catch(()=>{});await host.idleEntered.promise;
  host.isStreaming=true;controller.abort(requestError("binding_taken_over"));
  await assert.rejects(pending,{code:"binding_taken_over"});assert.equal(host.aborted,0);assert.equal(host.isStreaming,true);
  assert.equal(host.unsubscribed,1);idle.resolve();await settle();
});
test("bridge off releases busy and subscription while unrelated local idle wait remains pending",async()=>{
  const main=new Host(),idle=deferred<void>(),transport=new FakeTransport();main.idleGate=idle.promise;
  const bridge=new SlackBridge(config(),bridgeHost(),()=>transport,(input,_caps,signal)=>runShared(main as never,input,signal));
  await bridge.start();bridge.accept(envelope("EvIdle"));await main.idleEntered.promise;
  const local={role:"user",content:[{type:"text",text:"unrelated local operation"}]};main.messages.push(local);main.isStreaming=true;
  main.listener({type:"message_start",message:local});await bridge.stop();await settle();
  assert.equal(bridge.status().busy,false);assert.equal(main.unsubscribed,1);assert.equal(main.aborted,0);
  assert.equal(main.isStreaming,true);assert.equal(transport.posts.length,0);idle.resolve();await settle();
});
