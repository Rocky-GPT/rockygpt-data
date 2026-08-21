import assert from 'node:assert/strict';
import test from 'node:test';
import { isWindowExpired, readValidityFromNotes } from '../../src/data-v2/validity';

test('reads the dated range that campus hours actually ship', () => {
  const { window, termWithoutDates } = readValidityFromNotes(
    'Spring Semester 2026 (Jan 20 – May 12). Front doors lock 15 mins before closing.'
  );

  assert.deepEqual(window, { validFrom: '2026-01-20', validUntil: '2026-05-12' });
  assert.equal(termWithoutDates, null);
});

test('accepts hyphen and "to" as range separators, and full month names', () => {
  for (const notes of [
    'Fall 2026 (Sep 1 - Dec 18)',
    'Fall 2026 (September 1 to December 18)',
    'Fall 2026 (Sept. 1 – Dec. 18)',
  ]) {
    assert.deepEqual(
      readValidityFromNotes(notes).window,
      { validFrom: '2026-09-01', validUntil: '2026-12-18' },
      notes
    );
  }
});

test('a range whose end precedes its start crosses into the next year', () => {
  assert.deepEqual(readValidityFromNotes('Winter Session 2026 (Dec 28 – Jan 15)').window, {
    validFrom: '2026-12-28',
    validUntil: '2027-01-15',
  });
});

test('flags a term named without any dates', () => {
  const { window, termWithoutDates } = readValidityFromNotes('Spring Semester 2026');

  assert.equal(window, null);
  assert.equal(termWithoutDates, 'Spring Semester 2026');
});

test('does not mistake schedule prose for a validity window', () => {
  for (const notes of [
    'Gaming classes have priority 11am-2pm daily',
    'Saturday hours pending varsity swim practice',
    'Front doors lock 15 mins before closing.',
    'Additional Open Recreation times may be available; check IMLeagues for details.',
    undefined,
    '',
  ]) {
    const result = readValidityFromNotes(notes);
    assert.equal(result.window, null, String(notes));
    assert.equal(result.termWithoutDates, null, String(notes));
  }
});

test('expiry is inclusive of the final day', () => {
  const window = { validFrom: '2026-01-20', validUntil: '2026-05-12' };

  assert.equal(isWindowExpired(window, new Date('2026-05-12T23:00:00Z')), false);
  assert.equal(isWindowExpired(window, new Date('2026-05-13T00:00:00Z')), true);
  assert.equal(isWindowExpired(window, new Date('2026-08-20T00:00:00Z')), true);
});
