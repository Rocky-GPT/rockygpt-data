import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRawGates, runRawGate } from '../../scripts/database/quality-gates';

test('raw structural validation does not mistake filesystem mtime for source collection age',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rocky-raw-age-'));
  try {
    const gate=buildRawGates(root).find(g=>g.name==='clubs-detail.raw.json')!;
    fs.mkdirSync(path.dirname(gate.filePath),{recursive:true});
    const collectedAt='2026-09-23T12:00:00Z';
    const pages=Array.from({length:10},(_,i)=>({url:`https://archway.ramapo.edu/club${i}/home/`,sourceType:'detail',fetchedAt:collectedAt,statusCode:200,title:'Club',links:[],externalLinks:[],sections:[],lists:[],tables:[],contacts:[],documents:[]}));
    fs.writeFileSync(gate.filePath,JSON.stringify({version:'1.0',dataset:'clubs-detail',collectedAt,seedUrls:[],stats:{pagesFetched:10,pagesFailed:0,externalLinksSeen:0},pages}));
    fs.utimesSync(gate.filePath,0,0);
    const errors:string[]=[];runRawGate(gate,errors);assert.deepEqual(errors,[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
