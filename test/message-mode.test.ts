import {test} from "node:test";
import assert from "node:assert/strict";
import {messageMode} from "../src/message-mode.ts";
import {SlackBridge} from "../src/bridge.ts";
import {NativeSession} from "../src/shared-runner.ts";
import {NativeHost} from "./native-host.ts";
import {config,deferred,envelope,FakeTransport,host,job,settle} from "./helpers.ts";

test("ordinary messages and !queue use followUp; explicit !insert/!steer use steer",()=>{
  for(const [text,delivery,body] of [["ordinary","followUp","ordinary"],["!queue next task","followUp","next task"],["!insert check wait","steer","check wait"],["!STEER line one\nline two","steer","line one\nline two"],["quoted !insert stays ordinary","followUp","quoted !insert stays ordinary"],["!unknown command","followUp","!unknown command"]] as const){
    const original={...job(),text},result=messageMode(original);assert.equal(result.kind,"request");
    if(result.kind!=="request")throw new Error("request expected");
    assert.equal(result.job.delivery,delivery);assert.equal(result.job.text,body);assert.equal(original.text,text);assert.ok(Object.isFrozen(result.job));
  }
  assert.deepEqual(messageMode({...job(),text:"!status"}),{kind:"status"});
  for(const text of ["!insert","!steer","!queue","!status extra"])assert.deepEqual(messageMode({...job(),text}),{kind:"usage"});
});
test("owner and already-approved channel humans/bots may steer; other identities remain denied",async()=>{
  const t=new FakeTransport(),h=host(),requests:any[]=[],gate=deferred<string>();
  const b=new SlackBridge(config({channels:new Set(["C111","C222","D333"]),channelAllUsers:new Set(["C111"])}),h,()=>t,async i=>{requests.push(i);return gate.promise;});
  await b.start();
  b.accept(envelope("EvOwner","C222","!insert owner"));
  b.accept(envelope("EvMember","C111","<@UBOT> !steer member","UMEMBER"));
  const bot:any=envelope("EvDot","C111","<@UBOT> !insert dot","UDOT");bot.event.bot_id="BDOT";bot.event.subtype="bot_message";b.accept(bot);
  b.accept(envelope("EvDeniedChannel","C222","!insert forbidden","UDOT"));
  b.accept(envelope("EvDeniedDM","D333","!insert forbidden","UDOT"));
  b.accept(envelope("EvDeniedStatus","D333","!status","UDOT"));
  await settle();assert.deepEqual(requests.map(i=>[i.job.text,i.job.delivery]),[["owner","steer"],["member","steer"],["dot","steer"]]);assert.equal(t.posts.length,0);
  await b.stop();gate.resolve("late");await settle();assert.equal(t.posts.length,0);
});
test("!status bypasses full outstanding bound and busy native queue without prompting or exposing other source data",async()=>{
  const t=new FakeTransport(),h=host(),session=new NativeHost(),native=new NativeSession(session as never,()=>true);
  h.status=route=>native.snapshot(route);h.onStopped=()=>native.dispose();
  const b=new SlackBridge(config({maxQueue:1}),h,()=>t,(i,c,s)=>native.run(i,c,s));await b.start();
  b.accept(envelope("EvBusy","C111","wait forever"));await settle();assert.equal(session.submissions.length,1);
  session.listener({type:"tool_execution_start",toolCallId:"wait1",args:{command:"PRIVATE COMMAND"}});
  const status=envelope("EvStatus","D333","!status");b.accept(status);b.accept(status);await settle();
  assert.equal(session.submissions.length,1);assert.equal(t.posts.length,1);assert.equal(t.posts[0]!.route.channel,"D333");
  const answer=JSON.parse(t.posts[0]!.text);assert.equal(answer.native.followUp,0);assert.equal(answer.native.activeToolCalls,1);
  assert.doesNotMatch(t.posts[0]!.text,/C111|wait forever|PRIVATE/);
  b.accept(envelope("EvUsage","D333","!insert"));await settle();assert.match(t.posts[1]!.text,/Use !insert/);assert.equal(session.submissions.length,1);
  await b.stop();assert.equal(session.abortCalls,0);assert.equal(session.followUp.length,0);
});
test("duplicate native inserts are admitted once and stale enabled callbacks cannot replay them",async()=>{
  const t=new FakeTransport(),h=host(),requests:any[]=[],gate=deferred<string>();
  const b=new SlackBridge(config(),h,()=>t,async i=>{requests.push(i);return gate.promise;});await b.start();const old=t.onEvent!;
  const event=envelope("EvInsert","C111","!insert inspect progress");b.accept(event);b.accept(event);await settle();assert.equal(requests.length,1);
  await b.stop();await b.start();old(envelope("EvOld","C111","!insert old"));b.accept(event);await settle();assert.equal(requests.length,1);
  await b.stop();gate.resolve("late");await settle();assert.equal(t.posts.length,0);
});
