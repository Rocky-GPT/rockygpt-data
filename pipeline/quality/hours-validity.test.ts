import assert from 'node:assert/strict';
import test from 'node:test';
import { FileRepositoryV2 } from '../../src/data-v2/repositories/file-repository';

/**
 * The library's schedule in `data/normalized/hours.json` is noted as
 * "Spring Semester 2026 (Jan 20 – May 12)". It was answered as *today's*
 * hours on 20 August 2026, because the window lived only in free-text notes:
 * nothing parsed it, `valid_from`/`valid_until` published NULL, and both
 * repositories read absent validity as "applies on every date".
 */

const LIBRARY = 'Library (Main Building)';
const repo = new FileRepositoryV2();

/** Noon UTC keeps a date-only comparison off the day boundary. */
function on(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

test('a schedule bounded to a past term does not answer for today', async () => {
  const records = await repo.findCampusHours(LIBRARY, 'Thursday', on('2026-08-20'));

  assert.equal(
    records.some((record) => record.name === LIBRARY),
    false,
    'Spring semester hours must not be returned for an August date'
  );
});

test('the same schedule still answers inside its own term', async () => {
  const records = await repo.findCampusHours(LIBRARY, 'Thursday', on('2026-03-05'));

  const library = records.find((record) => record.name === LIBRARY);
  assert.ok(library, 'hours should be available during the Spring semester');
  assert.equal(library.schedule, '7:45am-12:00am');
});

test('the window is inclusive of its final day and excludes the day after', async () => {
  const lastDay = await repo.findCampusHours(LIBRARY, 'Tuesday', on('2026-05-12'));
  const dayAfter = await repo.findCampusHours(LIBRARY, 'Wednesday', on('2026-05-13'));

  assert.ok(lastDay.some((record) => record.name === LIBRARY));
  assert.equal(
    dayAfter.some((record) => record.name === LIBRARY),
    false
  );
});

test('a schedule with no stated window still answers on any date', async () => {
  // The Bradley Center carries no note, so it is undated and always eligible.
  const records = await repo.findCampusHours('Bradley Center', 'Thursday', on('2026-08-20'));

  assert.ok(records.length > 0, 'undated schedules must not be filtered out');
});

test('omitting the date preserves the previous unfiltered behaviour', async () => {
  const records = await repo.findCampusHours(LIBRARY, 'Thursday');

  assert.ok(records.some((record) => record.name === LIBRARY));
});
