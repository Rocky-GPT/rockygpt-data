import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContactFields, normalizeOffice, reviewContacts, splitPublishedFacultyDepartment } from './contact-normalizer';
import { buildStructuredDirectoryContacts } from './structured-contacts';

test('formats only explicit room codes and preserves suffixes and named locations', () => {
  for (const [input, expected] of Object.entries({ ASB405: 'ASB-405', 'ASB 408': 'ASB-408', G225: 'G-225', 'G201-A': 'G-201A', 'G-201 B': 'G-201B', 'The Lodge': 'The Lodge', 'Learning Commons 204A': 'Learning Commons 204A' })) {
    assert.equal(normalizeOffice(input), expected);
  }
  assert.deepEqual(normalizeContactFields({ name: 'Example', office: 'G-203B/ASB-431D' }).offices, ['G-203B', 'ASB-431D']);
  assert.deepEqual(normalizeContactFields({ name: 'Example', office: 'North/South Hall' }).offices, ['North/South Hall']);
});

test('separates the published school with balanced parentheses and explicit retirement', () => {
  const source = 'Professor of Social Work - Retired (School of Social Sciences and Social Work (Retired))';
  const record = normalizeContactFields({ id: 'stable-id', type: 'person', name: '  Renée   Example, Ph.D. ', ...splitPublishedFacultyDepartment(source) });
  assert.deepEqual(record, { id: 'stable-id', type: 'person', name: 'Renée Example, Ph.D.', title: 'Professor of Social Work', department: 'School of Social Sciences and Social Work', status: 'retired' });
  assert.deepEqual(normalizeContactFields(record), record);
  assert.deepEqual(normalizeContactFields({ name: 'Example', title: 'Professor of Computer Science' }), { name: 'Example', title: 'Professor of Computer Science' });
});

test('preserves IDs, phone details, source keys and credentials while ingestion normalizes fields', () => {
  const contacts = buildStructuredDirectoryContacts([{ name: 'Alex Example´, Ph.D.', title: 'Professor - Retired', school: 'School One (Retired)', office: 'G201-A', phone: 'Ext. 1234' }]);
  const record = contacts.find(r => r.name === 'Alex Example´, Ph.D.')!;
  assert.equal(record.sourceRecordKey, 'faculty:alex-example-ph-d:school-one-retired');
  assert.equal(record.type, 'person');
  assert.equal(record.department, 'School One');
  assert.equal(record.title, 'Professor');
  assert.equal(record.status, 'retired');
  assert.deepEqual(record.offices, ['G-201A']);
  assert.deepEqual(record.phones, [{ extension: '1234' }]);
  assert.deepEqual(normalizeContactFields(normalizeContactFields(record)), normalizeContactFields(record));
  assert.equal((record.normalization_metadata?.raw_fields as Record<string, unknown>).office, 'G201-A');
  const registrar = contacts.find(r => r.name === 'Registrar')!;
  assert.equal(registrar.type, 'office');
  assert.equal(registrar.status, undefined);
});

test('review flags retain ambiguous and incomplete records without assigning active status', () => {
  const contacts = [
    { id: 'one', type: 'person' as const, name: 'Kim', status: 'retired' as const, phones: [{ number: '201-555-0100' }] },
    { id: 'two', type: 'person' as const, name: 'Gardan', phones: [{ number: '201-555-0100' }] },
    { id: 'three', type: 'person' as const, name: 'Example´', title: 'Librarian Liaison:' },
  ];
  const before = structuredClone(contacts);
  const flags = reviewContacts(contacts);
  assert.deepEqual(flags.one, [{ reason: 'shared_phone_with_retired_contact', related_ids: ['two'] }]);
  assert.deepEqual(flags.two, [{ reason: 'shared_phone_with_retired_contact', related_ids: ['one'] }]);
  assert.deepEqual(flags.three.map(f => f.reason), ['missing_contact_method', 'unfinished_title', 'unusual_name_ending']);
  assert.deepEqual(contacts, before);
});
