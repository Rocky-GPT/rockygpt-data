import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONTACT_FIELDS,
  checkContactValues,
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
