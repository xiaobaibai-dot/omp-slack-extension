import test from "node:test";
import assert from "node:assert/strict";
import {sourceFile} from "../src/download.ts";
import {job} from "./helpers.ts";
const route=job().route;
const info=()=>Promise.resolve({ok:true,file:{id:"F111",name:"fixture.txt",size:3,channels:[route.channel],url_private_download:"https://files.slack.com/files-pri/fixture.txt"}});
test("source download returns exact bytes and file name",async()=>{
 const file=await sourceFile(info,async()=>new Response("abc"),route,"F111",new AbortController().signal,()=>{});
 assert.equal(file.bytes.toString(),"abc");assert.equal(file.filename,"fixture.txt");
});
test("file shared elsewhere is refused before any credentialed download",async()=>{
 let calls=0;
 await assert.rejects(sourceFile(async()=>({ok:true,file:{...(await info()).file,channels:["COTHER"]}}),async()=>{calls++;return new Response("abc");},route,"F111",new AbortController().signal,()=>{}),/source conversation/);
 assert.equal(calls,0);
});
test("foreign download host is refused before sending a bearer token",async()=>{
 let calls=0;
 await assert.rejects(sourceFile(async()=>({ok:true,file:{...(await info()).file,url_private_download:"https://example.org/fixture.txt"}}),async()=>{calls++;return new Response("abc");},route,"F111",new AbortController().signal,()=>{}),/destination/);
 assert.equal(calls,0);
});
test("off during metadata read prevents subsequent byte download",async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(sourceFile(async()=>{controller.abort();return info();},async()=>{calls++;return new Response("abc");},route,"F111",controller.signal,()=>{}));
 assert.equal(calls,0);
});
test("download refuses metadata size mismatch instead of saving incomplete bytes",async()=>{
 await assert.rejects(sourceFile(info,async()=>new Response("abcd"),route,"F111",new AbortController().signal,()=>{}),/size did not match/);
});
