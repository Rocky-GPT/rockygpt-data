import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileRepositoryV2 } from '../data-v2/repositories/file-repository';
import {
  buildStructuredDirectoryContacts,
} from './structured-contacts';
import {
  OFFICE_DIRECTORY_CONTACTS,
  OTHER_DIRECTORY_CONTACTS,
} from './static-contacts';

const NOT_PUBLISHED_URL = 'https://www.ramapo.edu/example-office/';

const STATIC_CONTACT_COUNT =
  OFFICE_DIRECTORY_CONTACTS.length + OTHER_DIRECTORY_CONTACTS.length;

test('structured contacts preserve static records and merge duplicate faculty profiles', () => {
  const contacts = buildStructuredDirectoryContacts([
    {
      name: 'Alex Example',
      title: 'Associate Professor of Examples',
      school: 'School One',
      email: 'alex@example.edu',
      bio: 'First profile biography.',
      profileUrl: 'https://www.ramapo.edu/faculty/alex/',
    },
    {
      name: 'Alex Example',
      title: 'Professor',
      school: 'School One',
      phone: '201-684-7000',
      office: 'A-101',
      bio: 'Duplicate profile biography.',
    },
    {
      name: 'Alex Example',
      title: 'Professor',
      school: 'School Two',
    },
  ]);

  assert.equal(contacts.length, STATIC_CONTACT_COUNT + 2);
  assert.equal(
    contacts.filter((contact) => contact.publicationSourceKey === 'campus-directory').length,
    STATIC_CONTACT_COUNT
  );

  const schoolOne = contacts.find(
    (contact) => contact.name === 'Alex Example' && contact.department?.includes('School One')
  );
  assert.deepEqual(
    {
      department: schoolOne?.department,
      email: schoolOne?.email,
      phone: schoolOne?.phone,
      office: schoolOne?.office,
      sourceKey: schoolOne?.publicationSourceKey,
    },
    {
      department: 'School One',
      email: 'alex@example.edu',
      phone: '(201) 684-7000',
      office: 'A-101',
      sourceKey: 'faculty',
    }
  );
  assert.match(schoolOne?.searchable ?? '', /First profile biography/);
  assert.match(schoolOne?.searchable ?? '', /Duplicate profile biography/);
  assert.equal(new Set(contacts.map((contact) => contact.sourceRecordKey)).size, contacts.length);
  assert.deepEqual(schoolOne?.aliases, []);
  assert.equal(schoolOne?.prefers_email, null, 'No source preference is unknown, not false');
  const office = contacts.find((contact) => contact.name === 'Registrar');
  assert.deepEqual(office?.aliases, ['Office of the Registrar']);
});

test('structured contacts preserve explicit email preference evidence and unknown preferences', () => {
  const input = [
    { name: 'Email Preference', school: 'School One', phone: '(201) 684-7293 (use email instead)' },
    { name: 'No Preference', school: 'School One', phone: '(201) 684-7392' },
    { name: 'No Phone', school: 'School One', email: 'email-only@example.edu' },
  ];
  const contacts = buildStructuredDirectoryContacts(input);
  const explicit = contacts.find(contact => contact.name === 'Email Preference');
  assert.equal(explicit?.prefers_email, true);
  assert.equal(explicit?.preferred_contact, 'email');
  assert.equal(explicit?.contact_note, 'use email instead');
  assert.equal(explicit?.raw_phone, input[0].phone);
  for (const name of ['No Preference', 'No Phone']) {
    const contact = contacts.find(row => row.name === name);
    assert.equal(contact?.prefers_email, null);
    assert.equal(contact?.preferred_contact, undefined);
  }
});

test('file repository entity listing uses the full shared contact population', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-directory-contacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data', 'normalized'), { recursive: true });
  const faculty = Array.from({ length: 10 }, (_, index) => ({
    name: index === 9 ? 'Zed Faculty' : `Faculty ${index + 1}`,
    title: 'Professor',
    school: 'Test School',
    email: `faculty${index + 1}@ramapo.edu`,
  }));
  fs.writeFileSync(
    path.join(root, 'data', 'normalized', 'faculty.json'),
    JSON.stringify(faculty),
    'utf8'
  );

  const repository = new FileRepositoryV2(root);
  assert.equal((await repository.listContacts()).length, STATIC_CONTACT_COUNT + faculty.length);
  assert.equal((await repository.findContactByName('Zed Faculty'))[0]?.email, 'faculty10@ramapo.edu');
  assert.equal((await repository.findContacts('Zed Faculty'))[0]?.name, 'Zed Faculty');
  assert.equal((await repository.findContacts('')).length, 6, 'free-text search remains bounded');
});

test('a confirmed absence reaches the contact row, and one this capture cannot confirm is recorded as an issue', () => {
  const entry = {
    name: 'Example Absence Office', phone: '(201) 684-7000', category: 'Services',
    department: 'Example Absence Office', helpsWith: [],
    evidence: [{ url: NOT_PUBLISHED_URL, section: 'Contact Us', fields: ['phone' as const] }],
    notPublished: [
      { field: 'email' as const, evidence: [{ url: NOT_PUBLISHED_URL, section: 'Contact Us' }] },
      { field: 'hours' as const, evidence: [{ url: NOT_PUBLISHED_URL, section: 'Missing Section' }] },
    ],
  };
  OFFICE_DIRECTORY_CONTACTS.push(entry);
  try {
    const captured = new Map([['www.ramapo.edu/example-office/', {
      url: NOT_PUBLISHED_URL, fetchedAt: '2026-10-07T02:30:00.000Z',
      sections: [{ heading: 'Contact Us', text: 'Phone: (201) 684-7000' }],
    }]]);
    const row = buildStructuredDirectoryContacts([], captured).find(contact => contact.name === entry.name)!;
    const evidence = (row.normalization_metadata as unknown as
      { evidence: { not_published: unknown; absence_issues: Array<{ field: string; kind: string }> } }).evidence;
    assert.deepEqual(evidence.not_published, [{ field: 'email',
      checks: [{ url: NOT_PUBLISHED_URL, section: 'Contact Us', checked_at: '2026-10-07T02:30:00.000Z' }] }]);
    assert.deepEqual(evidence.absence_issues.map(issue => [issue.field, issue.kind]), [['hours', 'unconfirmed']]);
    // A reviewed value that this run withheld is still a value: the field cannot be called not published.
    (entry as { notPublished: unknown }).notPublished = [{ field: 'phone', evidence: [{ url: NOT_PUBLISHED_URL, section: 'Contact Us' }] }];
    entry.phone = '(201) 684-9999';
    const withheld = buildStructuredDirectoryContacts([], captured).find(contact => contact.name === entry.name)!;
    const withheldEvidence = (withheld.normalization_metadata as unknown as
      { evidence: { not_published: unknown[]; absence_issues: Array<{ kind: string }> } }).evidence;
    assert.deepEqual(withheldEvidence.not_published, []);
    assert.equal(withheldEvidence.absence_issues[0].kind, 'contradicted');
    // With no capture (file mode) nothing can be confirmed, so nothing is claimed.
    const fileMode = buildStructuredDirectoryContacts([]).find(contact => contact.name === entry.name)!;
    assert.equal((fileMode as { evidence?: unknown }).evidence, undefined);
  } finally {
    OFFICE_DIRECTORY_CONTACTS.pop();
  }
});
