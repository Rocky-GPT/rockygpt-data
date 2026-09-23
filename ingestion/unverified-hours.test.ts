import assert from 'node:assert/strict';
import test from 'node:test';
import { withheldHoursRecord } from './unverified-hours';
import { normalizeOpeningHours } from '../src/data-v2/opening-hours';

test('withholding a schedule retains the place and provenance without claiming hours or closure', () => {
  const record = { name: 'Gym', hours: { Monday: '8am-10pm', Sunday: 'CLOSED' },
    notes: 'Old schedule 8am-10pm', validFrom: '2025-01-01', validUntil: '2025-12-31',
    sourceUrl: 'https://example.edu/gym', collectedAt: '2026-09-23T20:00:00Z' };
  const result = withheldHoursRecord({ record, reason: 'expired' });
  assert.equal(result.name, record.name);
  assert.equal(result.sourceUrl, record.sourceUrl);
  assert.equal(result.collectedAt, record.collectedAt);
  assert.equal(result.validFrom, undefined);
  assert.equal(result.validUntil, undefined);
  assert.ok(!JSON.stringify(result).includes('8am-10pm'));
  assert.equal(Object.keys(result.hours).length, 7);
  assert.ok(Object.values(result.hours).every(value => normalizeOpeningHours(value) === null));
  assert.match(result.notes!, /unverified/);
});
