import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ABSENCE_FIELDS,
  CONTACT_FIELDS,
  checkAbsences,
  checkContactValues,
  findUnrecordedValues,
  loadCapturedPages,
  pageKey,
  statesValue,
  type CapturedPage,
} from './contact-evidence';
import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from './static-contacts';
import { buildStructuredDirectoryContacts } from './structured-contacts';

const page = (url: string, sections: Array<[string, string]>): CapturedPage =>
  ({ url, fetchedAt: '2026-09-26T20:00:00.000Z', sections: sections.map(([heading, text]) => ({ heading, text })) });
const pages = (...list: CapturedPage[]) => new Map(list.map(entry => [pageKey(entry.url), entry]));

test('a sidebar block states its phone, email and room however the page spaces them', () => {
  const text = 'D-207 (Academic Building)\nMonday-Friday8:30 a.m.–4:30 p.m. p: (201) 684-7441e: success@ramapo.eduf: (201) 684-7599';
  assert.equal(statesValue('phone', '(201) 684-7441', text), true);
  assert.equal(statesValue('email', 'success@ramapo.edu', text), true);
  assert.equal(statesValue('office', 'D-207', text), true);
  assert.equal(statesValue('phone', '(201) 684 – 7695', 'Phone: (201) 684 – 7695 Fax'), true);
  assert.equal(statesValue('office', 'D-224', 'Location: D – 224'), true);
  assert.equal(statesValue('office', 'D-104', 'Office: D 104 (201) 684-7220'), true);
  assert.equal(statesValue('office', 'C-209', 'Main Office (C209): (201) 684-7444'), true);
  assert.equal(statesValue('office', 'McBride House', 'McBride House505 Ramapo Valley Road'), true);
  assert.equal(statesValue('email', 'viceprovost@ramapo.edu', 'please contact viceprovost@ramapo.edu.'), true);
  assert.equal(statesValue('phone', '(201) 684-7609', 'Extension: 7609'), true);
});

test('a value the text only resembles is not stated', () => {
  assert.equal(statesValue('phone', '(201) 684-7453', 'p: (201) 684-7461e: reslife@ramapo.edu'), false);
  assert.equal(statesValue('email', 'registrar@ramapo.edu', 'E-mail: reg@ramapo.edu'), false);
  assert.equal(statesValue('email', 'reg@ramapo.edu', 'E-mail: registrar@ramapo.edu'), false);
  assert.equal(statesValue('office', 'D-216C', 'Building D, Room D-216'), false);
  assert.equal(statesValue('phone', '(201) 825-8770 or (201) 684-7800', 'Phone: (201) 684-7800'), false);
});

test('in a list of many offices, the value must be the first after its entry', () => {
  const listing = page('https://www.ramapo.edu/about/phone/', [[
    'General Phone Number Listing',
    'Assessment Office - (201) 684-7260 Athletics - (201) 684-7674 Benefits - (201) 684-7230',
  ]]);
  const near = [{ url: listing.url, section: 'General Phone Number Listing', near: 'Athletics - ', fields: ['phone' as const] }];
  assert.deepEqual(checkContactValues({ phone: '(201) 684-7674' }, near, pages(listing)).withheld, []);
  assert.equal(checkContactValues({ phone: '(201) 684-7230' }, near, pages(listing)).withheld.length, 1);
});

test('reviewed values publish only where a cited section of this capture states them', () => {
  const reslife = page('https://www.ramapo.edu/reslife/', [['Office of Residence Life', 'p: (201) 684-7461e: reslife@ramapo.edu']]);
  // The old reviewed number is a Student Accounts staff line on another page; it doesn't count.
  const accounts = page('https://www.ramapo.edu/student-accounts/', [['Staff', 'William Ryals Phone: (201) 684-7453']]);
  const evidence = [{ url: 'https://www.ramapo.edu/reslife', section: 'office of residence life', fields: ['phone' as const, 'email' as const] }];
  const checked = checkContactValues(
    { phone: '(201) 684-7453', email: 'reslife@ramapo.edu', office: 'The Lodge' }, evidence, pages(reslife, accounts));
  assert.deepEqual(checked.values, { email: 'reslife@ramapo.edu' });
  assert.deepEqual(checked.sourceUrls, ['https://www.ramapo.edu/reslife']);
  assert.deepEqual(checked.withheld.map(value => [value.field, value.value]), [['phone', '(201) 684-7453'], ['office', 'The Lodge']]);
  assert.match(checked.withheld[1].reason, /No page is cited/);
});

test('a page or section missing from this capture withholds the values it supported', () => {
  const evidence = [{ url: 'https://www.ramapo.edu/oss/', section: 'Contact', fields: ['phone' as const] }];
  assert.match(checkContactValues({ phone: '(201) 684-7514' }, evidence, pages()).withheld[0].reason, /was not captured/);
  const moved = page('https://www.ramapo.edu/oss/', [['Get in touch', 'Phone: (201) 684-7514']]);
  assert.match(checkContactValues({ phone: '(201) 684-7514' }, evidence, pages(moved)).withheld[0].reason, /has no section "Contact"/);
});

test('captured pages come from the parsed raw datasets, latest successful capture first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-evidence-'));
  const write = (file: string, list: unknown[]) => fs.writeFileSync(path.join(dir, file), JSON.stringify({ pages: list }));
  write('office-pages.raw.json', [
    { url: 'https://www.ramapo.edu/crw', statusCode: 200, fetchedAt: '2026-09-26T00:00:00Z', sections: [{ heading: 'A', text: 'old' }] },
    { url: 'https://www.ramapo.edu/gone/', statusCode: 404, fetchedAt: '2026-09-26T00:00:00Z', sections: [] },
  ]);
  write('directory.raw.json', [
    { url: 'https://www.ramapo.edu/crw/', statusCode: 200, fetchedAt: '2026-09-27T00:00:00Z', sections: [{ heading: 'A', text: 'new' }] },
  ]);
  write('office-pages-sources.raw.json', [{ url: 'https://www.ramapo.edu/html/', statusCode: 200, fetchedAt: 'x', sections: [] }]);
  const loaded = loadCapturedPages(dir);
  assert.deepEqual([...loaded.keys()], ['www.ramapo.edu/crw/']);
  assert.equal(loaded.get('www.ramapo.edu/crw/')?.sections[0].text, 'new');
});

test('every reviewed contact value cites a page section for its field', () => {
  for (const entry of [...OFFICE_DIRECTORY_CONTACTS, ...OTHER_DIRECTORY_CONTACTS]) {
    for (const field of CONTACT_FIELDS) {
      if (!entry[field]) continue;
      assert.ok(entry.evidence.some(evidence => evidence.fields.includes(field)), `${entry.name} cites no page for its ${field}`);
    }
    for (const evidence of entry.evidence) {
      assert.match(evidence.url, /^https:\/\//, `${entry.name} cites a page by its full URL`);
      assert.ok(evidence.section.trim(), `${entry.name} names the section of ${evidence.url}`);
      assert.ok(evidence.fields.length, `${entry.name} says what ${evidence.url} states`);
    }
  }
});

test('publication records where each value came from and what it withheld', () => {
  const contacts = buildStructuredDirectoryContacts([], pages());
  const registrar = contacts.find(contact => contact.name === 'Registrar');
  assert.equal(registrar?.phone, undefined);
  const metadata = registrar?.normalization_metadata as { evidence?: { withheld: unknown[]; source_urls: string[] } };
  assert.equal(metadata.evidence?.withheld.length, 3);
  assert.deepEqual(metadata.evidence?.source_urls, []);
  // File mode (no captures) keeps the reviewed values as before.
  assert.equal(buildStructuredDirectoryContacts([]).find(contact => contact.name === 'Registrar')?.phone, '(201) 684-7695');
});

test('a cited section that states a value the entry leaves out is reported, so "not published" cannot hide it', () => {
  // The ID Card Room's own line listed an email that the reviewed entry never recorded.
  const evidence = [{ url: 'https://www.ramapo.edu/publicsafety/id-cards/', section: 'Identification Card Information',
    fields: ['phone', 'office'] as Array<'phone' | 'office'> }];
  const captured = pages(page(evidence[0].url, [['Identification Card Information',
    'ID Room, C-Wing, C-101 (201)-684-6229/x6229 publicsafety@ramapo.edu']]));
  const missed = findUnrecordedValues({ phone: '(201) 684-6229', office: 'C-101' }, evidence, captured);
  assert.deepEqual(missed.map(({ field, found }) => [field, found]), [['email', ['publicsafety@ramapo.edu']]]);
  assert.equal(missed[0].section, 'Identification Card Information');
  // Once the email is recorded there is nothing to report, and a page that is not captured reports nothing.
  assert.deepEqual(findUnrecordedValues({ phone: '(201) 684-6229', email: 'publicsafety@ramapo.edu', office: 'C-101' }, evidence, captured), []);
  assert.deepEqual(findUnrecordedValues({}, evidence, pages()), []);
  // It never changes what is published: the unrecorded value is not returned as a contact value.
  assert.deepEqual(checkContactValues({ phone: '(201) 684-6229', office: 'C-101' }, evidence, captured).values,
    { phone: '(201) 684-6229', office: 'C-101' });
});

const NURSING = 'https://www.ramapo.edu/nursing/';
const contactBlock = (text: string) => pages(page(NURSING, [['Contact Us', text], ['News', 'Email news@ramapo.edu']]));

test('an absence is confirmed when every cited section states nothing of that kind, and says when it was read', () => {
  const captured = contactBlock('Phone: (201) 684-7749. Visit Adler Center for Nursing Excellence.');
  const checked = checkAbsences([{ field: 'email', evidence: [{ url: NURSING, section: 'Contact Us' }] }], {}, captured);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.confirmed, [{ field: 'email',
    checks: [{ url: NURSING, section: 'Contact Us', checked_at: '2026-09-26T20:00:00.000Z' }] }]);
  // Only the cited section counts: the News section's address is not this office's contact block.
  assert.equal(checked.confirmed.length, 1);
});

test('a section that states a value contradicts the absence, for every kind of field', () => {
  const claim = (field: 'phone' | 'email' | 'office' | 'hours') => [{ field, evidence: [{ url: NURSING, section: 'Contact Us' }] }];
  const cases: Array<[Parameters<typeof claim>[0], string]> = [
    ['email', 'Write to nursing@ramapo.edu'],
    ['phone', 'Call (201) 684-7749'],
    ['office', 'Room D-216'],
    ['hours', 'Open Monday-Friday 8:30 a.m. - 4:30 p.m.'],
    ['hours', 'Walk-in hours 10 AM to 8 PM'],
    ['hours', 'The office is staffed 24 hours a day'],
  ];
  for (const [field, text] of cases) {
    const checked = checkAbsences(claim(field), {}, contactBlock(text));
    assert.deepEqual(checked.confirmed, [], text);
    assert.equal(checked.issues[0]?.kind, 'contradicted', text);
    assert.match(checked.issues[0].reason, /states/, text);
  }
});

test('an absence nobody could read is unconfirmed, never confirmed', () => {
  const claim = [{ field: 'email' as const, evidence: [{ url: NURSING, section: 'Contact Us' }] }];
  const cases: Array<[ReturnType<typeof contactBlock>, RegExp]> = [
    [pages(), /was not captured/],
    [pages(page(NURSING, [['About', 'Nothing here']])), /no section "Contact Us"/],
  ];
  for (const [captured, reason] of cases) {
    const checked = checkAbsences(claim, {}, captured);
    assert.deepEqual(checked.confirmed, []);
    assert.equal(checked.issues[0].kind, 'unconfirmed');
    assert.match(checked.issues[0].reason, reason);
  }
  const near = [{ field: 'phone' as const, evidence: [{ url: NURSING, section: 'Contact Us', near: 'Nursing Office' }] }];
  assert.equal(checkAbsences(near, {}, contactBlock('Other office (201) 684-7000')).issues[0].kind, 'unconfirmed');
  assert.deepEqual(checkAbsences([{ field: 'email', evidence: [] }], {}, contactBlock('x')).issues.map(i => i.kind), ['unconfirmed']);
});

test('one clean section does not hide another that states the value, and an entry cannot hold a value it says is not published', () => {
  const both = [{ field: 'email' as const, evidence: [{ url: NURSING, section: 'Contact Us' }, { url: NURSING, section: 'News' }] }];
  const checked = checkAbsences(both, {}, contactBlock('Phone only'));
  assert.deepEqual(checked.confirmed, []);
  assert.equal(checked.issues.length, 1);
  assert.equal(checked.issues[0].kind, 'contradicted');
  const own = checkAbsences([{ field: 'email', evidence: [{ url: NURSING, section: 'Contact Us' }] }],
    { email: 'nursing@ramapo.edu' }, contactBlock('Phone only'));
  assert.deepEqual(own.confirmed, []);
  assert.equal(own.issues[0].kind, 'contradicted');
  // Hours are not a contact value: the entry's contact values never contradict an hours claim.
  assert.equal(checkAbsences([{ field: 'hours', evidence: [{ url: NURSING, section: 'Contact Us' }] }],
    { email: 'nursing@ramapo.edu' }, contactBlock('Phone only')).confirmed.length, 1);
});

test('the reference data makes only well-formed absence claims that no reviewed value contradicts', () => {
  for (const entry of [...OFFICE_DIRECTORY_CONTACTS, ...OTHER_DIRECTORY_CONTACTS]) {
    const seen = new Set<string>();
    for (const claim of entry.notPublished ?? []) {
      assert.ok(ABSENCE_FIELDS.includes(claim.field), `${entry.name}: ${claim.field}`);
      assert.ok(!seen.has(claim.field), `${entry.name} claims ${claim.field} twice`);
      seen.add(claim.field);
      assert.ok(claim.evidence.length > 0, `${entry.name} ${claim.field} cites no section`);
      if (claim.field !== 'hours') assert.ok(!entry[claim.field], `${entry.name} has a ${claim.field} and says it is not published`);
    }
  }
});
