import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCampusHourLocations } from './campus-hours';
import {
  assertRefreshCoverage,
  hoursArtifactRequiresRefresh,
  hoursReplayRequiresRefresh,
  refreshScriptsForArtifactCompatibility,
  coursesArtifactRequiresRefresh,
  refreshScriptsForStates,
  forcedSources,
  keptPastWindowKeys,
  NIGHTLY_SOURCES,
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
  assert.deepEqual(daily.map((source) => source.key).sort(), ['archway-events', 'athletics-schedules', 'dining']);

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

test('a course catalog captured before courses carried requisites is recollected', () => {
  // Production served a July capture in which every course had "requisites": [], so the Brain
  // said "CMPS 231 has no published prerequisites" though the catalog lists CMPS 148.
  const catalog = SOURCE_REFRESH_SCRIPTS['academic-programs'][0];
  const july = {
    'CMPS 231': { code: 'CMPS 231', name: 'DATA STRUCTURES', requisites: [] },
    'SOCI 101': { code: 'SOCI 101', name: 'INTRODUCTION TO SOCIOLOGY', requisites: [] },
  };
  assert.equal(coursesArtifactRequiresRefresh(july), true);
  assert.ok(refreshScriptsForArtifactCompatibility({ faculty: [], hours: [], courses: july })
    .includes(catalog));
  // Older still: no requisites field at all.
  assert.equal(coursesArtifactRequiresRefresh({ 'CMPS 231': { code: 'CMPS 231' } }), true);

  const current = {
    'CMPS 231': { code: 'CMPS 231', requisites: [{ name: 'Prerequisite Course' }] },
    'SOCI 101': { code: 'SOCI 101', requisites: [] },
  };
  assert.equal(coursesArtifactRequiresRefresh(current), false);
  assert.ok(!refreshScriptsForArtifactCompatibility({ faculty: [], hours: [], courses: current })
    .includes(catalog));
  // A missing or empty catalog is recollected too.
  assert.equal(coursesArtifactRequiresRefresh(undefined), true);
  assert.equal(coursesArtifactRequiresRefresh({}), true);
});

test('the office and school sites are collected every night, even when fresh, and keep their week-long window', () => {
  assert.deepEqual([...NIGHTLY_SOURCES].sort(), ['academic-sites', 'office-pages']);
  const week = 168;
  const collectedLastNight = [
    { key: 'office-pages', status: 'fresh' as const, ageHours: 24, maxAgeHours: week },
    { key: 'academic-sites', status: 'fresh' as const, ageHours: 24, maxAgeHours: week },
    { key: 'public-safety', status: 'fresh' as const, ageHours: 24, maxAgeHours: week },
  ];
  // Office pages come first: the school collector skips the pages the office collector keeps.
  assert.deepEqual(refreshScriptsForStates(collectedLastNight), ['fetch:office-pages', 'fetch:academic-sites']);
  // Their window stays a week, so one failed night keeps the last copy instead of stopping the publish.
  for (const key of NIGHTLY_SOURCES) {
    assert.equal(SOURCES.find(source => source.key === key)?.freshnessHours, week);
  }
});

test('a run started by hand can collect named sources tonight, however fresh they are', () => {
  // On November 17, 2026 every hours record dated from October 23 and every club from July 16, both
  // inside their 180-day window, while the library's page listed its Thanksgiving closure.
  const halfYear = 4_320;
  const states = [
    { key: 'campus-hours', status: 'fresh' as const, ageHours: 600, maxAgeHours: halfYear },
    { key: 'archway-clubs', status: 'fresh' as const, ageHours: 2_950, maxAgeHours: halfYear },
    { key: 'faculty', status: 'fresh' as const, ageHours: 600, maxAgeHours: halfYear },
  ];
  assert.deepEqual(refreshScriptsForStates(states), []);
  const forced = forcedSources(' campus-hours,archway-clubs ');
  assert.deepEqual([...forced], ['campus-hours', 'archway-clubs']);
  assert.deepEqual(refreshScriptsForStates(states, 24, forced), ['fetch:hours', 'fetch:clubs']);
  // Spaces work as separators too, and nothing named means nothing forced.
  assert.deepEqual([...forcedSources('campus-hours archway-clubs')], ['campus-hours', 'archway-clubs']);
  assert.equal(forcedSources('').size, 0);
  assert.equal(forcedSources(undefined).size, 0);
  // A misspelt name stops the run instead of passing for a collection that never happened.
  assert.throws(() => forcedSources('campus-hour'), /names no such source: campus-hour/);
});

test('only a source whose collector failed tonight and whose copy is past its window publishes from its last copy', () => {
  const states = [
    { key: 'dining', status: 'stale' },
    { key: 'housing', status: 'stale' },
    { key: 'faculty', status: 'unknown' },
    { key: 'public-safety', status: 'fresh' },
  ];
  const kept = [{ key: 'dining' }, { key: 'faculty' }, { key: 'public-safety' }];
  // Housing is stale but its collector did not fail (it did not run): still an error later.
  // Faculty failed with no known age: never excused. Public safety failed inside its window.
  assert.deepEqual(keptPastWindowKeys(states, kept), ['dining']);
  assert.deepEqual(keptPastWindowKeys(states, []), []);
});
