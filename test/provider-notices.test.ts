import test from "node:test";
import assert from "node:assert/strict";
import {ProviderNotices, retryTime, limitKind} from "../src/provider-notices.ts";
import type {ProviderNotice} from "../src/provider-notices.ts";
import type {Route} from "../src/types.ts";
import {job, settle, deferred, FakeTransport, config, host} from "./helpers.ts";
import {NativeSession} from "../src/shared-runner.ts";
import {NativeHost, input, caps} from "./native-host.ts";
import {SlackBridge} from "../src/bridge.ts";
const now = Date.parse("2026-10-15T12:00:00Z");
const model = {provider: "test-provider", model: "test-model"};
const failed = (extra = {}) => ({role: "assistant", ...model, stopReason: "error", errorStatus: 429, ...extra});
const success = (extra = {}) => ({role: "assistant", ...model, stopReason: "stop", content: [{type:"text",text:"private result never copied into notices"}], ...extra});
function fixture(send?: (route: Route, notice: ProviderNotice) => Promise<boolean>) {
  const posts: {route:Route;notice:ProviderNotice}[] = [];
  return {posts, notices: new ProviderNotices(send ?? (async (route, notice) => {posts.push({route, notice});return true;}), () => now)};
}
test("provider failure classifier uses structured usage/429 and never normal assistant text", () => {
  assert.equal(limitKind(failed({errorId:0x0008_1000})), "quota");
  assert.equal(limitKind(failed()), "rate");
  assert.equal(limitKind(failed({errorStatus:402,errorMessage:'insufficient_quota API KEY SECRET'})), "quota");
  assert.equal(limitKind(success({content:[{type:'text',text:'429 quota exhausted'}]})), undefined);
  assert.equal(limitKind(failed({errorStatus:500,errorMessage:'server unavailable'})), undefined);
  assert.equal(limitKind({...failed(),stopReason:'aborted'}),undefined);
  assert.equal(limitKind(failed({errorStatus:400,errorMessage:"Invalid parameter: max_tokens must be less than 429"})),undefined);
  assert.equal(limitKind(failed({errorStatus:undefined,errorMessage:"HTTP 429"})),"rate");
});
test("only valid header delays/reset timestamps produce UTC retry times", () => {
  assert.deepEqual(retryTime({'Retry-After':'120'},now),{at:now+120_000,source:'Retry-After'});
  assert.equal(retryTime({'retry-after':'Thu, 15 Oct 2026 12:02:00 GMT'},now)?.at,now+120_000);
  assert.equal(retryTime({'anthropic-ratelimit-requests-reset':'2026-10-15T20:03:00+08:00'},now)?.at,now+180_000);
  assert.equal(retryTime({'x-ratelimit-reset-requests':'1m2s','x-ratelimit-reset-tokens':'2m'},now)?.at,now+120_000);
  for(const value of ['-2','Infinity','tomorrow','999999999999999999999','2026-10-15']) assert.equal(retryTime({'retry-after':value},now),undefined);
  assert.equal(retryTime({'x-ratelimit-reset':'1234567890'},now),undefined,'ambiguous untyped reset is not guessed');
});
test("quota notices dedupe failures, use exact source thread and never expose raw errors", async () => {
  const f=fixture(),a=job().route,b={...a,thread:'different-thread'};
  f.notices.response({status:429,requestId:'same-response',headers:{'retry-after':'120','authorization':'SECRET'}},model);
  f.notices.observe(failed({responseId:'same-response',errorMessage:'sk-SECRET private transcript'}),[a,b]);f.notices.observe(failed(),[a,b]);await settle();
  assert.equal(f.posts.length,2);assert.deepEqual(f.posts.map(p=>p.route.thread),[a.thread,b.thread]);
  assert.ok(f.posts.every(p=>p.notice.text.includes('2026-10-15 12:02:00.000 UTC')));
  assert.ok(f.posts.every(p=>!p.notice.text.includes('SECRET')&&!p.notice.text.includes('private')));
});
test("200 headers, old turn headers and SDK-style error strings cannot invent recovery time",async()=>{
  for(const clear of ['200','new-turn','error-text']) {const f=fixture();
    if(clear!=='error-text')f.notices.response({status:clear==='200'?200:429,requestId:'SAME-ID',headers:{'retry-after':'120'}},model);
    if(clear==='new-turn')f.notices.beginTurn();
    f.notices.observe(failed({responseId:'SAME-ID',errorMessage:'retry-after-ms=99999 resets tomorrow'}),[job().route]);await settle();
    assert.match(f.posts[0]!.notice.text,/恢复时间未知/);
  }
});
test("recovery requires actual actionable same-model output, only follows confirmed failure and is deduped",async()=>{
  const f=fixture();f.notices.observe(failed(),[job().route]);await settle();
  for(const m of [success({model:'other'}),success({stopReason:'aborted'}),success({stopReason:'length'}),success({content:[]}),success({stopDetails:{type:'pause_turn'}})])f.notices.observe(m,[]);
  await settle();assert.equal(f.posts.length,1);f.notices.observe(success(),[]);f.notices.observe(success(),[]);await settle();
  assert.equal(f.posts.length,2);assert.equal(f.posts[1]!.notice.kind,'recovered');assert.ok(!f.posts[1]!.notice.text.includes('private result'));
  assert.match(f.posts[1]!.notice.text,/不代表原账号额度已重置/);
});
test("off disposes pending notifications and unknown mutation outcome is never retried",async()=>{
  const gate=deferred<boolean>();let attempts=0;const f=fixture(async()=>{attempts++;return gate.promise;});
  f.notices.observe(failed(),[job().route]);await settle();f.notices.observe(failed(),[job().route]);f.notices.observe(success(),[]);
  f.notices.dispose();gate.resolve(false);await settle();assert.equal(attempts,1);
  const g=fixture(async()=>{attempts++;throw new Error('network_outcome_uncertain');});g.notices.observe(failed(),[job().route]);await settle();g.notices.observe(failed(),[job().route]);g.notices.observe(success(),[]);await settle();assert.equal(attempts,2);
});
test("new failure before pending recovery finishes suppresses stale recovery",async()=>{
  const gate=deferred<boolean>(),posts:ProviderNotice[]=[];let calls=0;
  const f=fixture(async(_route,notice)=>{posts.push(notice);return ++calls===1?gate.promise:true;});
  f.notices.observe(failed(),[job().route]);await settle();f.notices.observe(success(),[]);f.notices.observe(failed(),[job().route]);gate.resolve(true);await settle();
  assert.ok(posts.every(p=>p.kind==='limited'));assert.equal(posts.length,2);
});
test("no queued-only or local failure notifications; consumed source gets alert and later recovery",async()=>{
  const h=new NativeHost(),posts:{route:Route;notice:ProviderNotice}[]=[],n=new NativeSession(h as never,()=>true,undefined,async(route,notice)=>{posts.push({route,notice});return true;});
  const c=caps(),pending=n.run(input('A'),c.capabilities,new AbortController().signal);
  await settle();h.listener({type:'turn_end',message:failed()});await settle();assert.equal(posts.length,0);
  h.answer('local done');h.consume([h.followUp[0]!]);h.listener({type:'turn_end',message:failed()});await settle();assert.equal(posts.length,1);
  h.listener({type:'auto_retry_start',delayMs:99999,errorMessage:'429 SECRET'});h.listener({type:'auto_retry_end',success:true});await settle();assert.equal(posts.length,1,'retry metadata alone is not recovery');
  h.listener({type:'turn_end',message:success()});await settle();assert.equal(posts.length,2);
  n.dispose();await Promise.allSettled([pending]);assert.equal(h.abortCalls,0);
});
test("bridge system notices use source transport safety and do not count as model replies",async()=>{
  const transport=new FakeTransport(),gate=deferred<string>();let c:any;
  const bridge=new SlackBridge(config(),host(),()=>transport,async(_input,capabilities)=>{c=capabilities;return gate.promise;});await bridge.start();
  const route=job().route;assert.equal(await bridge.providerNotice(route,{kind:'limited',text:'fixed notice'}),true);
  assert.equal(await bridge.providerNotice({...route,user:'UOTHER'},{kind:'limited',text:'denied'}),false);
  const {envelope}=await import('./helpers.ts');bridge.accept(envelope());await settle();assert.ok(c);gate.resolve('actual final');await settle();
  assert.deepEqual(transport.posts.map(p=>p.text),['fixed notice','actual final']);await bridge.stop();
  assert.equal(await bridge.providerNotice(route,{kind:'recovered',text:'late'}),false);
});


test("auxiliary/unmatched response headers never supply a main-request reset time",async()=>{
  for(const requestId of [undefined,'OTHER-REQUEST']){const f=fixture();
    f.notices.response({status:429,requestId,headers:{'retry-after':'120'}},model);
    f.notices.observe(failed({responseId:'MAIN-REQUEST'}),[job().route]);await settle();assert.match(f.posts[0]!.notice.text,/恢复时间未知/);
  }
});


test("silent local/custom transcript ownership change cannot leak its error to an earlier Slack source",async()=>{
  for(const custom of [false,true]){const h=new NativeHost();h.isStreaming=false;const posts:ProviderNotice[]=[];
    const n=new NativeSession(h as never,()=>true,undefined,async(_route,notice)=>{posts.push(notice);return true;});
    const result=n.run(input('A'),caps().capabilities,new AbortController().signal);await settle();
    h.local('private local request',false,custom);h.listener({type:'turn_end',message:failed()});await settle();assert.equal(posts.length,0);
    n.dispose();await Promise.allSettled([result]);
  }
});
