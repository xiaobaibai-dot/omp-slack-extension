import {test, afterAll} from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Set before loading OMP. No ambient HOME/config/credentials are inherited by run.sh.
let blockedNetwork = 0;
globalThis.fetch = async () => {blockedNetwork++;throw new Error('Outbound network forbidden in offline integration');};
const {createAgentSession,SessionManager,Settings,AuthStorage,ModelRegistry,AgentRegistry,MAIN_AGENT_ID}=await import('@oh-my-pi/pi-coding-agent');
const {createMockModel,registerMockApi}=await import('@oh-my-pi/pi-ai/providers/mock');
const {initializeExtensions}=await import('@oh-my-pi/pi-coding-agent/modes/runtime-init');
const {AsyncJobManager}=await import('@oh-my-pi/pi-coding-agent/async/job-manager');
const {default:slackExtension}=await import('./candidate/index.ts');
const {SlackTransport}=await import('./candidate/src/slack-transport.ts');
const {LocalBinding}=await import('./candidate/src/binding.ts');
const {SocketModeClient}=await import('@slack/socket-mode');
const {WebClient}=await import('@slack/web-api');
const transportMethods=['start','stop','isReady','post','connectionStatus'] as const;
const realTransportMethods=Object.fromEntries(transportMethods.map(name=>[name,SlackTransport.prototype[name]]));

const namespace=`omp-real-runtime-${process.pid}`;
const originalAcquire=LocalBinding.acquire;
LocalBinding.acquire=options=>originalAcquire({...options,namespace});
const transports=new Map<any,{receive:(body:unknown)=>void,disconnect:(error:unknown)=>void}>();
const posts:{route:any,text:string}[]=[];
SlackTransport.prototype.start=async function(receive,disconnect){transports.set(this,{receive,disconnect});return {teamId:'T123',botUserId:'UBOT'};};
SlackTransport.prototype.stop=async function(){transports.delete(this);};
SlackTransport.prototype.isReady=function(){return transports.has(this);};
SlackTransport.prototype.post=async function(route,text,signal){signal?.throwIfAborted();assert.ok(transports.has(this));posts.push({route:{...route},text});};
let sequence=0;
function envelope(text:string,channel='C111',thread='1700000000.000001',user='UOWNER',eventId?:string){return {type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:eventId??`EvRuntime${++sequence}`,authorizations:[{team_id:'T123',user_id:'UBOT',is_bot:true}],event:{type:channel.startsWith('D')?'message':'app_mention',channel_type:channel.startsWith('D')?'im':'channel',channel,thread_ts:thread,user,text,ts:`${Math.floor(Date.now()/1000)}.${String(++sequence).padStart(6,'0')}`}};}
function textOf(message:any){return typeof message?.content==='string'?message.content:message?.content?.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n')??'';}
function requestOf(context:any){const message=[...context.messages].reverse().find((m:any)=>m.role==='user');const text=textOf(message);const id=/\[OMP Slack request ([^\]]+)\]/.exec(text)?.[1];const payload=text.split('\n').find((line:string)=>line.startsWith('{"eventId":'));return id&&payload?{id,...JSON.parse(payload)}:undefined;}
function response(text:string){return {content:[text]};}
function tool(name:string,args:Record<string,unknown>={}){return {content:[{type:'toolCall' as const,name,arguments:args}]};}
async function until(condition:()=>boolean,label:string,timeout=6000){const end=Date.now()+timeout;while(!condition()){if(Date.now()>end)throw new Error(`Timed out: ${label}`);await Bun.sleep(5);}}
function gate<T=void>(){return Promise.withResolvers<T>();}
const rows:any[]=[];
async function fixture(name:string,handler:any,options:{effect?:Function,maxQueue?:number,beforeAgentStart?:Function}={}){
  const root=path.resolve('work',name);await fs.mkdir(root,{recursive:true});
  const settings=Settings.isolated({'advisor.enabled':false,'memory.backend':'off','autolearn.enabled':false,'includeWorkspaceTree':false,'providers.cacheWarming':'off','compaction.enabled':false,'retry.enabled':false,'goal.enabled':false,'todo.enabled':false,'launch.enabled':false,'followUpMode':'one-at-a-time','steeringMode':'one-at-a-time','tools.approvalMode':'yolo'});
  const auth=await AuthStorage.create(':memory:');auth.keys.setRuntime('mock','mock-no-network-test-value');
  const registry=new ModelRegistry(auth,path.join(root,'models.yml'),{settings,ignoreLocalModelConfig:true,cacheDbPath:':memory:',fetch:globalThis.fetch});
  const mock=createMockModel({id:`mock-${name}`,handler});registerMockApi();
  const jobs=new AsyncJobManager({onJobComplete:async()=>{},retentionMs:0});
  const config={appToken:'xapp-FAKE',botToken:'xoxb-FAKE',teamId:'T123',appId:'A123',owners:new Set(['UOWNER']),channels:new Set(['C111','G222','D333']),channelAllUsers:new Set(['C111']),localTools:[],maxQueue:options.maxQueue??32};
  const names=['wait','slack_reply','slack_read_thread','slack_upload_file','slack_download_file','slack_list_conversations',...(options.effect?['fixture_effect']:[])];
  const {session}=await createAgentSession({cwd:root,agentDir:path.resolve('agent'),model:mock,modelRegistry:registry,settings,sessionManager:SessionManager.inMemory(root),agentRegistry:AgentRegistry.global(),bindProcessState:false,
    systemPrompt:['Credential-free integration fixture; follow the supplied mock responses.'],restrictToolNames:false,toolNames:names,
    disableExtensionDiscovery:true,extensions:[pi=>{slackExtension(pi,async()=>config);if(options.beforeAgentStart)pi.on('before_agent_start',options.beforeAgentStart);if(options.effect)pi.registerTool({name:'fixture_effect',label:'Local bounded effect fixture',description:'Append synthetic heartbeat records to an isolated test file.',parameters:pi.zod.object({}),loadMode:'essential',approval:'write',execute:(_id,args,signal)=>options.effect!(signal,root)});}],
    preloadedCustomToolPaths:[],skills:[],rules:[],contextFiles:[],promptTemplates:[],slashCommands:[],additionalDirectories:[],enableMCP:false,enableLsp:false,enableIrc:false,skipPythonPreflight:true,cacheWarming:false,autoTitle:false,hasUI:false,interactivePrompts:false,spawns:'',asyncJobManager:jobs});
  const notices:string[]=[],errors:any[]=[],events:any[]=[];let aborts=0;
  const actualAbort=session.abort.bind(session);session.abort=(...args:any[])=>{aborts++;return actualAbort(...args);};
  session.subscribe((event:any)=>events.push({type:event.type,role:event.message?.role,text:event.message?.role==='user'?textOf(event.message):undefined,name:event.toolName,toolCallId:event.toolCallId,result:event.type==='tool_execution_end'?event.result:undefined,isTerminal:event.isTerminal}));
  await initializeExtensions(session,{reportSendError:(...e)=>errors.push(e),reportRuntimeError:e=>errors.push(e),uiContext:{...session.extensionRunner!.getUIContext(),notify:(m:string)=>notices.push(m)}});
  await session.setActiveToolsByName(names);
  const start=posts.length,evidence:any={};
  const command=(arg:string)=>session.prompt(`/slack${arg?' '+arg:''}`);
  await command('');assert.equal(transports.size,1,notices.join('\n'));
  const receive=[...transports.values()][0]!.receive;
  return {session,mock,jobs:session.asyncJobManager!,evidence,notices,errors,events,root,command,receive,send:(text:string,channel?:string,thread?:string,user?:string)=>receive(envelope(text,channel,thread,user)),get posts(){return posts.slice(start);},get aborts(){return aborts;},async close(){await command('off');const abortsBeforeCleanup=aborts;await session.dispose();await jobs.dispose({timeoutMs:1000});auth.close();rows.push({name,heartbeat:evidence.heartbeat?{pid:evidence.heartbeat.pid,exit:evidence.heartbeat.exit,ticks:evidence.heartbeat.ticks,signalAborts:evidence.heartbeat.signalAborts,finalSignalAborted:evidence.heartbeat.signal?.aborted}:undefined,explicitSdkSessionSwitch:evidence.explicitSdkSessionSwitch??false,socketFaults:evidence.socketFaults,providerCalls:mock.calls.length,events,providerInputs:mock.calls.map(c=>c.context.messages.map(m=>({role:m.role,text:textOf(m),toolName:m.toolName}))),notices,errors,postRoutes:posts.slice(start).map(p=>({channel:p.route.channel,thread:p.route.thread})),abortsBeforeCleanup});}};
}

test('actual AgentSession queues followUp FIFO, routes four threads and answers status without a model call',async()=>{
  const local=gate<any>();let calls=0;
  const f=await fixture('followup',context=>++calls===1?local.promise:response(`reply:${requestOf(context)?.route.thread??'local'}`));
  try{
    const work=f.session.prompt('LOCAL LONG MODEL CALL');await until(()=>calls===1,'local model call');
    const routes=[['C111','1700000000.001001'],['C111','1700000000.001002'],['G222','1700000000.001003'],['D333','1700000000.001004']];
    routes.forEach(([channel,thread],i)=>f.send(i===1?'!queue queued':'ordinary',channel,thread));
    await until(()=>f.session.getQueuedMessages().followUp.length===4,'native followup queue');assert.equal(calls,1);
    f.send('!status','C111',routes[0]![1]);await until(()=>f.posts.length===1,'direct status');assert.equal(calls,1);
    const status=JSON.parse(f.posts[0]!.text);assert.equal(status.native.followUp,1);assert.equal(status.native.streaming,true);
    local.resolve(response('LOCAL FINISHED'));await work;await f.session.waitForIdle();await until(()=>f.posts.length===5,'four source replies');
    assert.deepEqual(f.posts.slice(1).map(p=>[p.route.channel,p.route.thread]),routes);assert.deepEqual(f.posts.slice(1).map(p=>p.text),routes.map(r=>`reply:${r[1]}`));
    const consumed=f.events.filter(e=>e.role==='user'&&e.type==='message_start'&&e.text?.startsWith('[OMP Slack request'));
    assert.equal(consumed.length,4);assert.equal(f.aborts,0);assert.equal(f.errors.length,0);
  }finally{local.resolve(response('cleanup'));await f.close();}
},20000);

test('native steer interrupts the real built-in wait while its owned background job remains alive',async()=>{
  let calls=0,insertReplied=false;const bgStarted=gate(),bgDone=gate(),stats={signalAborts:0,totalTicks:60} as any;let jobSignal:AbortSignal|undefined;
  const f=await fixture('wait-steer',context=>{calls++;if(calls===1)return tool('wait');const request=requestOf(context);if(request&&!insertReplied){insertReplied=true;return tool('slack_reply',{request_id:request.id,text:'insert observed, background untouched'});}return response('fixture settled');});
  f.evidence.heartbeat=stats;
  try{
    const jobId=f.jobs.register('bash','bounded synthetic background job',async ctx=>{jobSignal=ctx.signal;await heartbeat(ctx.signal,f.root,bgStarted,bgDone,stats);return 'background completed';},{ownerId:MAIN_AGENT_ID});
    await bgStarted.promise;const work=f.session.prompt('WAIT FOR MY BACKGROUND JOB');await until(()=>f.events.some(e=>e.type==='tool_execution_start'&&e.name==='wait'),'real WaitTool start');
    f.send('!insert inspect progress','C111','1700000000.002001','UDOT');
    await until(()=>f.events.some(e=>e.type==='tool_execution_end'&&e.name==='wait'),'real WaitTool interrupted');
    const waitEnd=f.events.find(e=>e.type==='tool_execution_end'&&e.name==='wait');assert.equal(waitEnd.result.details.interrupted,true);
    await until(()=>f.posts.some(p=>p.text==='insert observed, background untouched'),'explicit insert reply');
    assert.equal(jobSignal?.aborted,false);assert.equal(f.jobs.getJob(jobId)?.status,'running');assert.equal(f.aborts,0);
    process.kill(stats.pid,0);await bgDone.promise;await work;await f.session.waitForIdle();assert.equal(stats.exit,0);assert.equal(stats.ticks,60);assert.equal(stats.signalAborts,0);assert.equal(f.posts.length,1);assert.equal(f.errors.length,0);
  }finally{await bgDone.promise;await f.close();}
},20000);

async function heartbeat(signal:AbortSignal|undefined,root:string,started:ReturnType<typeof gate>,done:ReturnType<typeof gate>,stats:any){
  stats.signal=signal;signal?.addEventListener('abort',()=>stats.signalAborts++);
  const output=path.join(root,`heartbeat-${randomUUID()}.txt`);stats.path=output;
  const script="const fs=require('node:fs');const p=process.argv[1];let n=0;const t=setInterval(()=>{fs.appendFileSync(p,'tick\\n');if(++n==="+(stats.totalTicks??16)+"){clearInterval(t);process.exit(0)}},30);";
  const child=Bun.spawn([process.execPath,'-e',script,output],{stdout:'ignore',stderr:'pipe'});stats.pid=child.pid;started.resolve();
  stats.exit=await child.exited;stats.ticks=(await fs.readFile(output,'utf8')).trim().split('\n').length;done.resolve();
  return {content:[{type:'text',text:'bounded effect completed'}],details:{exit:stats.exit,ticks:stats.ticks}};
}

test('steering never aborts a real foreground side-effect subprocess; insertion waits for its boundary',async()=>{
  let calls=0;const started=gate(),done=gate(),stats={signalAborts:0} as any;
  const f=await fixture('effect-steer',context=>{calls++;if(calls===1)return tool('fixture_effect');const r=requestOf(context);if(r&&context.messages.at(-1)?.role!=='toolResult')return tool('slack_reply',{request_id:r.id,text:'after effect boundary'});return response('local plus insert final');},{effect:(signal:AbortSignal,root:string)=>heartbeat(signal,root,started,done,stats)});
  f.evidence.heartbeat=stats;
  try{const work=f.session.prompt('RUN BOUNDED EFFECT');await started.promise;f.send('!steer check effect','D333','1700000000.003001');
    await until(()=>f.session.getQueuedMessages().steering.length===1,'native steer queue');await Bun.sleep(70);assert.equal(stats.signalAborts,0);assert.equal(stats.exit,undefined);
    await done.promise;await work;await f.session.waitForIdle();await until(()=>f.posts.length===1,'reply after side effect');
    assert.equal(stats.exit,0);assert.equal(stats.ticks,16);assert.equal(stats.signalAborts,0);assert.equal(f.aborts,0);assert.equal(f.posts[0]!.route.channel,'D333');
  }finally{await done.promise;await f.close();}
},20000);

test('off withdraws only Slack pending items, preserves local native input and does not abort a live side effect',async()=>{
  const started=gate(),done=gate(),stats={signalAborts:0} as any;let calls=0;
  const f=await fixture('off-pending',()=>++calls===1?tool('fixture_effect'):response('LOCAL ONLY'),{effect:(signal:AbortSignal,root:string)=>heartbeat(signal,root,started,done,stats)});
  f.evidence.heartbeat=stats;
  try{const work=f.session.prompt('LOCAL EFFECT');await started.promise;f.send('queued remote');f.send('!insert remote insert');
    await f.session.prompt('LOCAL FOLLOWUP',{streamingBehavior:'followUp'});await until(()=>f.session.getQueuedMessages().followUp.length===2&&f.session.getQueuedMessages().steering.length===1,'mixed pending queues');
    await f.command('off');assert.deepEqual(f.session.getQueuedMessages().followUp,['LOCAL FOLLOWUP']);assert.equal(f.session.getQueuedMessages().steering.length,0);assert.equal(f.aborts,0);
    assert.ok(f.notices.some(n=>n.includes('Already admitted or claimed native work may continue')));
    await done.promise;await work;await f.session.waitForIdle();assert.equal(stats.exit,0);assert.equal(stats.ticks,16);assert.equal(stats.signalAborts,0);assert.equal(f.posts.length,0);
  }finally{await done.promise;await f.close();}
},20000);

test('off on a consumed Slack task revokes later replies without aborting its real subprocess',async()=>{
  const started=gate(),done=gate(),stats={signalAborts:0} as any;let calls=0;
  const f=await fixture('off-consumed',()=>++calls===1?tool('fixture_effect'):response('DO NOT SEND AFTER OFF'),{effect:(signal:AbortSignal,root:string)=>heartbeat(signal,root,started,done,stats)});
  f.evidence.heartbeat=stats;
  try{f.send('start bounded effect');await started.promise;await f.command('off');assert.equal(f.aborts,0);await done.promise;await f.session.waitForIdle();await Bun.sleep(20);
    assert.equal(stats.exit,0);assert.equal(stats.ticks,16);assert.equal(stats.signalAborts,0);assert.equal(f.posts.length,0);
  }finally{await done.promise;await f.close();}
},20000);

test('real IPC takeover revokes the old runtime route and leaves its current work running',async()=>{
  const started=gate(),done=gate(),stats={signalAborts:0} as any;let calls=0;let lease:any;
  const f=await fixture('takeover',()=>++calls===1?tool('fixture_effect'):response('OLD OWNER MUST NOT POST'),{effect:(signal:AbortSignal,root:string)=>heartbeat(signal,root,started,done,stats)});
  f.evidence.heartbeat=stats;
  try{f.send('work');await started.promise;lease=await originalAcquire({key:'T123:A123',namespace,timeoutMs:2000,onTakeover:async()=>{}});
    assert.equal(lease.isOwner(),true);assert.equal(transports.size,0);assert.equal(f.aborts,0);await done.promise;await f.session.waitForIdle();
    assert.equal(stats.exit,0);assert.equal(stats.ticks,16);assert.equal(stats.signalAborts,0);assert.equal(f.posts.length,0);assert.ok(f.notices.some(n=>n.includes('another OMP conversation')));
  }finally{await lease?.release();await done.promise;await f.close();}
},20000);

test('status bypasses a full native admission bound and unauthorized commands never reach the provider',async()=>{
  const modelGate=gate<any>();let calls=0;const f=await fixture('status-bound',()=>{calls++;return modelGate.promise;},{maxQueue:1});
  try{f.send('long remote');await until(()=>calls===1,'one consumed request');f.send('second must be rejected');f.send('!status','D333','1700000000.007001');
    f.send('!insert denied','D333','1700000000.007002','UOTHER');f.send('!status','D333','1700000000.007002','UOTHER');
    await until(()=>f.posts.length===1,'status while outstanding bound reached');assert.equal(calls,1);assert.equal(JSON.parse(f.posts[0]!.text).native.consumed,0);
    assert.ok(f.notices.some(n=>n.includes('outstanding-request bound')));assert.equal(f.aborts,0);
    await f.command('off');modelGate.resolve(response('late suppressed'));await f.session.waitForIdle();assert.equal(f.posts.length,1);
  }finally{modelGate.resolve(response('cleanup'));await f.close();}
},20000);

afterAll(async()=>{assert.equal(blockedNetwork,0,'offline suite must not attempt fetch');assert.equal(transports.size,0);await fs.mkdir('logs',{recursive:true});await fs.writeFile('logs/runtime-events.json',JSON.stringify({omp:'18.10.4',bun:Bun.version,candidate:JSON.parse(await fs.readFile('candidate/source.json','utf8')),blockedNetwork,tests:rows},null,2));});

test('actual SDK session switch drops old native pending records and requires manual binding again',async()=>{
  let calls=0;const f=await fixture('session-switch',()=>++calls===1?{content:['OLD LOCAL'],delayMs:1000}:response('NEW LOCAL'));
  try{const oldId=f.session.sessionId,work=f.session.prompt('OLD LOCAL SOURCE');await until(()=>calls===1,'old provider streaming');
    f.send('OLD QUEUED REMOTE','G222','1700000000.008001');await until(()=>f.session.getQueuedMessages().followUp.length===1,'old queued input');
    assert.equal(f.aborts,0);f.evidence.explicitSdkSessionSwitch=true;const switched=await f.session.newSession();assert.equal(switched,true);await work;
    assert.notEqual(f.session.sessionId,oldId);assert.equal(transports.size,0);assert.deepEqual(f.session.getQueuedMessages().followUp,[]);
    assert.equal(f.aborts,1,'the explicit SDK newSession operation itself aborts; the plugin must add no abort');
    await f.session.prompt('FRESH LOCAL SOURCE');await f.session.waitForIdle();assert.equal(calls,2);
    assert.ok(!f.session.messages.some(m=>textOf(m).includes('OLD QUEUED REMOTE')));assert.equal(f.posts.length,0);
    assert.ok(!f.mock.calls[1]!.context.messages.some(m=>textOf(m).includes('OLD QUEUED REMOTE')));
    await f.command('status');const status=JSON.parse(f.notices.findLast(n=>n.startsWith('{"state"'))!);assert.equal(status.state,'off');
  }finally{await f.close();}
},20000);

test('real idle preflight can continue after off but cannot regain Slack reply permission',async()=>{
  const preflight=gate(),entered=gate();let calls=0;
  const f=await fixture('off-preflight',()=>{calls++;return response('LATE PREFLIGHT RESULT');},{beforeAgentStart:async()=>{entered.resolve();await preflight.promise;}});
  try{f.send('idle preflight request');await entered.promise;assert.equal(calls,0);await f.command('off');assert.equal(f.aborts,0);
    preflight.resolve();await until(()=>calls===1,"native provider starts after preflight");await until(()=>f.events.some(e=>e.type==='agent_end'&&e.isTerminal===true),"native preflight completes");await f.session.waitForIdle();assert.equal(calls,1);assert.equal(f.posts.length,0);
  }finally{preflight.resolve();await f.close();}
},20000);

test('duplicate event and stale socket callback cannot create native duplicate work across enable generations',async()=>{
  const modelGate=gate<any>();let calls=0;const f=await fixture('dedupe-restart',()=>{calls++;return modelGate.promise;});
  try{const event=envelope('only once','C111','1700000000.010001','UOWNER','EvExactRetry');f.receive(event);f.receive(event);await until(()=>calls===1,'one native request');
    await f.command('off');await f.command('');f.receive(envelope('stale callback'));const fresh=[...transports.values()][0]!.receive;fresh(event);
    await Bun.sleep(30);assert.equal(calls,1);assert.equal(f.session.getQueuedMessages().followUp.length,0);assert.equal(f.aborts,0);
    await f.command('off');modelGate.resolve(response('revoked'));await f.session.waitForIdle();assert.equal(f.posts.length,0);
  }finally{modelGate.resolve(response('cleanup'));await f.close();}
},20000);

test('real runtime quota failure alerts original thread, dedupes and recovers only after natural same-model success',async()=>{
  let calls=0;const f=await fixture('quota-notice',()=>++calls<3?{stopReason:'error',errorMessage:'429 insufficient_quota PRIVATE_TOKEN_SHOULD_NOT_APPEAR'}:response('natural successful final'));
  try{
    f.send('first quota request','G222','1700000000.011001');await until(()=>calls===1,'actual failed provider');await until(()=>f.posts.length===1,'first quota notice');await f.session.waitForIdle();
    assert.match(f.posts[0]!.text,/额度/);assert.match(f.posts[0]!.text,/恢复时间未知/);assert.ok(!f.posts[0]!.text.includes('PRIVATE_TOKEN'));assert.equal(calls,1);
    f.send('same route naturally retries','G222','1700000000.011001');await until(()=>calls===2,'second user-requested provider');await f.session.waitForIdle();await Bun.sleep(20);assert.equal(f.posts.length,1,'same incident is not repeatedly announced');
    f.send('natural success elsewhere','D333','1700000000.011002');await until(()=>calls===3,'third user-requested provider');await f.session.waitForIdle();await until(()=>f.posts.length===3,'recovery plus final');
    const recovered=f.posts.find(p=>p.text.includes('再次成功返回'))!;assert.equal(recovered.route.channel,'G222');assert.equal(recovered.route.thread,'1700000000.011001');assert.match(recovered.text,/不代表原账号额度已重置/);
    assert.equal(f.posts.find(p=>p.text==='natural successful final')!.route.channel,'D333');assert.equal(calls,3);assert.equal(f.aborts,0);
  }finally{await f.close();}
},20000);

test('real response hook can expose a current failure Retry-After; successful headers never imply recovery',async()=>{
  let calls=0;const f=await fixture('quota-header',()=>++calls===1?{stopReason:'error',errorMessage:'429 rate_limit_exceeded',responseStatus:429,responseRequestId:'SYNTHETIC-COMMON-ID',responseId:'SYNTHETIC-COMMON-ID',responseHeaders:{'retry-after':'120','authorization':'PRIVATE_HEADER'}}:response('done'));
  try{const started=Date.now();f.send('header error');await until(()=>f.posts.length===1,'header-aware notice');await f.session.waitForIdle();
    assert.match(f.posts[0]!.text,/Retry-After/);assert.match(f.posts[0]!.text,/UTC/);assert.ok(!f.posts[0]!.text.includes('PRIVATE_HEADER'));
    const date=/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} UTC/.exec(f.posts[0]!.text)?.[0];assert.ok(date);const suggested=Date.parse(date!.replace(' UTC','Z').replace(' ','T'));assert.ok(suggested>=started+120000&&suggested<=Date.now()+120000);
    await f.command('off');await f.session.prompt('local natural success after off');await f.session.waitForIdle();assert.equal(f.posts.length,1);assert.equal(calls,2);assert.equal(f.aborts,0);
  }finally{await f.close();}
},20000);


// Fault only the Slack SDK network boundary; run the actual plugin transport supervisor.
// Existing twelve tests retain their smaller transport seam. All agent events remain real.
async function socketBoundary(failures:number,body:(faults:{sockets:any[],starts:()=>number,httpCalls:string[]})=>Promise<void>){
  const saved=Object.fromEntries(transportMethods.map(name=>[name,SlackTransport.prototype[name]]));
  const originalStart=SocketModeClient.prototype.start,originalDisconnect=SocketModeClient.prototype.disconnect,originalApi=WebClient.prototype.apiCall;
  const sockets:any[]=[],httpCalls:string[]=[];let starts=0;
  for(const name of transportMethods)(SlackTransport.prototype as any)[name]=realTransportMethods[name];
  SlackTransport.prototype.start=async function(receive,disconnect,onState){const result=await realTransportMethods.start.call(this,receive,disconnect,onState);transports.set(this,{receive,disconnect});return result;};
  SlackTransport.prototype.stop=async function(){await realTransportMethods.stop.call(this);transports.delete(this);};
  SocketModeClient.prototype.start=async function(){sockets.push(this);starts++;if(starts>1&&starts<=failures+1)throw {code:'slack_webapi_request_error',original:{code:'ECONNRESET'}};this.emit('connected');return {ok:true};};
  SocketModeClient.prototype.disconnect=async function(){this.emit('disconnected');};
  WebClient.prototype.apiCall=async function(method,args){httpCalls.push(method);if(method==='auth.test')return {ok:true,team_id:'T123',user_id:'UBOT',bot_id:'BBOT'};
    if(method==='chat.postMessage'){posts.push({route:{team:'T123',channel:args.channel,thread:args.thread_ts,user:'UOWNER'},text:args.text});return {ok:true};}
    throw new Error(`Forbidden network method in fault fixture: ${method}`);
  };
  try{await body({sockets,starts:()=>starts,httpCalls});}finally{
    for(const name of transportMethods)(SlackTransport.prototype as any)[name]=saved[name];
    SocketModeClient.prototype.start=originalStart;SocketModeClient.prototype.disconnect=originalDisconnect;WebClient.prototype.apiCall=originalApi;
  }
}
test('real transport reconnect failures preserve active native tool and queued thread ownership without task replay',async()=>{
  await socketBoundary(1,async faults=>{
    const started=gate(),done=gate(),stats={signalAborts:0,totalTicks:150} as any;let calls=0;
    const f=await fixture('reconnect-native',context=>++calls===1?tool('fixture_effect'):response(`after reconnect:${requestOf(context)?.route.thread}`),{effect:(signal:AbortSignal,root:string)=>heartbeat(signal,root,started,done,stats)});
    f.evidence.heartbeat=stats;
    try{
      f.send('long bounded work','C111','1700000000.013001');await started.promise;
      f.send('second source stays natively queued','D333','1700000000.013002');await until(()=>f.session.getQueuedMessages().followUp.length===1,'second native source queued');
      faults.sockets[0].emit('close');await until(()=>f.notices.some(n=>n.includes('reconnecting automatically')),'reconnect transition');
      await f.command('status');const status=JSON.parse(f.notices.findLast(n=>n.startsWith('{"state"'))!);
      assert.equal(status.state,'on');assert.equal(status.connection.state,'reconnecting');assert.equal(f.aborts,0);assert.equal(stats.signalAborts,0);assert.equal(calls,1);
      await until(()=>faults.starts()===3&&[...transports.keys()][0]!.isReady(),'second reconnect attempt succeeds');
      assert.equal(calls,1);assert.equal(f.session.getQueuedMessages().followUp.length,1);process.kill(stats.pid,0);
      await done.promise;await f.session.waitForIdle();await until(()=>f.posts.length===2,'two preserved reply routes');
      assert.deepEqual(f.posts.map(p=>[p.route.channel,p.route.thread]),[['C111','1700000000.013001'],['D333','1700000000.013002']]);
      assert.equal(calls,3);assert.equal(stats.exit,0);assert.equal(stats.ticks,150);assert.equal(stats.signalAborts,0);assert.equal(f.aborts,0);
      assert.equal(f.events.filter(e=>e.type==='message_start'&&e.role==='user'&&e.text?.startsWith('[OMP Slack request')).length,2);
      f.evidence.socketFaults={starts:faults.starts(),rejectedReconnects:1,httpCalls:[...faults.httpCalls],posts:f.posts.length};
    }finally{await done.promise;await f.close();}
  });
},20000);
test('off during actual transport backoff cancels reconnect and preserves the running native subprocess',async()=>{
  await socketBoundary(10,async faults=>{
    const started=gate(),done=gate(),stats={signalAborts:0,totalTicks:40} as any;let calls=0;
    const f=await fixture('reconnect-off',()=>++calls===1?tool('fixture_effect'):response('revoked after off'),{effect:(signal:AbortSignal,root:string)=>heartbeat(signal,root,started,done,stats)});
    f.evidence.heartbeat=stats;
    try{f.send('work through offline stop');await started.promise;faults.sockets[0].emit('close');await until(()=>f.notices.some(n=>n.includes('reconnecting automatically')),'backoff entered');
      await f.command('off');assert.equal(f.aborts,0);assert.equal(transports.size,0);await done.promise;await f.session.waitForIdle();await Bun.sleep(100);
      assert.equal(faults.starts(),1);assert.equal(f.posts.length,0);assert.equal(stats.exit,0);assert.equal(stats.ticks,40);assert.equal(stats.signalAborts,0);assert.equal(f.aborts,0);
      f.evidence.socketFaults={starts:faults.starts(),httpCalls:[...faults.httpCalls],posts:f.posts.length};
    }finally{await done.promise;await f.close();}
  });
},20000);
