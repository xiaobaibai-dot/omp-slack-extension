import test from "node:test";
import assert from "node:assert/strict";
import {SocketModeClient} from "@slack/socket-mode";
import {WebClient} from "@slack/web-api";
import {createRequire} from "node:module";
import {SlackTransport} from "../src/slack-transport.ts";
import {connectionFailure, connectionWait, reconnectDelay} from "../src/reconnect.ts";
import {FakeClock, flush} from "./fake-clock.ts";
import {config, deferred, job} from "./helpers.ts";
const identity = {ok:true,team_id:"T123",user_id:"UBOT",bot_id:"BBOT"};
const require = createRequire(import.meta.url);
const NestedWebClient = createRequire(require.resolve("@slack/socket-mode"))("@slack/web-api").WebClient as typeof WebClient;
const reset = {code:"slack_webapi_request_error",original:{code:"ECONNRESET"}};
function fake(t: any, handler: (socket: SocketModeClient, count: number) => Promise<unknown> = async socket => {socket.emit("connected");return {ok:true};}) {
  const clock = new FakeClock(), sockets: SocketModeClient[] = [], times: number[] = [], fatals: unknown[] = [], posts: any[] = [];
  for (const Client of new Set([WebClient, NestedWebClient])) t.mock.method(Client.prototype, "apiCall", async (method: string, args: any) => {
    if (method === "auth.test") return identity;
    if (method === "chat.postMessage") {posts.push(args);return {ok:true};}
    throw new Error("No real network permitted");
  });
  t.mock.method(SocketModeClient.prototype, "start", async function(this: SocketModeClient) {sockets.push(this);times.push(clock.now());return handler(this, sockets.length);});
  const transport = new SlackTransport(config(), clock);
  return {clock,sockets,times,fatals,posts,transport,start:()=>transport.start(()=>{},error=>fatals.push(error))};
}
test("connection classifier separates auth, transient, unknown and Retry-After without raw strings", () => {
  const now = Date.now();
  for (const code of ["invalid_auth","token_revoked","token_expired","missing_scope","not_authed","not_allowed_token_type"]) assert.equal(connectionFailure({code:"slack_webapi_platform_error",data:{error:code}},now).kind,"fatal");
  for (const e of [reset,{statusCode:408},{statusCode:503},{code:"EAI_AGAIN"},{code:"socket_closed"}]) assert.equal(connectionFailure(e,now).kind,"retry");
  for (const e of [{code:"slack_webapi_request_error"},{code:"slack_webapi_request_error",original:{code:"ERR_BAD_RESPONSE"}},new Error("PRIVATE TOKEN")]) assert.equal(connectionFailure(e,now).kind,"unknown");
  for (const statusCode of [400,401,403,404]) assert.equal(connectionFailure({statusCode},now).kind,"fatal");
  assert.equal(connectionFailure({statusCode:429,headers:{"retry-after":"120"}},now).retryAfterMs,120000);
  assert.equal(connectionFailure({statusCode:429},now).retryAfterMs,60000);
  const future = Math.floor(now/1000)*1000+120000;
  assert.equal(connectionFailure({statusCode:429,headers:{"retry-after":new Date(future).toUTCString()}},now).retryAfterMs,future-now);
  assert.equal(connectionFailure({statusCode:429,retryAfter:Infinity},now).kind,"fatal");
});
test("backoff has jitter, caps at 60s, and long server waits do not overflow into early retry", async () => {
  const clock = new FakeClock();assert.deepEqual([0,1,2,3,8,100].map(n=>reconnectDelay(n,undefined,clock)),[700,1400,2800,5600,42000,42000]);
  assert.equal(reconnectDelay(0,120000,clock),120100);
  const controller = new AbortController();let done = false;
  const promise = connectionWait(3_000_000_000,controller.signal,clock).then(()=>{done=true;});
  await clock.advance(2_147_483_647);assert.equal(done,false);await clock.advance(852_516_352);assert.equal(done,false);
  await clock.advance(1);await promise;assert.equal(done,true);assert.equal(clock.timers.size,0);
});
test("transient close retries multiple times on fresh sockets then restores without fatal callback", async t => {
  const f = fake(t,async(socket,n)=>{if(n===2)throw reset;if(n===3)throw {statusCode:503};socket.emit("connected");return {ok:true};});
  try {await f.start();f.sockets[0]!.emit("close");await f.clock.advance(5000);
    assert.equal(f.sockets.length,4);assert.equal(new Set(f.sockets).size,4);assert.equal(f.transport.isReady(),true);assert.equal(f.fatals.length,0);
    assert.deepEqual(f.times.slice(1).map((time,i)=>time-f.times[i]!),[700,1400,2800]);assert.equal(f.clock.timers.size,0);
  } finally {await f.transport.stop();}
});
test("socket outage permits existing HTTP replies and a lost HTTP response is never resent on reconnect", async t => {
  const f = fake(t);try {
    await f.start();f.sockets[0]!.emit("close");await flush();assert.equal(f.transport.isReady(),false);
    await f.transport.post(job().route,"reply while socket down");assert.equal(f.posts.length,1);
    let uncertain = 0;t.mock.method(WebClient.prototype,"apiCall",async()=>{uncertain++;throw reset;});
    await assert.rejects(f.transport.post(job().route,"uncertain"),{code:"network_outcome_uncertain"});
    await f.clock.advance(2000);assert.equal(f.transport.isReady(),true);assert.equal(uncertain,1);assert.equal(f.fatals.length,0);
  } finally {await f.transport.stop();}
});
test("reconnect 429 waits at least Retry-After then succeeds, with no SDK retry layer", async t => {
  const f=fake(t,async(socket,n)=>{if(n===2)throw {code:"slack_webapi_rate_limited_error",retryAfter:120};socket.emit("connected");return {ok:true};});
  try {await f.start();f.sockets[0]!.emit("close");await f.clock.advance(700);assert.equal(f.sockets.length,2);
    await f.clock.advance(120000);assert.equal(f.sockets.length,2);await f.clock.advance(100);assert.equal(f.sockets.length,3);assert.equal(f.transport.isReady(),true);
  }finally{await f.transport.stop();}
});
test("fatal reconnect credentials stop once, whereas generic RequestError gets bounded attempts", async t=>{
  const f=fake(t,async(socket,n)=>{if(n>1)throw {code:"slack_webapi_platform_error",data:{error:"token_revoked"}};socket.emit("connected");return {ok:true};});
  await f.start();f.sockets[0]!.emit("close");await f.clock.advance(600000);
  assert.equal(f.sockets.length,2);assert.equal(f.fatals.length,1);assert.equal((f.fatals[0] as any).code,"token_revoked");assert.equal(f.clock.timers.size,0);
  await assert.rejects(f.transport.post(job().route,"no permission"));await f.transport.stop();
});
test("link_disabled disconnect stops instead of reconnecting; stale socket events only ACK", async t=>{
  const f=fake(t);let events=0,acks=0;
  await f.transport.start(()=>{events++;},e=>f.fatals.push(e));const old=f.sockets[0]!;
  old.emit("close");await f.clock.advance(700);assert.equal(f.sockets.length,2);
  old.emit("slack_event",{type:"events_api",body:{},ack:async()=>{acks++;}});old.emit("connected");assert.equal(events,0);assert.equal(acks,1);
  f.sockets[1]!.emit("ws_message",Buffer.from(JSON.stringify({type:"disconnect",reason:"link_disabled"})),false);await flush();
  await f.clock.advance(600000);assert.equal(f.sockets.length,2);assert.equal(f.fatals.length,1);assert.equal((f.fatals[0] as any).code,"link_disabled");await f.transport.stop();
});
test("off during in-flight reconnect ignores late connected and payload callbacks", async t=>{
  const pending=deferred<unknown>();const f=fake(t,async(socket,n)=>{if(n===2)return pending.promise;socket.emit("connected");return {ok:true};});
  await f.start();f.sockets[0]!.emit("close");await f.clock.advance(700);assert.equal(f.sockets.length,2);
  await f.transport.stop();f.sockets[1]!.emit("connected");pending.resolve({ok:true});await f.clock.advance(120000);
  assert.equal(f.transport.isReady(),false);assert.equal(f.sockets.length,2);assert.equal(f.fatals.length,0);assert.equal(f.clock.timers.size,0);
});
test("connection setup deadline aborts only that attempt, then transient reconnect continues", async t=>{
  const f=fake(t,async(socket,n)=>{if(n===2)return new Promise(()=>{});socket.emit("connected");return {ok:true};});
  try{await f.start();f.sockets[0]!.emit("close");await f.clock.advance(32100);assert.equal(f.sockets.length,3);assert.equal(f.transport.isReady(),true);assert.equal(f.fatals.length,0);}finally{await f.transport.stop();}
});
test("stable connection resets exponent; rapid flaps preserve it",async t=>{
  const f=fake(t);try{await f.start();f.sockets[0]!.emit("close");await f.clock.advance(700);f.sockets[1]!.emit("close");await f.clock.advance(1400);assert.equal(f.sockets.length,3);
    await f.clock.advance(60000);f.sockets[2]!.emit("close");await f.clock.advance(700);assert.equal(f.sockets.length,4);assert.equal(f.transport.connectionStatus().failures,1);
  }finally{await f.transport.stop();}
});
test("structured initial auth failure is sanitized and cannot start Socket Mode",async t=>{
  const f=fake(t);t.mock.method(WebClient.prototype,"apiCall",async()=>{throw {code:"slack_webapi_platform_error",data:{error:"invalid_auth",private:"SECRET"}};});
  await assert.rejects(f.start(),{code:"invalid_auth"});assert.equal(f.sockets.length,0);assert.equal(f.clock.timers.size,0);await f.transport.stop();
});
test("real SDK late apps.connections.open response after off cannot construct a socket",async t=>{
  const clock=new FakeClock(), pending=deferred<any>(),entered=deferred<void>();let sdk:SocketModeClient|undefined;
  const originalOn=SocketModeClient.prototype.on;
  t.mock.method(SocketModeClient.prototype,"on",function(this:SocketModeClient,event:string,listener:any){sdk=this;return originalOn.call(this,event,listener);});
  for(const Client of new Set([WebClient,NestedWebClient]))t.mock.method(Client.prototype,"apiCall",async(method:string)=>{if(method==="auth.test")return identity;entered.resolve();return pending.promise;});
  const transport=new SlackTransport(config(),clock),start=transport.start(()=>{});void start.catch(()=>{});await entered.promise;await transport.stop();await assert.rejects(start);
  pending.resolve({ok:true,url:"wss://127.0.0.1:1"});await flush();assert.equal(sdk!.websocket,undefined);assert.equal(clock.timers.size,0);
});
test("off joins a reconnect's already pending physical close before completing",async t=>{
  const f=fake(t),closing=deferred<void>();let disconnects=0,stopped=false;
  t.mock.method(SocketModeClient.prototype,"disconnect",async()=>{disconnects++;await closing.promise;});
  await f.start();f.sockets[0]!.emit("close");await flush();assert.equal(disconnects,1);
  const off=f.transport.stop().then(()=>{stopped=true;});await flush();assert.equal(stopped,false);
  closing.resolve();await off;assert.equal(stopped,true);await f.clock.advance(120000);assert.equal(f.sockets.length,1);assert.equal(disconnects,1);assert.equal(f.clock.timers.size,0);
});
test("off force-closes a stuck handshake after bounded grace and cancels its reconnect",async t=>{
  const f=fake(t);let forced=0;
  t.mock.method(SocketModeClient.prototype,"disconnect",async()=>new Promise(()=>{}));
  await f.start();(f.sockets[0] as any).websocket={disconnect:()=>{forced++;}};
  f.sockets[0]!.emit("close");await flush();const off=f.transport.stop();await f.clock.advance(2000);await off;
  assert.equal(forced,1);assert.equal(f.clock.timers.size,0);assert.equal(f.sockets.length,1);
});
test("bot credential failure on files.info also terminates the binding, without a retry",async t=>{
  const f=fake(t);await f.start();let calls=0;
  t.mock.method(WebClient.prototype,"apiCall",async(method:string)=>{assert.equal(method,"files.info");calls++;throw {code:"slack_webapi_platform_error",data:{error:"token_revoked"}};});
  await assert.rejects(f.transport.download(job().route,"F123",new AbortController().signal));
  assert.equal(f.fatals.length,1);assert.equal(calls,1);assert.equal(f.transport.connectionStatus().state,"stopped");await f.transport.stop();
});
test("ordinary HTTP file permission error does not invalidate the bot or socket",async t=>{
  const f=fake(t);await f.start();
  t.mock.method(WebClient.prototype,"apiCall",async()=>{throw {code:"slack_webapi_platform_error",data:{error:"file_not_found"}};});
  await assert.rejects(f.transport.download(job().route,"F123",new AbortController().signal));assert.equal(f.fatals.length,0);assert.equal(f.transport.isReady(),true);await f.transport.stop();
});
test("real apps.connections.open HTTP adapter is physically aborted during reconnect off",async t=>{
  const clock=new FakeClock(),entered=deferred<void>();let calls=0,innerSignal:AbortSignal|undefined;let socket:SocketModeClient|undefined;
  const originalStart=SocketModeClient.prototype.start;
  t.mock.method(SocketModeClient.prototype,"start",async function(this:SocketModeClient){socket=this;if(++calls===1){this.emit("connected");return {ok:true};}return originalStart.call(this);});
  for(const Client of new Set([WebClient,NestedWebClient])){
    const original=Client.prototype.apiCall;
    t.mock.method(Client.prototype,"apiCall",function(this:WebClient,method:string,args:any){
      if(method==="auth.test")return Promise.resolve(identity);
      (this as any).axios.defaults.adapter=(request:any)=>{innerSignal=request.signal;entered.resolve();return new Promise((_resolve,reject)=>request.signal.addEventListener("abort",()=>reject(Object.assign(new Error("fixture abort"),{request:{},code:"ERR_CANCELED"})),{once:true}));};
      return original.call(this,method,args);
    });
  }
  const transport=new SlackTransport(config(),clock);await transport.start(()=>{});socket!.emit("close");await clock.advance(700);await entered.promise;
  assert.equal(innerSignal?.aborted,false);await transport.stop();await flush();assert.equal(innerSignal?.aborted,true);assert.equal(calls,2);assert.equal(clock.timers.size,0);
});
test("timed-out SDK attempt cannot create a late socket after a replacement is connected",async t=>{
  const clock=new FakeClock(),pending=deferred<any>();let calls=0;const sockets:SocketModeClient[]=[];const original=SocketModeClient.prototype.start;
  t.mock.method(SocketModeClient.prototype,"start",async function(this:SocketModeClient){sockets.push(this);if(++calls===2)return original.call(this);this.emit("connected");return {ok:true};});
  for(const Client of new Set([WebClient,NestedWebClient]))t.mock.method(Client.prototype,"apiCall",async(method:string)=>method==="auth.test"?identity:pending.promise);
  const transport=new SlackTransport(config(),clock);await transport.start(()=>{});sockets[0]!.emit("close");await clock.advance(32100);
  assert.equal(calls,3);assert.equal(transport.isReady(),true);pending.resolve({ok:true,url:"wss://127.0.0.1:1"});await flush();
  assert.equal(sockets[1]!.websocket,undefined);assert.equal(transport.isReady(),true);await transport.stop();assert.equal(clock.timers.size,0);
});
test("structured websocket TLS rejection stops without weakening certificate validation",async t=>{
  const f=fake(t);await f.start();f.sockets[0]!.emit("error",{code:"slack_socket_mode_websocket_error",original:{code:"CERT_HAS_EXPIRED"}});
  await f.clock.advance(600000);assert.equal(f.sockets.length,1);assert.equal(f.fatals.length,1);assert.equal((f.fatals[0] as any).code,"tls_validation_failed");await f.transport.stop();
});
