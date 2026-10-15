// Copy only checked-out plugin source, never credentials/config/workspace data.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const files=['index.ts',...(await fs.readdir(path.join(root,'src'))).filter(name=>name.endsWith('.ts')).map(name=>`src/${name}`)];
const hashes={};
for(const file of files){const source=path.join(root,file);if(!(await fs.lstat(source)).isFile())throw Error(`Not a regular source file: ${file}`);const bytes=await fs.readFile(source);const target=path.join(here,'candidate',file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);hashes[file]=createHash('sha256').update(bytes).digest('hex');}
let gitCommit='unavailable';try{gitCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
await fs.writeFile(path.join(here,'candidate/source.json'),JSON.stringify({gitCommit,hashes},null,2));
