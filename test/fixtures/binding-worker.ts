import readline from "node:readline";
import {LocalBinding} from "../../src/binding.ts";
const send=(type:string)=>process.stdout.write(JSON.stringify({type})+"\n");
const [key,namespace]=process.argv.slice(2);
if(!key||!namespace)throw new Error("Missing fixture namespace");
const binding=await LocalBinding.acquire({key,namespace,onTakeover:async()=>{
  send("revoked");await new Promise(resolve=>setTimeout(resolve,50));send("closed");
}});
send("owned");
readline.createInterface({input:process.stdin}).on("line",line=>{
  if(line==="release")void binding.release().then(()=>{send("released");process.exit(0);});
});
