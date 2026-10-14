import type { Config, Host, Job, Route, Transport } from "../src/types.ts";
export function config(overrides: Partial<Config> = {}): Config {
  return {appToken:"xapp-FAKE", botToken:"xoxb-FAKE", teamId:"T123", appId:"A123", owners:new Set(["UOWNER"]), channels:new Set(), localTools:[], maxQueue:32, maxTaskMs:60_000, ...overrides};
}
export function envelope(id = "Ev1", channel = "C111", text = "hello", user = "UOWNER", thread?: string): unknown {
  return {type:"event_callback", team_id:"T123", api_app_id:"A123", event_id:id, event:{type:channel.startsWith("D") ? "message" : "app_mention", channel_type:channel.startsWith("D") ? "im" : "channel", channel, ts:`${Math.floor(Date.now()/1000)}.000001`, user, text, ...(thread ? {thread_ts:thread}: {})}};
}
export function job(id = "Ev1", channel = "C111"): Job {
  return {id, ts:"1720000000.000001", text:"hello", route:{team:"T123", channel, thread:"1720000000.000001", user:"UOWNER"}};
}
export class FakeTransport implements Transport {
  onEvent?: (body: unknown) => void;
  starts = 0; stops = 0;
  posts: {route:Route; text:string}[] = [];
  uploads: {route:Route; filename:string}[] = [];
  reads: Route[] = [];
  startGate?: Promise<void>;
  postGate?: Promise<void>;
  async start(onEvent:(body:unknown)=>void) { this.starts++; this.onEvent = onEvent; await this.startGate; return {teamId:"T123",botUserId:"UBOT"}; }
  async stop() { this.stops++; }
  async post(route:Route,text:string) { this.posts.push({route,text}); await this.postGate; }
  async readThread(route:Route) { this.reads.push(route); return {messages:[{user:"UOWNER",text:"reference",ts:route.thread}],truncated:false}; }
  async upload(route:Route,_content:Buffer,filename:string) { this.uploads.push({route,filename}); }
  async list() { return {conversations:[{id:"CPRIVATE",name:"private name",isPrivate:true,isIm:false}]}; }
}
export function host(): Host & {idle:boolean; notifications:string[]} {
  return {idle:true,notifications:[],canRun(){return this.idle;},notify(message){this.notifications.push(message);}};
}
export function deferred<T>() { return Promise.withResolvers<T>(); }
export async function settle() { for (let i=0;i<5;i++) await new Promise<void>(resolve=>setImmediate(resolve)); }
