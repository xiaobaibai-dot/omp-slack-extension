import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readConfig } from "../src/config.ts";
import { parseEvent, plainText, readUpload, safeError } from "../src/security.ts";
import { config, envelope } from "./helpers.ts";

test("missing owner configuration denies before tokens or network", () => {
  assert.throws(()=>readConfig({}), /Default deny/);
  assert.throws(()=>readConfig({OMP_SLACK_OWNER_IDS:"someone"}), /Default deny/);
});
test("configuration ignores obsolete local-tool overrides and rejects malformed IDs",()=>{
  const env = {OMP_SLACK_OWNER_IDS:"UOWNER", OMP_SLACK_APP_TOKEN:"xapp-FAKE", OMP_SLACK_BOT_TOKEN:"xoxb-FAKE", OMP_SLACK_TEAM_ID:"T123", OMP_SLACK_APP_ID:"A123"};
  assert.deepEqual(readConfig(env).localTools, []);
  assert.deepEqual(readConfig({...env,OMP_SLACK_LOCAL_TOOLS:"task,eval"}).localTools, []);
  assert.throws(()=>readConfig({...env,OMP_SLACK_CHANNEL_IDS:"#general"}), /Invalid/);
});
test("app mentions and true 1:1 IMs normalize to immutable source thread",()=>{
  const mention = parseEvent(envelope("Ev1","G123","<@UBOT> hello","UOWNER","1720000000.000009"), config(), "UBOT")!;
  assert.equal(mention.text,"hello"); assert.equal(mention.route.thread,"1720000000.000009");
  assert.equal(Object.isFrozen(mention.route),true);
  assert.equal(parseEvent(envelope("Ev2","D123"),config(),"UBOT")?.route.channel,"D123");
});
test("unauthorized identities, workspaces, apps, edits and non-DM message events never become jobs",()=>{
  const base = envelope() as Record<string,unknown>;
  const event = base.event as Record<string,unknown>;
  const variants = [ {...base,team_id:"TOTHER"}, {...base,api_app_id:"AOTHER"}, {...base,event:{...event,user:"UOTHER"}},
    {...base,event:{...event,user:"UBOT"}}, {...base,event:{...event,subtype:"message_changed"}},
    {...base,event:{...event,type:"message",channel_type:"channel"}}, {...base,event:{...event,type:"message",channel_type:"mpim",channel:"G123"}},
    {...base,event:{...event,thread_ts:"bad"}}, {...base,event:{...event,text:"x".repeat(12001)}} ];
  for(const payload of variants) assert.equal(parseEvent(payload,config(),"UBOT"),undefined);
  assert.equal(parseEvent(base,config({channels:new Set(["COTHER"])}),"UBOT"),undefined);
});
test("mention escaping blocks Slack special mentions; errors do not reveal tokens",()=>{
  assert.equal(plainText("<!channel> <@U123> &"),"&lt;!channel&gt; &lt;@U123&gt; &amp;");
  assert.equal(safeError({code:"xoxb-SECRET",message:"token"}),"operation_failed");
});
test("installation authorization must match the authenticated outbound bot for both mentions and DMs",()=>{
  for (const channel of ["C111", "D111"]) {
    const body = envelope("EvAuth", channel) as Record<string, unknown>;
    assert.ok(parseEvent(body, config(), "UBOT"));
    for (const authorizations of [undefined, [], [{team_id:"T123",user_id:"UOTHERBOT",is_bot:true}],
      [{team_id:"TOTHER",user_id:"UBOT",is_bot:true}], [{team_id:"T123",user_id:"UBOT",is_bot:false}]]) {
      assert.equal(parseEvent({...body, authorizations}, config(), "UBOT"), undefined);
    }
  }
});
test("explicit member-open channel admits another human while other channels and DMs still require owners",()=>{
  const c=config({channels:new Set(["C111","D111"]),channelAllUsers:new Set(["C111"])});
  assert.ok(parseEvent(envelope("EvMember","C111","request","UOTHER"),c,"UBOT"));
  assert.equal(parseEvent(envelope("EvOtherChannel","C222","request","UOTHER"),c,"UBOT"),undefined);
  assert.equal(parseEvent(envelope("EvOtherDm","D111","request","UOTHER"),c,"UBOT"),undefined);
});
test("member-open channel accepts bot mentions including self mentions; ordinary channel bot replies are not requests",()=>{
  const c=config({channels:new Set(["C111"]),channelAllUsers:new Set(["C111"])});
  for(const user of ["UOTHERBOT","UBOT"]) {
    const body=envelope("EvBot","C111","<@UBOT> request",user) as any;
    body.event.bot_id="B123";body.event.bot_profile={id:"B123"};body.event.subtype="bot_message";
    assert.ok(parseEvent(body,c,"UBOT"));
    assert.equal(parseEvent({...body,event:{...body.event,type:"message",channel_type:"channel"}},c,"UBOT"),undefined);
    delete body.event.user;
    assert.equal(parseEvent(body,c,"UBOT")?.route.user,"B123");
  }
});
test("requested human file-share DM retains attached file IDs for the bound main conversation",()=>{
  const body=envelope("EvFile","D111","download this file") as any;
  body.event.subtype="file_share";body.event.files=[{id:"F111",name:"fixture.txt",url_private:"not forwarded"}];
  const parsed=parseEvent(body,config(),"UBOT");
  assert.deepEqual(parsed?.files,[{id:"F111",name:"fixture.txt"}]);
  assert.equal(parseEvent({...body,event:{...body.event,files:[]}},config(),"UBOT"),undefined);
});
test("uploads require explicit root and reject traversal, hidden files, symlink escapes, and oversize files",async()=>{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),"slack-upload-"));
  try {
    const root=path.join(temp,"outputs"); await fs.mkdir(root);
    await fs.writeFile(path.join(root,"report.txt"),"report"); await fs.writeFile(path.join(temp,"secret.txt"),"secret");
    await fs.writeFile(path.join(root,".env"),"secret");
    assert.equal((await readUpload(root,"report.txt")).bytes.toString(),"report");
    for(const name of ["../secret.txt","..\\secret.txt","C:\\secret.txt",".env"]) await assert.rejects(readUpload(root,name));
    await assert.rejects(readUpload(undefined,"report.txt"));
    if(process.platform !== "win32") { await fs.symlink(path.join(temp,"secret.txt"),path.join(root,"leak.txt")); await assert.rejects(readUpload(root,"leak.txt")); }
    const large=await fs.open(path.join(root,"large.bin"),"w"); await large.truncate(10*1024*1024+1); await large.close();
    await assert.rejects(readUpload(root,"large.bin"),/10 MiB/);
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});
