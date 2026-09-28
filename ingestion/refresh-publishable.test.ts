import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCampusHourLocations } from './campus-hours';
import {
  assertRefreshCoverage,
  hoursArtifactRequiresRefresh,
  hoursReplayRequiresRefresh,
  refreshScriptsForArtifactCompatibility,
  refreshScriptsForStates,
  SOURCE_REFRESH_SCRIPTS,
} from './refresh-publishable';
import { DAILY_SOURCE_FRESHNESS_HOURS, SOURCES } from '../src/data-v2/source-seeds';
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

test('the campus-hours collector never injects hardcoded schedules without source captures', () => {
  const locations = buildCampusHourLocations([], new Date('2026-08-22T12:00:00Z'));
  const names = new Set(locations.map((location) => location.name));

  assert.equal(names.has('Library (Main Building)'), false);
  assert.equal(names.has('Research Help Desk'), false);
  assert.equal(names.has('Administrative Offices (Normal Hours)'), false);
  assert.deepEqual(buildCampusHourLocations([ordinary], new Date('2026-08-22T12:00:00Z')), [ordinary]);
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

test('every source with publication provenance has a refresh command', () => {
  // The daily update stops at this check, before collecting anything, if a source is missed.
  assert.doesNotThrow(() => assertRefreshCoverage());
});

test('daily sources outlast a daily run that starts late and are renewed by one that starts early', () => {
  const daily = SOURCES.filter((source) => source.freshnessHours === DAILY_SOURCE_FRESHNESS_HOURS);
  assert.deepEqual(daily.map((source) => source.key).sort(), ['archway-events', 'dining']);

  // September 2026's runs started up to 3 hours later than the day before and
  // took up to an hour to publish, so data from yesterday's run must still be
  // fresh 28 hours after it was collected.
  assert.ok(DAILY_SOURCE_FRESHNESS_HOURS >= 28);

  for (const source of daily) {
    // A run that starts 6 hours earlier than yesterday's still recollects it.
    assert.deepEqual(
      refreshScriptsForStates([
        { key: source.key, status: 'fresh', ageHours: 18, maxAgeHours: source.freshnessHours },
      ]),
      SOURCE_REFRESH_SCRIPTS[source.key]
    );
  }
});

test('hours that no longer replay from their archived pages are recollected', () => {
  // The quality gate replays the pages with the current parser; a parser change must not
  // leave every daily run failing until campus hours age out.
  const unreplayable = { version: 1, captures: [] };
  assert.equal(hoursReplayRequiresRefresh([ordinary], unreplayable), true);
  const hours = SOURCE_REFRESH_SCRIPTS['campus-hours'][0];
  assert.ok(refreshScriptsForArtifactCompatibility({ hours: [ordinary], hoursRaw: [ordinary],
    hoursSources: unreplayable }).includes(hours));
  // Callers that pass no captures keep the age and applicability checks only.
  assert.ok(!refreshScriptsForArtifactCompatibility({ hours: [ordinary] }).includes(hours));
});
