import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAndNormalizePhone,
  formatE164ToDisplay,
} from './phone-normalizer';

test('formatE164ToDisplay converts E.164 to standard US format', () => {
  assert.equal(formatE164ToDisplay('+12016847000'), '(201) 684-7000');
  assert.equal(formatE164ToDisplay('+19145827093'), '(914) 582-7093');
  assert.equal(formatE164ToDisplay('invalid'), 'invalid');
});

test('handles null, undefined, and empty raw phone values', () => {
  assert.deepEqual(parseAndNormalizePhone(null), {
    raw_phone: null,
    phone: null,
    phones: [],
    preferred_contact: null,
    contact_note: null,
    prefers_email: false,
    phone_normalization_status: 'none',
  });

  assert.deepEqual(parseAndNormalizePhone(undefined), {
    raw_phone: null,
    phone: null,
    phones: [],
    preferred_contact: null,
    contact_note: null,
    prefers_email: false,
    phone_normalization_status: 'none',
  });

  assert.deepEqual(parseAndNormalizePhone('   '), {
    raw_phone: null,
    phone: null,
    phones: [],
    preferred_contact: null,
    contact_note: null,
    prefers_email: false,
    phone_normalization_status: 'none',
  });
});

test('normalizes standard 10-digit phone numbers with various punctuations', () => {
  const inputs = [
    '(201) 684-7392',
    '201-684-7392',
    '201.684.7392',
    '201 684 7392',
    '(201) 684- 7392',
    '+1 201-684-7392',
  ];

  for (const input of inputs) {
    const res = parseAndNormalizePhone(input);
    assert.equal(res.raw_phone, input.trim());
    assert.equal(res.phone, '(201) 684-7392');
    assert.deepEqual(res.phones, [{ number: '201-684-7392' }]);
    assert.equal(res.prefers_email, false);
    assert.equal(res.preferred_contact, null);
    assert.equal(res.contact_note, null);
    assert.equal(res.phone_normalization_status, 'normalized');
  }
});

test('handles extension-only values without guessing full numbers (zero hallucination)', () => {
  const res = parseAndNormalizePhone('Ext. 7609');
  assert.equal(res.raw_phone, 'Ext. 7609');
  assert.equal(res.phone, 'Ext. 7609');
  assert.deepEqual(res.phones, [{ extension: '7609' }]);
  assert.equal(res.prefers_email, false);
  assert.equal(res.phone_normalization_status, 'extension_only');

  const res2 = parseAndNormalizePhone('ext 7537');
  assert.equal(res2.raw_phone, 'ext 7537');
  assert.equal(res2.phone, 'Ext. 7537');
  assert.deepEqual(res2.phones, [{ extension: '7537' }]);
  assert.equal(res2.phone_normalization_status, 'extension_only');
});

test('extracts email preference notes while normalizing the dialable number', () => {
  const res1 = parseAndNormalizePhone('(201) 684-7852 (best to use e-mail)');
  assert.equal(res1.raw_phone, '(201) 684-7852 (best to use e-mail)');
  assert.equal(res1.phone, '(201) 684-7852');
  assert.deepEqual(res1.phones, [{ number: '201-684-7852' }]);
  assert.equal(res1.prefers_email, true);
  assert.equal(res1.preferred_contact, 'email');
  assert.equal(res1.contact_note, 'best to use e-mail');
  assert.equal(res1.phone_normalization_status, 'normalized');

  const res2 = parseAndNormalizePhone('(201) 684-7293 (use email instead)');
  assert.equal(res2.raw_phone, '(201) 684-7293 (use email instead)');
  assert.equal(res2.phone, '(201) 684-7293');
  assert.deepEqual(res2.phones, [{ number: '201-684-7293' }]);
  assert.equal(res2.prefers_email, true);
  assert.equal(res2.preferred_contact, 'email');
  assert.equal(res2.contact_note, 'use email instead');
  assert.equal(res2.phone_normalization_status, 'normalized');
});

test('parses multi-phone numbers with explicit labels (Cort Engelken)', () => {
  const input = '(201) 684-9953 (Office) / (914) 582-7093 (Cell)';
  const res = parseAndNormalizePhone(input);
  assert.equal(res.raw_phone, input);
  assert.equal(res.phone, '(201) 684-9953 (Office) / (914) 582-7093 (Cell)');
  assert.deepEqual(res.phones, [
    { number: '201-684-9953', type: 'office' },
    { number: '914-582-7093', type: 'cell' },
  ]);
  assert.equal(res.prefers_email, false);
  assert.equal(res.phone_normalization_status, 'multi_phone');
});

test('parses unlabeled multi-phone numbers preserving order without inventing types (Kathleen Ray)', () => {
  const input = '(201) 684-7814 or (201) 684-7624';
  const res = parseAndNormalizePhone(input);
  assert.equal(res.raw_phone, input);
  assert.equal(res.phone, '(201) 684-7814 / (201) 684-7624');
  assert.deepEqual(res.phones, [
    { number: '201-684-7814' },
    { number: '201-684-7624' },
  ]);
  assert.equal(res.prefers_email, false);
  assert.equal(res.phone_normalization_status, 'multi_phone');
});

// Local ingestion output; data/normalized/ is not committed, so CI has no copy.
const facultyPath = path.resolve(__dirname, '../../data/normalized/faculty.json');

test('validates all 242 campus contacts normalize cleanly and strictly without unparsed records', {
  skip: !fs.existsSync(facultyPath) && 'needs local ingestion output data/normalized/faculty.json',
}, async () => {
  const { buildStructuredDirectoryContacts } = await import('./structured-contacts');

  const facultyRaw = JSON.parse(fs.readFileSync(facultyPath, 'utf8'));
  const contacts = buildStructuredDirectoryContacts(facultyRaw);

  assert.equal(contacts.length, 242, 'Expected exactly 242 campus directory contacts');

  let totalPhoneEntries = 0;
  let preferredEmailCount = 0;

  for (const contact of contacts) {
    assert.notEqual(
      contact.phone_normalization_status,
      'unparsed',
      `Contact ${contact.name} has unparsed phone normalization status`
    );

    if (contact.preferred_contact) {
      assert.equal(
        contact.preferred_contact,
        'email',
        `Contact ${contact.name} has invalid preferred_contact: ${contact.preferred_contact}`
      );
      preferredEmailCount++;
    }

    if (contact.phones && contact.phones.length > 0) {
      totalPhoneEntries += contact.phones.length;
      for (const p of contact.phones) {
        if ('number' in p && typeof p.number === 'string') {
          assert.match(
            p.number,
            /^\d{3}-\d{3}-\d{4}$/,
            `Phone number ${p.number} for ${contact.name} is not in standard XXX-XXX-XXXX format`
          );
        } else if ('extension' in p && typeof p.extension === 'string') {
          assert.match(
            p.extension,
            /^\d+$/,
            `Extension ${p.extension} for ${contact.name} is not all digits`
          );
        } else {
          assert.fail(`Phone entry for ${contact.name} has neither number nor extension`);
        }
      }
    }
  }

  assert.equal(preferredEmailCount, 2, 'Expected exactly 2 contacts with preferred_contact: email');
  assert.equal(totalPhoneEntries, 218, 'Expected 218 normalized phone/extension entries');
});

