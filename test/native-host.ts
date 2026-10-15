import type {Capabilities, Job} from "../src/types.ts";
import {job} from "./helpers.ts";
/** Protocol fixture for public AgentSession APIs; no Slack/model/network calls. */
export class NativeHost {
  messages: any[] = [{role:"user",content:"local initial context"}];
  isStreaming = true; abortCalls = 0; sessionId = "session-one";
  followUp: string[] = [];steering: string[] = [];liveSteered = 0;
  submissions: {text:string; options:any}[] = [];
  listener: (event:any)=>void = () => {}; unsubscribed=0;
  beforeAdmission?: Promise<void>;afterAdmission?: Promise<void>;
  idleStarted = 0; removed: {text:string;queue:string}[]=[];
  subscribe(listener:(event:any)=>void) {this.listener=listener;return()=>{this.unsubscribed++;this.listener=()=>{};};}
  async prompt(text:string,options:any) {
    const sessionId=this.sessionId;this.submissions.push({text,options});await this.beforeAdmission;
    if(sessionId!==this.sessionId) throw new Error("native session generation changed");
    const wasBusy=this.isStreaming;
    if(wasBusy) {
      (options.streamingBehavior==="steer"?this.steering:this.followUp).push(text);
      options.onPromptAdmitted?.();this.queueChanged();return true;
    }
    this.isStreaming=true;options.onPromptAdmitted?.();await this.afterAdmission;
    if(sessionId!==this.sessionId) throw new Error("native idle preflight dropped after session switch");
    this.idleStarted++;this.consume([text]);return true;
  }
  getQueuedMessages() {return {followUp:[...this.followUp],steering:[...this.steering],liveSteered:this.liveSteered};}
  removeQueuedMessage(text:string,queue:"steering"|"followUp") {
    this.removed.push({text,queue});const index=this[queue].indexOf(text);
    if(index<0)return false;this[queue].splice(index,1);this.queueChanged();return true;
  }
  async abort() {this.abortCalls++;throw new Error("A native-channel integration must never abort the main session");}
  queueChanged() {this.listener({type:"queue_update",...this.getQueuedMessages()});}
  consume(texts:string[],live=false) {
    this.isStreaming=true;this.listener({type:"turn_start"});
    for(const text of texts) {
      for(const q of [this.followUp,this.steering]) {const index=q.indexOf(text);if(index>=0)q.splice(index,1);}
      this.liveSteered=0;this.queueChanged();
      const message={role:"user",content:[{type:"text",text}],...(live?{liveSteered:true}:{})};
      this.messages.push(message);this.listener({type:"message_start",message});this.listener({type:"message_end",message});
    }
  }
  local(text="private terminal input",emit=true,custom=false) {
    const message=custom?{role:"custom",attribution:"user",content:text}:{role:"user",content:text};
    this.messages.push(message);if(emit)this.listener({type:"message_start",message});
  }
  answer(text="answer",terminal=false,stopReason="stop",tool=false,stopDetails?:{type:string}) {
    const message={role:"assistant",stopReason,...(stopDetails?{stopDetails}:{}),content:[{type:"text",text},...(tool?[{type:"toolCall",id:"tool1",name:"wait"}]:[])]};
    this.listener({type:"message_start",message});this.messages.push(message);this.listener({type:"message_end",message});
    this.listener({type:"turn_end",message,toolResults:[]});if(terminal)this.end();
  }
  end(terminal=true) {this.isStreaming=!terminal;this.listener({type:"agent_end",isTerminal:terminal,messages:this.messages});}
  switchSession() {this.sessionId="session-two";this.followUp=[];this.steering=[];this.messages=[];this.isStreaming=false;}
}
export function input(id:string,delivery:Job["delivery"]="followUp",channel="C111") {return {requestId:id,job:{...job(`Ev${id}`,channel),delivery},history:[]};}
export function caps() {
  const replies:string[]=[];
  const capabilities:Capabilities={reply:async text=>{replies.push(text);},readThread:async()=>({messages:[],truncated:false}),
    upload:async()=>{},listConversations:async()=>({conversations:[],scope:"fixture"})};
  return {capabilities,replies};
}
