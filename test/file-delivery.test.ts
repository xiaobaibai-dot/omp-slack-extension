import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createHash} from "node:crypto";
import {SlackBridge} from "../src/bridge.ts";
import {makeSlackTools} from "../src/slack-tools.ts";
import {z} from "zod";
import {config,FakeTransport,host,envelope,settle} from "./helpers.ts";

test("registered download/upload tools deliver a requested attachment via new nested paths to the source thread",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"omp-slack-file-delivery-"));
  const temp=await fs.realpath(os.tmpdir()),actual=await fs.realpath(root),relative=path.relative(temp,actual);
  assert.ok(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative));
  const bytes=Buffer.from("OMP tool delivery fixture\n");
  const transport=new FakeTransport();let uploaded:Buffer|undefined;
  const fileTransport=Object.assign(transport,{download:async(route:any,id:string)=>{assert.equal(route.channel,"D111");assert.equal(id,"F111");return {bytes,filename:"fixture.txt"};}});
  transport.upload=async(route,content,filename)=>{uploaded=Buffer.from(content);transport.uploads.push({route,filename});return {fileId:"FOUTPUT"};};
  const bridge=new SlackBridge(config({cwd:root,uploadMode:"host"}),host(),()=>fileTransport,async(input,c)=>{
    assert.deepEqual(input.job.files,[{id:"F111",name:"fixture.txt"}]);
    const tools=makeSlackTools(z as any,c);
    const download=tools.find(t=>t.name==="slack_download_file")!,upload=tools.find(t=>t.name==="slack_upload_file")!;
    assert.equal(download.approval,"write");assert.equal(upload.approval,"write");
    const output=await download.execute("fixture-download",{file_id:"F111",target_path:"new/subdir/fixture.txt"},undefined as any,undefined as any,undefined as any);
    const delivered=JSON.parse((output.content[0] as any).text);
    assert.equal(delivered.bytes,bytes.length);assert.equal(delivered.sha256,createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(await fs.readFile(delivered.path),bytes);
    const uploadOutput=await upload.execute("fixture-upload",{relative_path:delivered.path},undefined as any,undefined as any,undefined as any);
    assert.deepEqual(JSON.parse((uploadOutput.content[0] as any).text),{uploaded:true,fileId:"FOUTPUT"});
    return "file delivery completed";
  });
  try {
    const body=envelope("EvDelivery","D111","download and return this file") as any;
    body.event.subtype="file_share";body.event.files=[{id:"F111",name:"fixture.txt"}];
    await bridge.start();bridge.accept(body);
    for(let i=0;i<100&&bridge.status().busy;i++)await new Promise(resolve=>setTimeout(resolve,5));await settle();
    assert.deepEqual(uploaded,bytes);assert.equal(transport.uploads.length,1);
    assert.equal(transport.uploads[0]?.route.channel,"D111");assert.equal(transport.uploads[0]?.route.thread,body.event.ts);
  } finally {await bridge.stop();await fs.rm(root,{recursive:true,force:true});}
});
