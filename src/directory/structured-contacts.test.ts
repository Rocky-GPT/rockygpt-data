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
      department: 'Professor (School One)',
      email: 'alex@example.edu',
      phone: '201-684-7000',
      office: 'A-101',
      sourceKey: 'faculty',
    }
  );
  assert.match(schoolOne?.searchable ?? '', /First profile biography/);
  assert.match(schoolOne?.searchable ?? '', /Duplicate profile biography/);
  assert.equal(new Set(contacts.map((contact) => contact.sourceRecordKey)).size, contacts.length);
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
