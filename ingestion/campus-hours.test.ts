import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATHLETICS_HOURS_URL, LIBRARY_HOURS_URL, GENERAL_CAMPUS_HOURS_URL, campusHoursFromCaptures,
  campusHoursPublication, parseAthleticsFacilityHours, parseLibraryHours, parseGeneralCampusHours,
  OFFICE_HOURS_PAGES, parseOfficeHours, parseAlwaysOpenHours, parseConflictingOfficeHours, termWindows,
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

// Lines as the live pages printed them on 2026-10-06 (read in memory, not stored).
const counselingPage = `Connect With Us
To learn more about our services or to schedule an appointment, please visit us in the Academic Building D, Room 216, or call our office at (201) 684-7522.
Academic Year Hours:
Monday - Friday: 8:30 am - 4:30 pm
Summer Hours:
Monday - Thursday: 8:00 am - 5:15 pm
Closed on Fridays`;
const publicSafetyPage = `Public Safety (Non-Confidential Resource)
(201) 684-6666
Public Safety is open 24 hours. Please call Public Safety to speak with an emergency counselor after regular business hours.
(NON-Confidential Resource)
Office Location: C-102
Phone: (201) 684-6666
The Public Safety Department is available 24 hours a day, 7 days a week, 365 days a year. By contacting the Public Safety Department, you are not obligated to file an incident report.`;
const helpDeskPage = `Hours of Support
Fall / Spring
Monday-Thursday
Friday
8:30 AM - 8:00 PM
8:30 AM - 6:00 PM
Call Us!
201-684-7777
By visiting the Help Desk office. We are located on the 4th floor of the Learning Commons and our hours are:
Fall/Spring: Monday-Friday 8:00am-8:00pm
Summer: Monday-Thursday 8:00am-5:15pm`;
const fallTerms = [{ name: 'Fall 2026', from: '2026-08-26', until: '2026-12-16' }];
// Lines as the live pages printed them on 2026-10-07 (read in memory, not stored).
const newOfficePages: Record<string, string> = {
  'https://www.ramapo.edu/asb/': 'Office: ASB-333\nHours: Monday - Friday, 8:30AM-4:30PM',
  'https://www.ramapo.edu/studentsuccess/': 'Center for Student Success\nD-207 (Academic Building)\nMonday-Friday\n8:30 a.m.-4:30 p.m.',
  'https://www.ramapo.edu/oss/': 'MAIN OFFICE: C-Wing, Room 205 - Meetings by appointment. | Office Hours Typically MON-FRI, 8:30 AM-4:30 PM | (201) 684-7514',
  'https://www.ramapo.edu/payroll/': 'Hours:\nFall/Spring, Mon. - Fri.\n8:30 a.m. - 4:30 p.m.\nSummer, Mon. - Thurs.,\n8 a.m. - 5:15 p.m.',
  'https://www.ramapo.edu/testing/': 'Hours\nSummer\nMonday to Thursday, 8:00 a.m. to 5:15 p.m.\nClosed Friday\nFall and Spring\nMonday to Friday, 8:30 a.m. to 4:30 p.m.',
  'https://www.ramapo.edu/publicsafety/id-cards/': 'In order to get a new identification card, please contact the ID room at publicsafety@ramapo.edu and make an appointment. The ID room is open Monday-Friday from 8:30am until 4:00pm.',
  'https://www.ramapo.edu/nursing/': 'Nursing Programs Contact Information:\nOffice: Adler Center for Nursing Excellence 215\nHours: Monday through Friday, 8:30 a.m.to 4:30 p.m.\nPhone: (201) 684-7749',
};

test('the Counseling Center publishes its academic-year hours and leaves the undated summer ones out', () => {
  const entry = OFFICE_HOURS_PAGES.find((office) => office.name === 'Counseling Center')!;
  const row = parseOfficeHours(entry.name, entry.label, counselingPage, '2026-09-28T13:00:00Z', fallTerms);
  assert.equal(row.hours.Monday, '8:30am-4:30pm');
  assert.equal(row.hours.Friday, '8:30am-4:30pm');
  assert.equal(row.hours.Saturday, 'Hours unavailable');
  assert.equal(row.notes, 'Academic Year Hours: Monday - Friday: 8:30 am - 4:30 pm');
  assert.deepEqual([row.validFrom, row.validUntil], ['2026-08-26', '2026-12-16']);
  assert.doesNotMatch(JSON.stringify(row), /5:15|Summer/);
});

test('a page that says an office is open around the clock gives every day, in its own words and with no dates', () => {
  for (const name of ['Public Safety (Emergency)', 'Public Safety (Non-Emergency)']) {
    const entry = OFFICE_HOURS_PAGES.find((office) => office.name === name)!;
    assert.equal(entry.kind, 'always');
    assert.equal(entry.url, 'https://www.ramapo.edu/publicsafety/get-support/');
    const row = parseAlwaysOpenHours(entry.name, entry.label, publicSafetyPage);
    assert.deepEqual(Object.values(row.hours), Array(7).fill('24 hours'));
    assert.equal(row.notes, 'The Public Safety Department is available 24 hours a day, 7 days a week, 365 days a year.');
    // Nothing in it is seasonal: no window is made up, and the record is still publishable.
    assert.equal(row.validFrom, undefined);
    assert.equal(recordValidity(row).window, null);
    assert.equal(partitionHoursForPublication([row], new Date('2027-06-01T12:00:00Z')).publishable.length, 1);
    assert.deepEqual(validateCampusHours([{ ...row, sourceUrl: entry.url, collectedAt: '2026-10-06T12:00:00Z' }]).map((r) => r.name), [name]);
  }
  // A page that no longer says so is an error, never a guess.
  const entry = OFFICE_HOURS_PAGES.find((office) => office.name === 'Public Safety (Emergency)')!;
  assert.throws(() => parseAlwaysOpenHours(entry.name, entry.label,
    publicSafetyPage.replace('is available 24 hours a day, 7 days a week, 365 days a year', 'is available weekdays')),
    /Always-open statement is unavailable/);
  // Two offices on one page are one capture, not two.
  const urls = OFFICE_HOURS_PAGES.map((office) => office.url);
  assert.equal(urls.filter((url) => url === entry.url).length, 2);
});

test('an office page that states two different schedules is withheld, keeping both statements', () => {
  const entry = OFFICE_HOURS_PAGES.find((office) => office.name === 'IT Help Desk')!;
  assert.equal(entry.kind, 'conflict');
  const row = parseConflictingOfficeHours(entry.name, entry.label, entry.against!, helpDeskPage);
  assert.equal(row.availabilityIssue, 'conflicting-source-schedules');
  assert.ok(Object.values(row.hours).every((value) => value === 'Hours unavailable'));
  assert.match(row.notes!, /Monday-Thursday Friday 8:30 AM - 8:00 PM 8:30 AM - 6:00 PM/);
  assert.match(row.notes!, /Fall\/Spring: Monday-Friday 8:00am-8:00pm/);
  // Published, it says only that the hours are unverified; neither schedule is stated.
  const published = campusHoursPublication([{ ...row, sourceUrl: entry.url, collectedAt: '2026-10-06T12:00:00Z' }]).publishable[0];
  assert.equal(published.availabilityIssue, 'unverified-hours');
  assert.match(published.notes!, /two different schedules for the same hours/);
  assert.doesNotMatch(JSON.stringify(published), /8:30 AM|8:00am/);
  // When the page agrees with itself, the collector stops for a person to look.
  assert.throws(() => parseConflictingOfficeHours(entry.name, entry.label, entry.against!,
    helpDeskPage.replace('Fall/Spring: Monday-Friday 8:00am-8:00pm', 'Fall/Spring: see the table above')),
    /no longer on its page/);
});

test('every reviewed office page replays from its archived capture, two offices sharing one capture', () => {
  const collectedAt = '2026-09-28T13:00:00Z';
  const pages: Record<string, string> = {
    'https://www.ramapo.edu/registrar/': 'Fall/Spring Hours:\n8:30 A.M. - 4:30 P.M. Monday - Friday',
    'https://www.ramapo.edu/student-accounts/': 'Academic Year: Monday-Friday, 8:30 a.m.-4:30 p.m.',
    'https://www.ramapo.edu/finaid/': 'Academic Year: Monday- Friday; 8:30 AM - 4:30 PM',
    'https://www.ramapo.edu/careercenter/': 'Office Hours: Monday to Friday, 8:30 am - 4:30 pm',
    'https://www.ramapo.edu/student-affairs/': 'Regular Office Hours: Monday - Friday 8:30 AM - 4:30 PM',
    'https://www.ramapo.edu/eof-program/': 'Academic Year Hours: Monday - Friday, 8:30 AM - 4:30 PM',
    'https://www.ramapo.edu/student-conduct/': 'Fall and Spring Semester Hours: Monday - Friday 8:30 AM - 4:30 PM',
    'https://www.ramapo.edu/counseling/': counselingPage,
    'https://www.ramapo.edu/publicsafety/get-support/': publicSafetyPage,
    'https://www.ramapo.edu/its/help-desk/': helpDeskPage,
    ...newOfficePages,
  };
  const html = (text: string) => `<body>${text.split('\n').map((line) => `<p>${line}</p>`).join('')}</body>`;
  const captures = [[ATHLETICS_HOURS_URL, athletics], [LIBRARY_HOURS_URL, library], [GENERAL_CAMPUS_HOURS_URL, general],
    ...Object.entries(pages)].map(([sourceUrl, text]) => ({ sourceUrl, collectedAt, html: html(text) }));
  assert.deepEqual([...new Set(OFFICE_HOURS_PAGES.map((office) => office.url))].sort(), Object.keys(pages).sort());
  const raw = campusHoursFromCaptures(captures, true, fallTerms);
  assert.equal(raw.length, 13 + OFFICE_HOURS_PAGES.length);
  // Replaying the archived captures gives the same records (terms passed in, not read from disk).
  assert.deepEqual(campusHoursFromCaptures(captures, true, fallTerms), raw);
  const byName = new Map(raw.map((row) => [row.name, row]));
  for (const office of OFFICE_HOURS_PAGES) assert.equal(byName.get(office.name)?.sourceUrl, office.url);
  const safety = ['Public Safety (Emergency)', 'Public Safety (Non-Emergency)'].map((name) => byName.get(name)!);
  assert.deepEqual(safety.map((row) => row.sourceUrl), Array(2).fill('https://www.ramapo.edu/publicsafety/get-support/'));
  const result = campusHoursPublication(raw, new Date(collectedAt));
  const published = new Map(result.publishable.map((row) => [row.name, row]));
  assert.equal(published.get('Public Safety (Emergency)')!.hours.Sunday, '24 hours');
  assert.equal(published.get('Counseling Center')!.hours.Monday, '8:30am-4:30pm');
  assert.equal(published.get('IT Help Desk')!.availabilityIssue, 'unverified-hours');
  assert.ok(result.omitted.some(({ record, reason }) => record.name === 'IT Help Desk' && reason === 'conflicting-source-schedules'));
  assert.deepEqual(validateCampusHours(raw), raw);
});

test('offices that write "through" or "until", name no label or print a summer schedule beside theirs read the same way', () => {
  const at = '2026-10-07T12:00:00Z';
  const parsed = (name: string) => {
    const entry = OFFICE_HOURS_PAGES.find((office) => office.name === name)!;
    return parseOfficeHours(name, entry.label, newOfficePages[entry.url], at, fallTerms);
  };
  const weekdays = (record: { hours: Record<string, string> }, times: string) => {
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) assert.equal(record.hours[day], times, day);
    assert.equal(record.hours.Saturday, 'Hours unavailable');
    assert.equal(record.hours.Sunday, 'Hours unavailable');
  };
  for (const name of ['Anisfield School of Business', 'Center for Student Success (Academic Advising)',
    'Office of Specialized Services', 'Payroll', 'Testing Center', 'ID Card Room', 'Nursing Programs Office']) {
    const record = parsed(name);
    weekdays(record, name === 'ID Card Room' ? '8:30am-4:00pm' : '8:30am-4:30pm');
    assert.deepEqual([record.validFrom, record.validUntil], ['2026-08-26', '2026-12-16'], name);
    assert.equal(record.notes, record.notes!.trim(), name);
  }
  // The notes keep the page's own words, including what it says about appointments.
  assert.match(parsed('ID Card Room').notes!, /make an appointment\. The ID room is open Monday-Friday from 8:30am until 4:00pm\.$/);
  assert.match(parsed('Office of Specialized Services').notes!, /Meetings by appointment\..*Office Hours Typically MON-FRI/);
  // Summer schedules beside the regular one stay out.
  assert.doesNotMatch(parsed('Payroll').notes!, /Summer/);
  assert.doesNotMatch(parsed('Testing Center').notes!, /Summer|5:15/);
  // The two new wordings, and only those.
  assert.equal(parseOfficeHours('Example', /^Hours:/i, 'Hours: Monday through Thursday, 9 am - 5 pm', at, fallTerms).hours.Thursday, '9:00am-5:00pm');
  assert.equal(parseOfficeHours('Example', /^Hours:/i, 'Hours: Monday thru Friday, 9 am - 5 pm', at, fallTerms).hours.Friday, '9:00am-5:00pm');
  assert.equal(parseOfficeHours('Example', /^Hours:/i, 'Hours: Monday - Friday, 9 am until 5 pm', at, fallTerms).hours.Monday, '9:00am-5:00pm');
  assert.throws(() => parseOfficeHours('Example', /^Hours:/i, 'Hours: Monday and Friday, 9 am - 5 pm', at, fallTerms), /unrecognized/);
  assert.throws(() => parseOfficeHours('Example', /^Hours:/i, 'Hours: Monday - Friday, 9 am or 5 pm', at, fallTerms), /unrecognized/);
});
