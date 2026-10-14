import { test } from "node:test";
import assert from "node:assert/strict";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import { finalText, isolatedOptions, runIsolated } from "../src/sdk-runner.ts";
import type { SdkRuntime, WorkerSession } from "../src/sdk-runner.ts";
import { config, deferred, job, settle } from "./helpers.ts";
function end(text="final",isTerminal=true,stopReason="stop"):unknown {return {type:"agent_end",isTerminal,messages:[{role:"assistant",stopReason,content:[{type:"thinking",thinking:"private"},{type:"text",text}]}]};}
class Session implements WorkerSession {
  listener:(event:unknown)=>void=()=>{}; prompts:string[]=[];disposed=0;aborted=0;
  gate?:Promise<void>;events:unknown[]=[end()];
  subscribe(listener:(event:unknown)=>void){this.listener=listener;return()=>{this.listener=()=>{};};}
  async prompt(text:string){this.prompts.push(text);await this.gate;for(const event of this.events)this.listener(event);}
  async waitForIdle(){}
  async abort(){this.aborted++;}
  async dispose(){this.disposed++;}
}
function runtime(session:Session):SdkRuntime {return {create:async()=>session,settings:o=>o as never,sessionManager:()=>({marker:"memory"}) as never,registry:()=>({marker:"private registry"}) as never};}
const options={} as CreateAgentSessionOptions;
test("SDK options keep host transcript and global lifecycle out of isolated worker",()=>{
  const r=runtime(new Session());const host={cwd:"/fake/workspace",model:{id:"fake"} as never,modelRegistry:{} as never};
  const o=isolatedOptions(r,host,config(),[],"trusted policy");
  assert.equal(o.bindProcessState,false);assert.match(o.parentTaskPrefix!,/^slack-/);assert.equal(o.restrictToolNames,true);
  assert.equal(o.allowRestrictedCustomTools,true);assert.equal(o.enableMCP,false);assert.equal(o.enableIrc,false);assert.equal(o.enableLsp,false);
  assert.deepEqual(o.contextFiles,[]);assert.deepEqual(o.skills,[]);assert.deepEqual(o.rules,[]);assert.equal(o.disableExtensionDiscovery,true);
  assert.equal(o.providerSessionId,undefined);assert.equal(o.providerPromptCacheKey,undefined);assert.notEqual(o.agentRegistry,undefined);
  assert.equal((o.settings as unknown as Record<string,unknown>)["memory.backend"],"off");
  assert.equal((o.settings as unknown as Record<string,unknown>)["advisor.enabled"],false);
  assert.equal(o.modelRegistry,host.modelRegistry);assert.deepEqual(o.toolNames,[]);
  assert.ok(o.deadline! > Date.now());
});
test("late SDK create after off is disposed without a prompt",async()=>{
  const s=new Session();const gate=deferred<WorkerSession>();const r=runtime(s);r.create=()=>gate.promise;const controller=new AbortController();
  const run=runIsolated(r,options,{job:job(),history:[]},controller.signal);controller.abort();gate.resolve(s);
  await assert.rejects(run);assert.equal(s.prompts.length,0);assert.equal(s.disposed,1);
});
test("off during prompt aborts and disposes with no late text returned",async()=>{
  const s=new Session();const gate=deferred<void>();s.gate=gate.promise;const controller=new AbortController();
  const run=runIsolated(runtime(s),options,{job:job(),history:[]},controller.signal);await settle();controller.abort();gate.resolve();
  await assert.rejects(run);assert.equal(s.aborted,1);assert.equal(s.disposed,1);
});
test("only successful terminal final text is returned; thinking and intermediate output are excluded",async()=>{
  const s=new Session();s.events=[end("intermediate",false),end("done")];
  const text=await runIsolated(runtime(s),options,{job:job(),history:[{request:"same thread",reply:"prior answer"}]},new AbortController().signal);
  assert.equal(text,"done");assert.equal(s.disposed,1);assert.equal(JSON.parse(s.prompts[0]!).prior_same_route_turns[0].request,"same thread");
  for(const stop of ["error","aborted","length","toolUse"]) assert.equal(finalText(end("bad",true,stop)),undefined);
  assert.equal(finalText(end("early",false)),undefined);
});
test("a later terminal error clears an earlier successful candidate",async()=>{
  const s=new Session();s.events=[end("old"),end("error",true,"error")];
  await assert.rejects(runIsolated(runtime(s),options,{job:job(),history:[]},new AbortController().signal),/No terminal/);assert.equal(s.disposed,1);
});
test("prompt failures dispose the worker",async()=>{
  const s=new Session();s.prompt=async()=>{throw new Error("provider unavailable");};
  await assert.rejects(runIsolated(runtime(s),options,{job:job(),history:[]},new AbortController().signal));assert.equal(s.disposed,1);
});
