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
  SOURCE_REFRESH_SCRIPTS,
  spreadHeavySources,
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

test('big sources that would come due on the same night are moved apart, one a night early, once', () => {
  const week = 168;
  const office = { key: 'office-pages', status: 'fresh' as const, maxAgeHours: week, recordCount: 4_640 };
  const schools = { key: 'academic-sites', status: 'fresh' as const, maxAgeHours: week, recordCount: 960 };
  const safety = { key: 'public-safety', status: 'fresh' as const, maxAgeHours: week, recordCount: 40 };

  // Collected together two days ago: both would come due on the same night, so the smaller goes tonight.
  let states = [{ ...office, ageHours: 48 }, { ...schools, ageHours: 48 }, { ...safety, ageHours: 48 }];
  assert.deepEqual(spreadHeavySources(states), ['academic-sites']);
  assert.deepEqual(refreshScriptsForStates(states, 24, new Set(spreadHeavySources(states))), ['fetch:academic-sites']);
  // Without the spread nothing would be collected tonight.
  assert.deepEqual(refreshScriptsForStates(states), []);

  // Simulate a month of nightly runs: never two big sources on one night after the first move,
  // and each keeps collecting about weekly (no source is collected early again and again).
  const age = new Map([['office-pages', 48], ['academic-sites', 48]]);
  const collected = new Map<string, number[]>([['office-pages', []], ['academic-sites', []]]);
  for (let night = 0; night < 30; night += 1) {
    states = [{ ...office, ageHours: age.get('office-pages')! }, { ...schools, ageHours: age.get('academic-sites')! }];
    const early = new Set(spreadHeavySources(states));
    const tonight = states.filter(state => early.has(state.key) || state.maxAgeHours - state.ageHours <= 24).map(state => state.key);
    assert.ok(tonight.length <= 1, `night ${night}: ${tonight.join(', ')}`);
    for (const key of ['office-pages', 'academic-sites']) {
      if (tonight.includes(key)) { age.set(key, 0); collected.get(key)!.push(night); }
      age.set(key, age.get(key)! + 24);
    }
  }
  for (const [key, nights] of collected) {
    const gaps = nights.slice(2).map((night, index) => night - nights[index + 1]);
    assert.ok(gaps.every(gap => gap === 6), `${key} collected on nights ${nights.join(', ')}`);
  }
});

test('nothing is collected early when a big source is due tonight, or when small sources share a night', () => {
  const week = 168;
  const dueTonight = [
    { key: 'office-pages', status: 'fresh' as const, ageHours: 150, maxAgeHours: week, recordCount: 4_640 },
    { key: 'academic-sites', status: 'fresh' as const, ageHours: 48, maxAgeHours: week, recordCount: 960 },
    { key: 'archway-clubs', status: 'fresh' as const, ageHours: 48, maxAgeHours: 4_320 - 120, recordCount: 2_000 },
  ];
  assert.deepEqual(spreadHeavySources(dueTonight), []);
  const small = [
    { key: 'public-safety', status: 'fresh' as const, ageHours: 48, maxAgeHours: week, recordCount: 40 },
    { key: 'housing', status: 'fresh' as const, ageHours: 48, maxAgeHours: week, recordCount: 60 },
  ];
  assert.deepEqual(spreadHeavySources(small), []);
  // A big source without a known age or count is never guessed at.
  assert.deepEqual(spreadHeavySources([
    { key: 'office-pages', status: 'fresh' as const, ageHours: 48, maxAgeHours: week },
    { key: 'academic-sites', status: 'fresh' as const, ageHours: 48, maxAgeHours: week },
  ]), []);
});
