import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCampusHourLocations } from './campus-hours';
import {
  hoursArtifactRequiresRefresh,
  refreshScriptsForArtifactCompatibility,
} from './refresh-publishable';
import { partitionHoursForPublication } from '../src/data-v2/validity';

const expired = {
  name: 'Past schedule',
  hours: { Monday: '9:00am-5:00pm' },
  notes: 'Spring Semester 2026 (Jan 20 - May 12)',
};
const undatedTerm = {
  name: 'Unbounded schedule',
  hours: { Monday: '9:00am-5:00pm' },
  notes: 'Spring Semester 2026',
};
const ordinary = {
  name: 'Current schedule',
  hours: { Monday: '9:00am-5:00pm' },
};

test('publication omits expired and unbounded-term schedules without inventing replacements', () => {
  const result = partitionHoursForPublication(
    [expired, undatedTerm, ordinary],
    new Date('2026-08-22T12:00:00Z')
  );

  assert.deepEqual(result.publishable.map((record) => record.name), ['Current schedule']);
  assert.deepEqual(result.omitted.map((entry) => entry.reason), ['expired', 'unbounded-term']);
});

test('the campus-hours collector drops unavailable library schedules after their term', () => {
  const locations = buildCampusHourLocations([], new Date('2026-08-22T12:00:00Z'));
  const names = new Set(locations.map((location) => location.name));

  assert.equal(names.has('Library (Main Building)'), false);
  assert.equal(names.has('Research Help Desk'), false);
  assert.equal(names.has('Administrative Offices (Normal Hours)'), true);
});

test('artifact compatibility refreshes stale hours once, then accepts filtered output', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  assert.equal(hoursArtifactRequiresRefresh([expired, ordinary], now), true);
  assert.deepEqual(
    refreshScriptsForArtifactCompatibility({ faculty: [], hours: [expired, ordinary] }, now),
    ['fetch:faculty', 'fetch:hours']
  );

  const filtered = partitionHoursForPublication([expired, ordinary], now).publishable;
  assert.equal(hoursArtifactRequiresRefresh(filtered, now), false);
});
