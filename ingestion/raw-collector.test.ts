import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {assertRawCollectionCandidate, buildRawPageFromHtml, collectRawDataset, createRequestPacer, isLikelyChallengeHtml, replayRawSourceCapture, sourceHtml, isMismatchedMailto, isPhoneNumber, withYear} from './raw-collector';
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

test('a source that narrows what it collects compares only the previous pages it still collects', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rocky-raw-narrowed-'));
  try {
    const outputPath=path.join(dir,'test.raw.json');
    const previous=dataset(30,0);
    previous.pages.forEach((entry,index)=>{entry.url=`https://example.edu/${index<22?'stories':'dept'}/${index}/`;});
    fs.writeFileSync(outputPath,JSON.stringify(previous));
    const inScope=(entry:{url:string})=>!entry.url.includes('/stories/');
    assert.throws(()=>assertRawCollectionCandidate(dataset(8,0),{outputPath,minimumPreviousPageRatio:0.8}),/dropped from 30 to 8/);
    assert.doesNotThrow(()=>assertRawCollectionCandidate(dataset(8,0),{outputPath,minimumPreviousPageRatio:0.8,comparablePreviousPage:inScope}));
    assert.throws(()=>assertRawCollectionCandidate(dataset(5,0),{outputPath,minimumPreviousPageRatio:0.8,comparablePreviousPage:inScope}),/dropped from 8 to 5/);
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
    let capture = JSON.parse(fs.readFileSync(path.join(dir,'health-sources.raw.json'),'utf8'));
    assert.equal(capture.schemaVersion,1);
    assert.equal(capture.pages.length,1);
    assert.equal(capture.pages[0].html,html);
    assert.equal(capture.pages[0].contentHash,createHash('sha256').update(html).digest('hex'));
    assert.equal(capture.pages[0].requestedUrl,'https://example.edu/health');
    assert.equal(capture.pages[0].statusCode,200);
    assert.equal(capture.pages[0].sourceType,'seed');
    assert.equal(capture.collectionSucceeded,false);
    assert.throws(() => replayRawSourceCapture(capture), /incomplete or failed/);
    assert.ok(fs.existsSync(path.join(dir,'health-sources.provenance.json')));
    const collected = await collectRawDataset({dataset:'health',seedUrls:['https://example.edu/health'],
      allowedHost:'example.edu',outputPath:path.join(dir,'health.raw.json'),attempts:1,maxDetailPages:0,
      minimumSuccessfulPages:1,retainSourceHtml:true});
    capture = JSON.parse(fs.readFileSync(path.join(dir,'health-sources.raw.json'),'utf8'));
    assert.equal(capture.collectionSucceeded,true);
    const replayed = replayRawSourceCapture(capture);
    assert.equal(replayed.pages[0].fetchedAt,capture.pages[0].fetchedAt);
    assert.equal(replayed.pages[0].fetchedAt,collected.pages[0].fetchedAt);
    assert.equal(replayed.collectedAt,capture.generatedAt);
    assert.ok(replayed.pages[0].sections[0].text.includes('Appointment portal (https://example.edu/book)'));
    capture.pages[0].html += 'changed';
    assert.throws(() => replayRawSourceCapture(capture), /hash mismatch/);
  } finally { globalThis.fetch=original; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('the request pacer spaces request starts, including concurrent ones', async () => {
  let now = 1_000;
  const starts: number[] = [];
  const pace = createRequestPacer(1_000, { now: () => now, sleep: async ms => { now += ms; } });
  await pace(); starts.push(now);
  now += 200;
  await pace(); starts.push(now);
  now += 5_000;
  await pace(); starts.push(now);
  assert.deepEqual(starts, [1_000, 2_000, 7_000]);

  let clock = 0;
  const waits: number[] = [];
  const concurrent = createRequestPacer(500, { now: () => clock, sleep: async ms => { waits.push(ms); } });
  await Promise.all([concurrent(), concurrent(), concurrent()]);
  assert.deepEqual(waits, [500, 1_000]);
  clock = 0;
  const unpaced = createRequestPacer(0, { now: () => clock, sleep: async () => { throw new Error('should not wait'); } });
  await unpaced(); await unpaced();
});

test('a paced crawl starts each request at least the interval after the last', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-raw-paced-'));
  const original = globalThis.fetch;
  const started: number[] = [];
  globalThis.fetch = async () => {
    started.push(Date.now());
    return new Response('<main><h1>Office</h1><p>Office page text.</p></main>', {headers:{'content-type':'text/html'}});
  };
  try {
    await collectRawDataset({dataset:'paced',seedUrls:['https://example.edu/a','https://example.edu/b','https://example.edu/c'],
      allowedHost:'example.edu',outputPath:path.join(dir,'paced.raw.json'),attempts:1,maxDetailPages:0,requestIntervalMs:40});
    assert.equal(started.length, 3);
    for (let index = 1; index < started.length; index += 1) assert.ok(started[index] - started[index - 1] >= 35);
  } finally {globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
});

test('a compressed source capture keeps the original HTML and replays it the same way', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-raw-gzip-'));
  const original = globalThis.fetch;
  const html = '<main><h1>Financial Aid</h1><h2>Deadlines</h2><p>File the <a href="/finaid/fafsa/">FAFSA</a> by March 1.</p></main>';
  globalThis.fetch = async () => new Response(html, {headers:{'content-type':'text/html'}});
  try {
    const collected = await collectRawDataset({dataset:'office',seedUrls:['https://example.edu/finaid/'],allowedHost:'example.edu',
      outputPath:path.join(dir,'office.raw.json'),attempts:1,maxDetailPages:0,retainSourceHtml:true,compressSourceHtml:true});
    const capture = JSON.parse(fs.readFileSync(path.join(dir,'office-sources.raw.json'),'utf8'));
    assert.equal(capture.pages[0].html,'');
    assert.equal(sourceHtml(capture.pages[0]),html);
    assert.equal(capture.pages[0].contentHash,createHash('sha256').update(html).digest('hex'));
    assert.deepEqual(replayRawSourceCapture(capture).pages[0].sections, collected.pages[0].sections);
    capture.pages[0].htmlGzip = Buffer.from('changed').toString('base64');
    assert.throws(() => replayRawSourceCapture(capture));
  } finally {globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
});

test('a challenge page is recognized by its title, headings or small size, not by words in page text', () => {
  const filler = '<p>' + 'Policy text. '.repeat(8_000) + '</p>';
  const policy = `<title>Use of Artificial Intelligence (AI) in the Workplace - Policies</title><main><h1>Use of AI</h1>${filler}
    <p>The output is often prone to inaccuracies, making careful human verification essential.</p></main>`;
  assert.equal(isLikelyChallengeHtml(policy), false);
  assert.throws(() => buildRawPageFromHtml({url:'https://example.edu/tiny',sourceType:'seed',allowedHost:'example.edu',
    html:'<title>Human Verification</title><body><div id="captcha-container"></div></body>'}), /bot challenge/);
  assert.equal(isLikelyChallengeHtml('<html><head><title>ERROR: The request could not be satisfied</title></head><body><h1>403 ERROR</h1><h2>The request could not be satisfied.</h2></body></html>'), true);
  assert.equal(isLikelyChallengeHtml('<title>Just a moment...</title><body><noscript><span>Enable JavaScript and cookies to continue</span></noscript></body>'), true);
  assert.equal(isLikelyChallengeHtml(`<title>Human Verification</title><main>${filler}</main>`), true);
  assert.equal(isLikelyChallengeHtml(`<title>Office</title><main><h2>Attention Required! | Cloudflare</h2>${filler}</main>`), true);
});

test('a mailto link that shows one address and sends to another is not a contact', () => {
  const page = buildRawPageFromHtml({ url: 'https://www.ramapo.edu/snh/sigma-xi-research-showcase/', sourceType: 'seed', allowedHost: 'www.ramapo.edu',
    html: `<main><h1>Sigma Xi</h1><p>Ash Stuart <a href="mailto:ltan@ramapo.edu">astuart@ramapo.edu</a></p>
      <p>Loraine Tan <a href="mailto:ltan@ramapo.edu?subject=Hi">LTan@Ramapo.edu.</a></p>
      <p>Jim Monen <a href="mailto:jmonen@ramapo.edu">jmonen@ramapo.ed</a></p>
      <p><a href="mailto:graduate@ramapo.edu">graduate@ramapo.edu and we will be happy to assist you!</a></p>
      <p><a href="mailto:oss@ramapo.edu">Email the Office of Specialized Services</a></p></main>` });
  assert.deepEqual(page.contacts.map(contact => contact.email).sort(), ['graduate@ramapo.edu', 'ltan@ramapo.edu', 'oss@ramapo.edu']);
  assert.equal(page.contacts.find(contact => contact.email === 'ltan@ramapo.edu')?.name, 'LTan@Ramapo.edu.');
  assert.equal(isMismatchedMailto('astuart@ramapo.edu', 'ltan@ramapo.edu'), true);
  assert.equal(isMismatchedMailto('kayala2@ramapo.edu', 'kayala@ramapo.edu'), true);
  assert.equal(isMismatchedMailto('(jdoe@ramapo.edu).', 'JDoe@ramapo.edu'), false);
  assert.equal(isMismatchedMailto('jdoe@ramapo.edu', '%20jdoe@ramapo.edu'), false);
  assert.equal(isMismatchedMailto('Contact Us', 'reg@ramapo.edu'), false);
});

test('a tel link is a contact only when it is a phone number', () => {
  const page = buildRawPageFromHtml({ url: 'https://www.ramapo.edu/snh/publications-research/', sourceType: 'seed', allowedHost: 'www.ramapo.edu',
    html: `<main><h1>Publications</h1><p>Journal of Chemistry 12, <a href="tel:2641-2673">2641-2673</a> (2021).</p>
      <p>Call <a href="tel:(201)%20684-7593">(201) 684-7593</a> or <a href="tel:%28201%29%20684-7432">201-684-7432</a>.</p></main>` });
  assert.deepEqual(page.contacts.map(contact => contact.phone), ['(201)%20684-7593', '%28201%29%20684-7432']);
  for (const number of ['(201)%20684-7593', '%28201%29%20684-7432', '201-684-7000', '+1 201 684 7000', '201-684-7000 ext. 12', 'x7451']) {
    assert.equal(isPhoneNumber(number), true, number);
  }
  for (const range of ['2641-2673', '2025-2031', '684-7593', '%zz']) assert.equal(isPhoneNumber(range), false, range);
});

test('an Events Calendar date gets back the year the plugin leaves out', () => {
  const event = (details: string, schedule: string) => buildRawPageFromHtml({ url: 'https://www.ramapo.edu/holocaust/event/x/', sourceType: 'seed',
    allowedHost: 'www.ramapo.edu', html: `<body class="single-tribe_events"><main><h1>Event</h1><div class="tribe-events-schedule tribe-clearfix"><p>${schedule}</p></div>
      <div class="tribe-events-meta-group"><h2 class="tribe-events-single-section-title">Details</h2><ul>${details}</ul>
      <p><abbr class="tribe-region tribe-events-abbr" title="New Jersey">NJ</abbr></p></div></main></body>` });
  const oneDay = event(`<li><span>Date:</span> <abbr class="tribe-events-abbr tribe-events-start-date published dtstart" title="2026-11-10"> Tue, November 10 </abbr></li>
    <li><span>Time:</span> <div class="tribe-events-abbr tribe-events-start-time published dtstart" title="2026-11-10"> 1:50 pm – 3:05 pm </div></li>`,
    '<span class="tribe-event-date-start">Tue, November 10 @ 1:50 pm</span> – <span class="tribe-event-time">3:05 pm</span>');
  const text = oneDay.sections.map(section => section.text).join(' ');
  assert.match(text, /Date: Tue, November 10, 2026 Time: 1:50 pm – 3:05 pm/);
  assert.match(text, /NJ/);
  assert.doesNotMatch(text, /NJ, /);
  const run = event(`<li><span>Start:</span> <abbr class="tribe-events-abbr tribe-events-start-date published dtstart" title="2026-09-16"> Wed, September 16 </abbr></li>
    <li><span>End:</span> <abbr class="tribe-events-abbr tribe-events-end-date dtend" title="2027-01-04"> Mon, January 4 </abbr></li>`,
    '<span class="tribe-event-date-start">Wed, September 16</span> – <span class="tribe-event-date-end">Mon, January 4</span>');
  const runText = run.sections.map(section => section.text).join(' ');
  assert.match(runText, /Wed, September 16, 2026 – Mon, January 4, 2027/);
  assert.match(text, /Tue, November 10, 2026 @ 1:50 pm – 3:05 pm/);
  assert.match(runText, /Start: Wed, September 16, 2026 End: Mon, January 4, 2027/);
  assert.equal(withYear('October 8 @ 1:15 pm', '2026'), 'October 8, 2026 @ 1:15 pm');
  assert.equal(withYear('October 8, 2025', '2026'), 'October 8, 2025');
});

