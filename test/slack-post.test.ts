import test from "node:test";
import assert from "node:assert/strict";
import {SocketModeClient} from "@slack/socket-mode";
import {WebClient} from "@slack/web-api";
import {SlackTransport} from "../src/slack-transport.ts";
import {slackText} from "../src/security.ts";
import {config,job} from "./helpers.ts";

test("canonical user mentions survive formatting; escaped literal text stays literal",()=>{
  assert.equal(slackText("<@U123> hello & <tag>"),"<@U123> hello &amp; &lt;tag&gt;");
  assert.equal(slackText("&lt;@U123&gt;"),"&amp;lt;@U123&amp;gt;");
  assert.equal(slackText("<@W123> <!channel>"),"<@W123> &lt;!channel&gt;");
});
test("transport sends a real mrkdwn user-ID mention to the original thread without plain-text blocks",async()=>{
  const call=WebClient.prototype.apiCall,start=SocketModeClient.prototype.start,disconnect=SocketModeClient.prototype.disconnect;
  const posts:any[]=[];
  WebClient.prototype.apiCall=async function(method:string,args:any){
    if(method==="auth.test")return {ok:true,team_id:"T123",user_id:"UBOT",bot_id:"B123"};
    if(method==="chat.postMessage"){posts.push(args);return {ok:true};}
    throw new Error("Unexpected API call in offline fixture");
  } as typeof call;
  SocketModeClient.prototype.start=async function(this: SocketModeClient){this.emit("connected");return {ok:true};} as typeof start;
  SocketModeClient.prototype.disconnect=async function(){};
  const transport=new SlackTransport(config());
  try {
    await transport.start(()=>{});
    await transport.post(job().route,"<@U123> requested reply");
    assert.equal(posts.length,1);
    assert.equal(posts[0].text,"<@U123> requested reply");
    assert.equal(posts[0].mrkdwn,true);assert.equal(posts[0].parse,"none");
    assert.equal(posts[0].channel,"C111");assert.equal(posts[0].thread_ts,job().route.thread);
    assert.equal(posts[0].blocks,undefined);
  } finally {
    await transport.stop();WebClient.prototype.apiCall=call;SocketModeClient.prototype.start=start;SocketModeClient.prototype.disconnect=disconnect;
  }
});
