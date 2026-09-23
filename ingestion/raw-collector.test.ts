import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRawCollectionCandidate, buildRawPageFromHtml, collectRawDataset } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';

const page = (statusCode = 200) => buildRawPageFromHtml({url:'https://example.edu/policy', html:'<main><h1>Policy</h1><p>Source content.</p></main>', sourceType:'seed', allowedHost:'example.edu',statusCode});
const dataset = (good: number, bad: number): RawDatasetV1 => ({ version:'1.0', dataset:'test', collectedAt:'2026-09-23T12:00:00Z', seedUrls:[], stats:{pagesFetched:good,pagesFailed:bad,externalLinksSeen:0},pages:[...Array.from({length:good},()=>page()),...Array.from({length:bad},()=>page(404))]});

test('structured lists and tables retain rows beyond the old truncation boundaries', () => {
  const result = buildRawPageFromHtml({url:'https://example.edu/policy',sourceType:'seed',allowedHost:'example.edu',html:`<main><h1>Requirements</h1><ul>${Array.from({length:45},(_,i)=>`<li>Condition ${i}</li>`).join('')}</ul><table><thead><tr><th>Deadline</th></tr></thead><tbody>${Array.from({length:65},(_,i)=>`<tr><td>Date ${i}</td></tr>`).join('')}</tbody></table></main>`});
  assert.equal(result.lists[0].length,45);
  assert.ok(result.tables[0].rows.some(row=>row.includes('Date 64')));
});

test('collection regression measures successful pages, not old failed document requests', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rocky-raw-regression-'));
  try {
    const outputPath=path.join(dir,'test.raw.json');
    fs.writeFileSync(outputPath,JSON.stringify(dataset(22,18)));
    assert.doesNotThrow(()=>assertRawCollectionCandidate(dataset(22,0),{outputPath,minimumPreviousPageRatio:0.6}));
    assert.throws(()=>assertRawCollectionCandidate(dataset(10,30),{outputPath,minimumPreviousPageRatio:0.6}),/successful page count dropped/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('HTML crawl retains document links without fetching them or fetching another seed twice', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rocky-raw-crawl-'));
  const original=globalThis.fetch;
  const requested:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);requested.push(url);
    return new Response('<main><h1>Source</h1><a href="/policy.pdf">Policy PDF</a><a href="/other">Other seed</a><a href="/detail">Details</a></main>',{headers:{'content-type':'text/html'}});
  };
  try {
    const result=await collectRawDataset({dataset:'test',seedUrls:['https://example.edu/','https://example.edu/other'],allowedHost:'example.edu',outputPath:path.join(dir,'test.raw.json'),attempts:1,minimumSuccessfulPages:3});
    assert.deepEqual(requested.sort(),['https://example.edu/','https://example.edu/detail','https://example.edu/other']);
    assert.ok(result.pages[0].documents.some(document=>document.url.endsWith('/policy.pdf')));
    assert.ok(fs.existsSync(path.join(dir,'test.provenance.json')));
  } finally {globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
});
