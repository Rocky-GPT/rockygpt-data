import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATHLETICS_HOURS_URL, LIBRARY_HOURS_URL, campusHoursFromCaptures,
  campusHoursPublication, parseAthleticsFacilityHours, parseLibraryHours,
} from './campus-hours';
import { validateCampusHours } from './schema';
import { hoursSourceErrors } from '../pipeline/quality/hours-coverage';

const athletics = `Bradley Center Arena & Lodge Fitness Center are closed until further notice.
2026 Fall Semester Hours
Bradley Center, Student Lounge, and Recreation Lounge
Monday - Friday - 8:00 AM - 10:00 PM
Saturday - 10:30 AM - 4:30 PM
Sunday - 12:00 PM - 8:00 PM
Sharp Fitness Center (Bradley Center Weight Room)
Monday - Friday - 8:00 AM - 9:45 PM
Saturday - 10:45 AM - 4:15 PM
Sunday - 12:15 PM - 7:45 PM
Adele and Reuben Thomas Swimming Pool
Sept. 8th - Dec. 11th, 2026
Monday - Noon - 2:00 PM
Tuesday & Wednesday - 10:00 AM - 2:00 PM
Thursday - 11:00 AM - 2:00 PM
Friday - 10:00 AM - Noon
Saturday - 12:30 PM - 4:00 PM | Pending varsity swim practice
Sunday - 12:00 PM to 4:00 PM
Auxiliary Gym
Monday - Friday - 8:00 AM - 9:30 AM and 11:30 AM - 12:30 PM
Sunday - 12:00 PM - 4:00 PM
Rock Climbing Wall
Monday & Wednesday - 6:00 PM - 9:00 PM
Lodge Fitness Center Open Gym Hours
CLOSED UNTIL FURTHER NOTICE
To rent our facility`;

const library = `CIRCULATION DESK HOURS
Fall Semester
(Aug. 26 - Dec. 15, 2026)
Mon-Thu: 7:45am - 12:00am
Fri: 7:45am - 6:00pm
Sat: 10:00am - 6:00pm
Sun: 12:00pm - 12:00am
RESEARCH HELP HOURS
Fall Semester
(Aug. 26 - Dec. 15, 2026)
Mon-Thu: 9:00am - 9:00pm
Fri: 9:00am - 4:00pm
Sat & Sun: 3:00pm - 6:00pm
GAME LAB HOURS
Fall Semester
(Aug. 26 - Dec. 15, 2026)
Mon-Thu: 9:00am - 8:00pm
Fri: 9:00am - 6:00pm
Sat & Sun: CLOSED
Please Note: Gaming classes have priority access from 11am to 2pm.
If we are offline
Research Help Hours
Fall Semester
(Aug. 26 - Dec. 15, 2025)
Mon-Thu: 9:00am - 9:00pm`;

test('a facility closure parses without an opening-time line and unlisted days remain unknown', () => {
  const rows = parseAthleticsFacilityHours(athletics);
  assert.equal(rows.length, 6);
  const lodge = rows.find((row) => row.name.startsWith('Lodge'))!;
  assert.ok(Object.values(lodge.hours).every((value) => value === 'CLOSED'));
  assert.equal(lodge.notes, 'CLOSED UNTIL FURTHER NOTICE');
  assert.equal(rows.find((row) => row.name === 'Auxiliary Gym')?.hours.Saturday, 'Hours unavailable');
  assert.equal(rows.find((row) => row.name === 'Rock Climbing Wall')?.hours.Tuesday, 'Hours unavailable');
});

test('library capture keeps term bounds and withholds conflicting repeated research years', () => {
  const rows = parseLibraryHours(library);
  assert.equal(rows.find((row) => row.name === 'Research Help Desk')?.availabilityIssue,
    'conflicting-source-validity');
  const consistent = parseLibraryHours(library.replace('Dec. 15, 2025', 'Dec. 15, 2026'));
  assert.equal(consistent.find((row) => row.name === 'Research Help Desk')?.availabilityIssue, undefined);
  assert.throws(() => parseLibraryHours(library.replace('Mon-Thu: 7:45am', 'Unrecognized: 7:45am')),
    /missing or unrecognized days/);
  assert.throws(() => parseLibraryHours(library.replace('RESEARCH HELP HOURS',
    'Special Hours\nSep 7: CLOSED\nRESEARCH HELP HOURS')), /unparsed special hours/);
});

test('every published hour has its own capture provenance and every omission is accounted for', () => {
  const collectedAt = '2026-09-23T20:00:00Z';
  const captures = [[ATHLETICS_HOURS_URL, athletics], [LIBRARY_HOURS_URL, library]]
    .map(([sourceUrl, text]) => ({ sourceUrl, collectedAt,
      html: `<body><script>untrusted layout text</script>${text.split('\n').map((line) => `<p>${line}</p>`).join('')}</body>` }));
  const raw = campusHoursFromCaptures(captures);
  assert.deepEqual(hoursSourceErrors(raw, { version: 1, captures }), []);
  assert.match(hoursSourceErrors(raw.map((row, i) => i === 0
    ? { ...row, hours: { ...row.hours, Monday: 'CLOSED' } } : row), { version: 1, captures }).join(), /differ/);
  assert.equal(raw.length, 9);
  const result = campusHoursPublication(raw, new Date(collectedAt));
  assert.deepEqual(result.publishable.map((row) => row.name), [
    'Swimming Pool', 'Lodge Fitness Center (College Park Apartments)', 'Library (Main Building)', 'Game Lab',
  ]);
  assert.equal(result.omitted.length, 5);
  assert.equal(result.omitted.filter((row) => row.reason === 'unbounded-term').length, 4);
  assert.deepEqual(validateCampusHours(raw), raw);
  for (const row of raw) assert.equal(row.collectedAt, collectedAt);
  const pool = result.publishable[0];
  assert.equal(pool.sourceUrl, ATHLETICS_HOURS_URL);
  assert.deepEqual([pool.validFrom, pool.validUntil], ['2026-09-08', '2026-12-11']);
  const main = result.publishable[2];
  assert.equal(main.sourceUrl, LIBRARY_HOURS_URL);
  assert.deepEqual([main.validFrom, main.validUntil], ['2026-08-26', '2026-12-15']);
  assert.equal(main.hours.Monday, '7:45am-12:00am');
  assert.throws(() => campusHoursFromCaptures(captures.slice(0, 1)), /exactly one hours capture/);
});
