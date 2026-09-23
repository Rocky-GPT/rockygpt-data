import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertRawCollectionCandidate, buildRawPageFromHtml, collectRawDataset, replayRawSourceCapture } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';

const page = (statusCode = 200) => buildRawPageFromHtml({url:'https://example.edu/policy', html:'<main><h1>Policy</h1><p>Source content.</p></main>', sourceType:'seed', allowedHost:'example.edu',statusCode});
const dataset = (good: number, bad: number): RawDatasetV1 => ({ version:'1.0', dataset:'test', collectedAt:'2026-09-23T12:00:00Z', seedUrls:[], stats:{pagesFetched:good,pagesFailed:bad,externalLinksSeen:0},pages:[...Array.from({length:good},()=>page()),...Array.from({length:bad},()=>page(404))]});

test('structured lists and tables retain rows beyond the old truncation boundaries', () => {
  const result = buildRawPageFromHtml({url:'https://example.edu/policy',sourceType:'seed',allowedHost:'example.edu',html:`<main><h1>Requirements</h1><ul>${Array.from({length:45},(_,i)=>`<li>Condition ${i}</li>`).join('')}</ul><table><thead><tr><th>Deadline</th></tr></thead><tbody>${Array.from({length:65},(_,i)=>`<tr><td>Date ${i}</td></tr>`).join('')}</tbody></table></main>`});
  assert.equal(result.lists[0].length,45);
  assert.ok(result.tables[0].rows.some(row=>row.includes('Date 64')));
});

test('service action links retain labels and exact destinations inside scoped source content', () => {
  const result = buildRawPageFromHtml({url:'https://example.edu/health/',sourceType:'seed',allowedHost:'example.edu',
    html:`<title>Health Services</title><div><a href="/unrelated">Other site links</a></div>
      <main><h1>Health Services</h1><nav><a href="/navigation">Menu link</a></nav>
      <h2>Appointments</h2><p>Use the <a href="https://portal.example.edu/book?service=health#new">appointment portal</a> to book.</p>
      <h2>Reporting</h2><a href="/report#student">Reporting Portal</a>
      <h3>Forms</h3><ul><li><a href="/forms/consent.pdf">Consent form</a></li></ul>
      <table><tr><th>Action</th></tr><tr><td><a href="/vaccine">Vaccine booking</a></td></tr></table>
      <p><a href="tel:2015550101">Call us</a> <a href="mailto:health@example.edu">Email us</a></p>
      <a href="/access" aria-label="Accessible services"><img src="icon.png"></a>
      </main><footer><a href="/footer">Footer link</a></footer>`});
  assert.ok(result.sections.some(section => section.heading === 'Appointments'
    && section.text === 'Use the appointment portal (https://portal.example.edu/book?service=health#new) to book.'));
  assert.ok(result.sections.some(section => section.heading === 'Reporting'
    && section.text === 'Reporting Portal (https://example.edu/report#student)'));
  assert.deepEqual(result.lists, [['Consent form (https://example.edu/forms/consent.pdf)']]);
  assert.ok(result.tables[0].rows.some(row => row.includes('Vaccine booking (https://example.edu/vaccine)')));
  assert.ok(result.sections.some(section => section.text.includes('Accessible services (https://example.edu/access)')));
  assert.deepEqual(result.documents, [{label:'Consent form',url:'https://example.edu/forms/consent.pdf'}]);
  assert.ok(result.contacts.some(contact => contact.email === 'health@example.edu'));
  assert.ok(result.contacts.some(contact => contact.phone === '2015550101'));
  assert.doesNotMatch(JSON.stringify(result), /unrelated|navigation|Footer link/);
  // Discovery URLs stay fragment-free so section anchors do not trigger duplicate fetches.
  assert.ok(result.links.includes('https://example.edu/report'));
  assert.ok(!result.links.some(link => link.includes('#')));
});

test('sidebar noise headings do not swallow the following main-column service action', () => {
  const result = buildRawPageFromHtml({url:'https://example.edu/health/',sourceType:'seed',allowedHost:'example.edu',
    html:`<h1></h1><h1>Health Services</h1><main><div id="left-nav">
      <ul id="left-nav-ul"><li><a href="/detail">Sidebar navigation</a></li></ul>
      <h3>Office</h3><p><a href="tel:2015550101">201-555-0101</a></p>
      <h3>Related Resources</h3><p><a href="/related">Related resource</a></p></div>
      <div id="content-block"><p>Published service partnership and eligibility.</p>
      <a href="https://provider.example/clinic">View clinical services</a></div></main>`});
  assert.ok(result.sections.some(section => section.heading === 'Health Services'
    && section.text.includes('View clinical services (https://provider.example/clinic)')));
  assert.ok(result.sections.find(section => section.heading === 'Related Resources')?.text.includes('Related resource'));
  assert.ok(!result.sections.some(section => section.text.includes('Sidebar navigation')));
  assert.ok(result.links.includes('https://example.edu/detail'));
  assert.ok(result.contacts.some(contact => contact.phone === '2015550101'));
});

test('FAQ disclosure labels remain attached to their answers', () => {
  const result = buildRawPageFromHtml({url:'https://example.edu/health/',sourceType:'seed',allowedHost:'example.edu',
    html:`<main><h1>Health Services</h1><h2>Services FAQ</h2>
      <div class="collapsableTitle">Are students required to have health insurance?</div>
      <div class="collapsableContent"><p>Yes. The College requires that all students have health insurance.</p></div>
      <details><summary>Will the provider bill my insurance?</summary><p>Medical services are billed to your insurance company.</p></details>
      <div role="heading" aria-level="3">Where can I book?</div><p><a href="/booking">Book an appointment</a></p></main>`});
  assert.deepEqual(result.sections.map(section => section.heading), ['Are students required to have health insurance?',
    'Will the provider bill my insurance?', 'Where can I book?']);
  assert.match(result.sections[0].text, /^Yes\. The College requires/);
  assert.match(result.sections[1].text, /^Medical services are billed/);
  assert.match(result.sections[2].text, /Book an appointment \(https:\/\/example.edu\/booking\)/);
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

test('opt-in source capture retains original HTML and its hash even when collection validation fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-raw-source-'));
  const original = globalThis.fetch;
  const html = '<main><h1>Health</h1><p><a href="/book">Appointment portal</a></p></main>';
  globalThis.fetch = async () => new Response(html, {headers:{'content-type':'text/html'}});
  try {
    await assert.rejects(() => collectRawDataset({dataset:'health',seedUrls:['https://example.edu/health'],
      allowedHost:'example.edu',outputPath:path.join(dir,'health.raw.json'),attempts:1,maxDetailPages:0,
      minimumSuccessfulPages:2,retainSourceHtml:true}), /expected at least 2/);
    assert.ok(!fs.existsSync(path.join(dir,'health.raw.json')));
    const capture = JSON.parse(fs.readFileSync(path.join(dir,'health-sources.raw.json'),'utf8'));
    assert.equal(capture.schemaVersion,1);
    assert.equal(capture.pages.length,1);
    assert.equal(capture.pages[0].html,html);
    assert.equal(capture.pages[0].contentHash,createHash('sha256').update(html).digest('hex'));
    assert.equal(capture.pages[0].requestedUrl,'https://example.edu/health');
    assert.equal(capture.pages[0].statusCode,200);
    assert.equal(capture.pages[0].sourceType,'seed');
    assert.ok(fs.existsSync(path.join(dir,'health-sources.provenance.json')));
    const replayed = replayRawSourceCapture(capture);
    assert.equal(replayed.pages[0].fetchedAt,capture.pages[0].fetchedAt);
    assert.equal(replayed.collectedAt,capture.generatedAt);
    assert.ok(replayed.pages[0].sections[0].text.includes('Appointment portal (https://example.edu/book)'));
    capture.pages[0].html += 'changed';
    assert.throws(() => replayRawSourceCapture(capture), /hash mismatch/);
  } finally { globalThis.fetch=original; fs.rmSync(dir,{recursive:true,force:true}); }
});
