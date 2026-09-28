import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATHLETICS_HOURS_URL, LIBRARY_HOURS_URL, GENERAL_CAMPUS_HOURS_URL, campusHoursFromCaptures,
  campusHoursPublication, parseAthleticsFacilityHours, parseLibraryHours, parseGeneralCampusHours,
  OFFICE_HOURS_PAGES, parseOfficeHours, termWindows,
} from './campus-hours';
import { partitionHoursForPublication, recordValidity } from '../src/data-v2/validity';
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

const general = `Normal Office Hours:
Fall / Spring Hours: Mon.- Fri. 8:30 a.m. 4:30 p.m.
Summer Hours: Mon.- Thurs. 8 a.m. 5:15 p.m., Fri. Closed
Clarification of Terms in the Event of a College Closure
The College is closed. This means offices are closed.
Center for Student Involvement (CSI)
The CSI main office is open Monday through Fridays 8:00am-midnight, Saturday from 4:00-10:00pm and Sunday from 3:00-8:00pm.
*Updated as of September 23rd, 2022
ROADRUNNER CENTRAL
Roadrunner Central is currently closed. Please visit CSI for assistance.
J. LEE’S
Please visit the Center for Student Involvement for assistance.
Women’s Center
Please visit the Center for Student Involvement for assistance.
Bookstore
Summer Store Hours:
Starting May 14th we will be switching to our Summer Hours
Mon – Thu: 10 am – 3 pm
Fri: CLOSED
Sat: CLOSED
Sun: CLOSED
Normal Store Hours:
Mon – Thu: 9am-5pm
Fri: 9am – 4pm
Sat: CLOSED
Sun: CLOSED
Bookstore FAQ:
Last Day to return Spring textbooks for full refund is January 30, 2026.`;

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
  // The repeated sidebar keeps an older year above the same hours: only the label is stale.
  const stale = parseLibraryHours(library).find((row) => row.name === 'Research Help Desk')!;
  assert.equal(stale.availabilityIssue, undefined);
  assert.equal(stale.hours.Monday, '9:00am-9:00pm');
  // The collector's reading stays out of the notes the Brain states.
  assert.doesNotMatch(stale.notes ?? '', /older year/);
  assert.match(stale.derivation ?? '', /same hours under an older year/);
  // Different hours, or a newer year only in the repeat, still withhold.
  const changed = parseLibraryHours(library.replace(/(Research Help Hours\n[^]*?Mon-Thu: )9:00am/, '$110:00am'));
  assert.equal(changed.find((row) => row.name === 'Research Help Desk')?.availabilityIssue,
    'conflicting-source-validity');
  const newer = parseLibraryHours(library.replace('Dec. 15, 2025', 'Dec. 15, 2027'));
  assert.equal(newer.find((row) => row.name === 'Research Help Desk')?.availabilityIssue,
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
  const captures = [[ATHLETICS_HOURS_URL, athletics], [LIBRARY_HOURS_URL, library], [GENERAL_CAMPUS_HOURS_URL, general]]
    .map(([sourceUrl, text]) => ({ sourceUrl, collectedAt,
      html: `<body><script>untrusted layout text</script>${text.split('\n').map((line) => `<p>${line}</p>`).join('')}</body>` }));
  const raw = campusHoursFromCaptures(captures, true);
  assert.deepEqual(hoursSourceErrors(raw, { version: 1, captures }), []);
  assert.match(hoursSourceErrors(raw.map((row, i) => i === 0
    ? { ...row, hours: { ...row.hours, Monday: 'CLOSED' } } : row), { version: 1, captures }).join(), /differ/);
  assert.equal(raw.length, 13);
  const result = campusHoursPublication(raw, new Date(collectedAt));
  assert.deepEqual(result.publishable.filter(row => !row.availabilityIssue).map((row) => row.name), [
    'Swimming Pool', 'Lodge Fitness Center (College Park Apartments)', 'Library (Main Building)',
    'Research Help Desk', 'Game Lab',
  ]);
  assert.equal(result.publishable.length, 13);
  assert.equal(result.omitted.length, 8);
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
  assert.equal(campusHoursFromCaptures(captures.slice(0, 2)).length, 9);
  assert.throws(() => campusHoursFromCaptures(captures.slice(0, 2), true), /exactly one hours capture/);
  assert.throws(() => campusHoursFromCaptures([...captures, captures[2]]), /exactly one hours capture/);
  for (const row of result.publishable.filter(row => row.availabilityIssue === 'unverified-hours')) {
    assert.ok(Object.values(row.hours).every(value => value === 'Hours unavailable'));
    assert.equal(row.validFrom, undefined);
    assert.equal(row.validUntil, undefined);
  }
  assert.ok(result.omitted.some(({record}) => record.name.startsWith('Administrative') && /8:30/.test(record.notes!)));
  assert.ok(!result.publishable.find(row => row.name.startsWith('Administrative'))?.notes?.includes('8:30'));
});

test('parent page preserves facility evidence without selecting ambiguous hours or inventing a closure', () => {
  const records = parseGeneralCampusHours(general);
  assert.deepEqual(records.map(row => [row.name, row.availabilityIssue]), [
    ['Administrative Offices (Normal Hours)', 'ambiguous-source-season'],
    ['Center for Student Involvement (CSI)', 'source-update-only'],
    ["J. Lee's (Student Lounge & Game Room)", 'missing-schedule'],
    ['Ramapo Bookstore', 'ambiguous-source-season'],
  ]);
  assert.match(records[0].notes!, /Fall \/ Spring Hours/);
  assert.match(records[0].notes!, /Summer Hours/);
  assert.match(records[1].notes!, /September 23rd, 2022/);
  assert.match(records[2].notes!, /Please visit the Center for Student Involvement/);
  assert.doesNotMatch(records[2].notes!, /Roadrunner Central is currently closed/);
  assert.doesNotMatch(records[3].notes!, /January 30, 2026/);
  assert.ok(records.every(row => Object.values(row.hours).every(value => value === 'Hours unavailable')));
  assert.deepEqual(validateCampusHours(records), records);
  assert.deepEqual(parseGeneralCampusHours(`Bookstore\nUnrelated navigation\n${general}`), records);
  assert.throws(() => parseGeneralCampusHours(general.replace('J. LEE’S', 'Other facility')), /Could not find heading/);
  assert.throws(() => parseGeneralCampusHours(general.replace('Normal Store Hours:', 'Other hours:')), /seasonal schedules/);
});

test('office pages give their regular hours for the semester the academic calendar dates', () => {
  const calendar = [
    { name: 'Fall 2026', events: [
      { kind: 'classes_begin', startsAt: '2026-08-26T04:00:00.000Z' },
      { kind: 'classes_begin', startsAt: '2026-10-19T04:00:00.000Z' },
      { kind: 'classes_end', startsAt: '2026-12-09T05:00:00.000Z' },
      { kind: 'finals', startsAt: '2026-12-16T05:00:00.000Z' }] },
    { name: 'Winter 2027', events: [{ kind: 'classes_begin', startsAt: '2026-12-21T05:00:00.000Z' },
      { kind: 'finals', startsAt: '2027-01-15T05:00:00.000Z' }] },
    { name: 'Spring 2027', events: [{ kind: 'classes_begin', startsAt: '2027-01-19T05:00:00.000Z' },
      { kind: 'finals', startsAt: '2027-05-12T04:00:00.000Z' }] },
  ];
  const terms = termWindows(calendar);
  assert.deepEqual(terms.map((term) => [term.name, term.from, term.until]),
    [['Fall 2026', '2026-08-26', '2026-12-16'], ['Spring 2027', '2027-01-19', '2027-05-12']]);
  const registrar = OFFICE_HOURS_PAGES.find((office) => office.name === 'Registrar')!;
  // The Registrar prints its schedule on the line after its label, then the summer one.
  const page = 'Contact Information:\nFall/Spring Hours:\n8:30 A.M. - 4:30 P.M. Monday - Friday\n'
    + 'Summer Hours:\n8:00 AM - 5:15 P.M. Monday-Thursday Closed Friday';
  const fall = parseOfficeHours('Registrar', registrar.label, page, '2026-09-28T13:00:00Z', terms);
  assert.equal(fall.hours.Monday, '8:30am-4:30pm');
  assert.equal(fall.hours.Friday, '8:30am-4:30pm');
  assert.equal(fall.hours.Saturday, 'Hours unavailable');
  // Notes are the page's words; the calendar dating is the collector's.
  assert.equal(fall.notes, 'Fall/Spring Hours: 8:30 A.M. - 4:30 P.M. Monday - Friday');
  assert.deepEqual([fall.validFrom, fall.validUntil], ['2026-08-26', '2026-12-16']);
  assert.match(fall.derivation!, /Fall 2026 per the academic calendar \(Aug\. 26 - Dec\. 16, 2026\)/);
  // The page's own "Fall/Spring" names no dates, yet the record is dated and publishable.
  assert.deepEqual(recordValidity(fall).window, { validFrom: '2026-08-26', validUntil: '2026-12-16' });
  assert.equal(partitionHoursForPublication([fall], new Date('2026-09-28T12:00:00Z')).publishable.length, 1);
  assert.equal(partitionHoursForPublication([fall], new Date('2026-12-20T12:00:00Z')).omitted[0].reason, 'expired');
  // Captured between semesters, the schedule is dated by the next one, never by winter session.
  const spring = parseOfficeHours('Registrar', registrar.label, page, '2026-12-20T13:00:00Z', terms);
  assert.deepEqual([spring.validFrom, spring.validUntil], ['2027-01-19', '2027-05-12']);
  // Same-line schedules, and a Monday-Thursday week.
  const accounts = parseOfficeHours('Student Accounts', /^Academic Year:/i,
    'Academic Year: Monday-Friday, 8:30 a.m.-4:30 p.m.\nSummer: Monday-Thursday, 8:00 a.m-5:15 p.m.', '2026-09-28T13:00:00Z', terms);
  assert.equal(accounts.hours.Friday, '8:30am-4:30pm');
  const short = parseOfficeHours('Example', /^Office Hours:/i, 'Office Hours: Monday to Thursday, 9 am - 5 pm', '2026-09-28T13:00:00Z', terms);
  assert.equal(short.hours.Thursday, '9:00am-5:00pm');
  assert.equal(short.hours.Friday, 'Hours unavailable');
  assert.throws(() => parseOfficeHours('Registrar', registrar.label, 'Contact Information:', '2026-09-28T13:00:00Z', terms),
    /line is unavailable/);
  assert.throws(() => parseOfficeHours('Registrar', registrar.label, page, '2027-06-01T13:00:00Z', terms),
    /No academic calendar semester/);
});
