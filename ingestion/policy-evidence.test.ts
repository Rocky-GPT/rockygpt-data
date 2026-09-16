import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRawPageFromHtml } from './raw-collector';
import { generateCore6Markdown } from './generate-core6-md-utils';
import { chunkDocumentSections } from '../src/data-v2/document-text';

test('policy qualifiers, timelines, source identity and original collection time survive ingestion', () => {
  const collectedAt = '2026-09-16T18:00:00Z';
  const paragraphs = Array.from({length: 9}, (_, i) => `<p>Condition ${i}: ${'published detail '.repeat(30)}</p>`).join('');
  const page = buildRawPageFromHtml({
    url: 'https://www.ramapo.edu/example/policy/', sourceType: 'seed',
    fetchedAt: collectedAt, allowedHost: 'www.ramapo.edu',
    html: `<main><h1>Policy</h1><div>${paragraphs}</div><h2>Exceptions</h2>
      <p>Current students must request approval. Final condition after the old truncation boundary.</p>
      <table><tr><th>Deadline</th><th>Applies to</th></tr><tr><td>September 7, 2026</td><td>Fall residents</td></tr></table>
      <h2>Other</h2><p>A separate section must retain its own heading.</p></main>`,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rocky-evidence-'));
  try {
    const inputFilePath = path.join(dir,'input.json');
    const outputFilePath = path.join(dir,'output.md');
    fs.writeFileSync(inputFilePath,JSON.stringify({version:'1.0',dataset:'test',collectedAt,
      seedUrls:[page.url],stats:{pagesFetched:1,pagesFailed:0,externalLinksSeen:0},pages:[page]}));
    generateCore6Markdown({datasetName:'test',title:'Test',description:'Policy evidence',
      inputFilePath,outputFilePath,frontmatter:{source_url:page.url,title:'Test',trust_tier:'official_primary',freshness_sla_hours:168}});
    const chunks = chunkDocumentSections(fs.readFileSync(outputFilePath,'utf8'));
    const text = chunks.map(c=>c.content).join('\n');
    assert.match(text,/Condition 8/);
    assert.match(text,/Final condition after the old truncation boundary/);
    assert.match(text,/September 7, 2026 \| Fall residents/);
    const policyChunks = chunks.filter(c => c.canonicalUrl === page.url);
    assert.ok(policyChunks.length > 3);
    assert.ok(policyChunks.every(c=>c.collectedAt === collectedAt && c.content.length <= 1250));
    assert.ok(policyChunks.some(c=>c.headingPath?.endsWith('Exceptions')));
    assert.doesNotMatch(text, /Collected At:/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
