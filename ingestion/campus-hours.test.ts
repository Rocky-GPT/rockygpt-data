import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATHLETICS_HOURS_URL, LIBRARY_HOURS_URL, GENERAL_CAMPUS_HOURS_URL, campusHoursFromCaptures,
  campusHoursPublication, parseAthleticsFacilityHours, parseLibraryHours, parseGeneralCampusHours,
  OFFICE_HOURS_PAGES, hoursPageText, parseOfficeHours, parseAlwaysOpenHours, parseConflictingOfficeHours, parseUnstatedDayHours, parseWeeklyHours,
  parseColumnHours, BERRIE_SEASON_URL, joinAdjacentDays,
} from './campus-hours';
import { attachReviewedHoursAbsences } from './reviewed-hours-absence';
import { createHash } from 'node:crypto';
import { buildRawPageFromHtml } from './raw-collector';
import { partitionHoursForPublication, recordValidity } from '../src/data-v2/validity';
import { validateCampusHours } from './schema';
import { hoursSourceErrors } from '../pipeline/quality/hours-coverage';
import reviewData from '../src/reference/office-hours-review.json';

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

test('library capture keeps term bounds and withholds a repeated research schedule that names another year', () => {
  // The repeated sidebar names an older year above the same hours. The reader does not decide which year is
  // right: it withholds the schedule and keeps both statements as written, never calling the older year a typo.
  const stale = parseLibraryHours(library).find((row) => row.name === 'Research Help Desk')!;
  assert.equal(stale.availabilityIssue, 'conflicting-source-validity');
  assert.equal(stale.derivation, undefined);
  assert.equal(stale.notes, 'Fall Semester (Aug. 26 - Dec. 15, 2026)');
  const evidence = stale.normalization_metadata?.evidence?.schedule;
  assert.equal(evidence?.status, 'conflicting');
  assert.equal(evidence?.source_statements?.length, 2);
  assert.match(evidence!.source_statements![0], /Dec\. 15, 2026/);
  assert.match(evidence!.source_statements![1], /Dec\. 15, 2025/);
  // Different hours, or a newer year only in the repeat, withhold the same way.
  const changed = parseLibraryHours(library.replace(/(Research Help Hours\n[^]*?Mon-Thu: )9:00am/, '$110:00am'));
  assert.equal(changed.find((row) => row.name === 'Research Help Desk')?.availabilityIssue,
    'conflicting-source-validity');
  const newer = parseLibraryHours(library.replace('Dec. 15, 2025', 'Dec. 15, 2027'));
  assert.equal(newer.find((row) => row.name === 'Research Help Desk')?.availabilityIssue,
    'conflicting-source-validity');
  // A repeat that names the same year agrees with the main content and publishes.
  const consistent = parseLibraryHours(library.replace('Dec. 15, 2025', 'Dec. 15, 2026'));
  const agreed = consistent.find((row) => row.name === 'Research Help Desk')!;
  assert.equal(agreed.availabilityIssue, undefined);
  assert.equal(agreed.normalization_metadata, undefined);
  assert.throws(() => parseLibraryHours(library.replace('Mon-Thu: 7:45am', 'Unrecognized: 7:45am')),
    /missing or unrecognized days/);
  assert.throws(() => parseLibraryHours(library.replace('RESEARCH HELP HOURS',
    'Special Hours\nSep 7: CLOSED\nRESEARCH HELP HOURS')), /unparsed special hours/);
});

// The synthetic captures below carry none of the real pages' reviewed sections, so a reviewed omission
// (bound to the exact section text of the real page) cannot apply to them: replay them with none.
function withoutReviewedOmissions<T>(run: () => T): T {
  const saved = reviewData.schedules.splice(0);
  try {
    return run();
  } finally {
    reviewData.schedules.push(...saved);
  }
}

test('every published hour has its own capture provenance and every omission is accounted for', () => withoutReviewedOmissions(() => {
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
  // A facility schedule that names its season ("2026 Fall Semester Hours") publishes with that season and no
  // dates; the Research Help Desk is withheld because its repeats name two different years.
  assert.deepEqual(result.publishable.filter(row => !row.availabilityIssue).map((row) => row.name), [
    'Bradley Center (Student & Recreation Lounge)', 'Sharp Fitness Center (Weight Room)', 'Swimming Pool',
    'Auxiliary Gym', 'Rock Climbing Wall', 'Lodge Fitness Center (College Park Apartments)',
    'Library (Main Building)', 'Game Lab', 'Ramapo Bookstore', 'Ramapo Bookstore (Summer)',
  ]);
  assert.equal(result.publishable.length, 13);
  assert.equal(result.omitted.length, 3);
  assert.deepEqual(result.omitted.map((row) => row.reason).sort(), ['ambiguous-source-season',
    'conflicting-source-validity', 'source-update-only']);
  const lounge = result.publishable.find((row) => row.name.startsWith('Bradley Center'))!;
  assert.deepEqual([lounge.validFrom, lounge.validUntil], [undefined, undefined]);
  assert.equal(lounge.normalization_metadata?.evidence?.schedule?.season, '2026 Fall Semester Hours');
  assert.deepEqual(validateCampusHours(raw), raw);
  for (const row of raw) assert.equal(row.collectedAt, collectedAt);
  const pool = result.publishable.find((row) => row.name === 'Swimming Pool')!;
  assert.equal(pool.sourceUrl, ATHLETICS_HOURS_URL);
  assert.deepEqual([pool.validFrom, pool.validUntil], ['2026-09-08', '2026-12-11']);
  const main = result.publishable.find((row) => row.name === 'Library (Main Building)')!;
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
}));

test('parent page preserves facility evidence without selecting ambiguous hours or inventing a closure', () => {
  const records = parseGeneralCampusHours(general);
  // J. Lee's own schedule is read from the CSI page; this page only says to ask CSI. The Bookstore's
  // two labelled schedules are each kept with their label, as an office's undated summer schedule is.
  assert.deepEqual(records.map(row => [row.name, row.availabilityIssue]), [
    ['Administrative Offices (Normal Hours)', 'ambiguous-source-season'],
    ['Center for Student Involvement (CSI)', 'source-update-only'],
    ['Ramapo Bookstore', undefined],
    ['Ramapo Bookstore (Summer)', undefined],
  ]);
  assert.match(records[0].notes!, /Fall \/ Spring Hours/);
  assert.match(records[0].notes!, /Summer Hours/);
  assert.match(records[1].notes!, /September 23rd, 2022/);
  assert.ok(records.slice(0, 2).every(row => Object.values(row.hours).every(value => value === 'Hours unavailable')));
  assert.equal(records[2].hours.Monday, '9:00am-5:00pm');
  assert.equal(records[2].hours.Friday, '9:00am-4:00pm');
  assert.equal(records[3].hours.Monday, '10:00am-3:00pm');
  assert.match(records[3].notes!, /Starting May 14th/);
  assert.equal(records[2].normalization_metadata?.evidence?.schedule?.season, 'Normal');
  assert.equal(records[3].normalization_metadata?.evidence?.schedule?.season, 'Summer');
  assert.deepEqual(validateCampusHours(records), records);
  assert.deepEqual(parseGeneralCampusHours(`Bookstore\nUnrelated navigation\n${general}`), records);
  assert.throws(() => parseGeneralCampusHours(general.replace('J. LEE’S', 'Other facility')), /Could not find heading/);
  assert.throws(() => parseGeneralCampusHours(general.replace('Normal Store Hours:', 'Other hours:')), /seasonal schedules/);
});

test('office pages give the regular hours they print and no dates they do not', () => {
  const registrar = OFFICE_HOURS_PAGES.find((office) => office.name === 'Registrar')!;
  const at = '2026-09-28T13:00:00Z';
  // The Registrar prints its schedule on the line after its label, then the summer one.
  const page = 'Contact Information:\nFall/Spring Hours:\n8:30 A.M. - 4:30 P.M. Monday - Friday\n'
    + 'Summer Hours:\n8:00 AM - 5:15 P.M. Monday-Thursday Closed Friday';
  const fall = parseOfficeHours('Registrar', registrar.label, page, at, []);
  assert.equal(fall.hours.Monday, '8:30am-4:30pm');
  assert.equal(fall.hours.Friday, '8:30am-4:30pm');
  assert.equal(fall.hours.Saturday, 'Hours unavailable');
  assert.equal(fall.notes, 'Fall/Spring Hours: 8:30 A.M. - 4:30 P.M. Monday - Friday');
  // Neither the capture date nor the academic calendar dates an office's hours: undated stays undated.
  assert.deepEqual([fall.validFrom, fall.validUntil], [undefined, undefined]);
  assert.equal(fall.derivation, undefined);
  assert.equal(recordValidity(fall).window, null);
  // The reviewed entry's own season label is what keeps the undated schedule publishable, and it never expires.
  assert.equal(registrar.season, 'Fall/Spring');
  const seasonal = { ...fall, normalization_metadata: { evidence: { schedule: { season: registrar.season } } } };
  assert.equal(partitionHoursForPublication([seasonal], new Date('2026-09-28T12:00:00Z')).publishable.length, 1);
  assert.equal(partitionHoursForPublication([seasonal], new Date('2027-06-01T12:00:00Z')).publishable.length, 1);
  // Same-line schedules, and a Monday-Thursday week.
  const accounts = parseOfficeHours('Student Accounts', /^Academic Year:/i,
    'Academic Year: Monday-Friday, 8:30 a.m.-4:30 p.m.\nSummer: Monday-Thursday, 8:00 a.m-5:15 p.m.', at, []);
  assert.equal(accounts.hours.Friday, '8:30am-4:30pm');
  const short = parseOfficeHours('Example', /^Office Hours:/i, 'Office Hours: Monday to Thursday, 9 am - 5 pm', at, []);
  assert.equal(short.hours.Thursday, '9:00am-5:00pm');
  assert.equal(short.hours.Friday, 'Hours unavailable');
  assert.throws(() => parseOfficeHours('Registrar', registrar.label, 'Contact Information:', at, []), /line is unavailable/);
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
  // Lines as the live pages printed them on 2026-10-14.
  'https://www.ramapo.edu/international/': 'Location & Hours\nC-wing, Suite 213\nMonday - Friday: 8:30 AM - 4:30 PM\nSummer Hours\nMonday - Thursday: 8:00 AM to 5:15 PM; Friday: CLOSED',
  'https://www.ramapo.edu/ccec/': 'Location/ Hours\nPlease visit us in SC-213\nMonday through Friday: 9 a.m. - 4 p.m.\nccec@ramapo.edu',
  'https://www.ramapo.edu/csi/commuter-affairs/': 'Location/ Hours\nCenter For Student Involvement (CSI) SC-202\nMonday-Friday: 8:30am-4:30pm\nEmail: commuters@ramapo.edu',
  'https://www.ramapo.edu/military/veterans-lounge-advisement/': 'Veterans Lounge & Transfer Center\nHours of Operation: Daily, 8:30 a.m. - 4:30 p.m.',
  'https://www.ramapo.edu/snh/': 'Hours: Fall/Spring Semester: Mon., 8:30 a.m.-4:30 p.m. | Tues.- Fri., 8:30 a.m.-4:30 p.m.\nSummer: Mon.-Thur., 8:00 a.m.-5:15 p.m.',
  'https://www.ramapo.edu/ahe/': 'Email: AHEOffice@Ramapo.edu Office: B224\nHours: Monday-Friday 8:30-4:30 pm Phone: (201) 684-7365',
  'https://www.ramapo.edu/sssw/': 'Email: SSSWOffice@ramapo.edu\nHours: Mon. - Fri., 8:30 a.m. - 4:30 p.m.',
  'https://www.ramapo.edu/facilities/': 'Administrative Offices\nGrounds Maintenance\nHours\nAdministrative Offices\nMonday - Friday, 7:30 a.m. to 4:30 p.m.\n'
    + 'Building Maintenance\nMonday - Friday, 7:00a.m. to 10:30 p.m.\nSaturday & Sunday, 2:00 p.m. to 10:30 p.m.',
  'https://www.ramapo.edu/poerd/': 'Hours:\nFall/Spring, Mon. - Fri.\n8:30 a.m. - 4:30 p.m.\nSummer, Mon. - Thurs.,\n8 a.m. - 5:15 p.m.',
  'https://www.ramapo.edu/purchasing/': 'Hours of Operation\nNormal: 8:30 a.m. to 4:30 p.m.\nSummer: M. - Th. 8 a.m. to 5:15 p.m.',
  'https://www.ramapo.edu/idc/': 'Instructional Design Center Hours\nMonday-Friday | 8:30 a.m.-4:30 p.m.\n'
    + 'In-person support (LC201): Monday, Wednesday & Thursday\nRemote support: Tuesday & Friday',
  'https://www.ramapo.edu/opra/': 'RECORD ACCESS: The College is opened:\n'
    + 'Monday through Friday, 8:30 a.m. to 4:30 p.m. from the week before Labor Day to the week of Commencement,\n'
    + 'Monday through Thursday 8:00am to 5:15pm week after Commencement until the week before Labor Day.',
  'https://www.ramapo.edu/womenscenter/': 'Open Hours\nFall 2026\nMondays, 10 am - 8 pm\nTuesdays, 10 am - 6 pm\nWednesdays, 10 am - 8 pm\nThursdays, 10 am - 8 pm\nFridays, 10 am - 5 pm',
  'https://www.ramapo.edu/multicultural-center/': 'Hours of Operation\nMonday-Friday:\n1:00 p.m. to 4:30 p.m.',
  'https://www.ramapo.edu/oabc/contact-us/': 'Regular Office Hours: Monday - Friday 8:30 a.m. - 4:30 p.m.\nSummer Office Hours: Monday - Thursday 8:00 a.m. - 5:15 p.m. Closed Fridays',
  'https://www.ramapo.edu/reslife/bischoff-hall/': 'Office Hours:\nFall & Spring Semester Hours:\nMonday - Friday: 12 PM - Midnight\nSaturday & Sunday: 8 PM - Midnight\nSummer Hours:\nMonday - Thursday: 8 AM - 5:15 PM',
  'https://www.ramapo.edu/reslife/college-park-apartments-cpa/': 'Office Hours:\nFall & Spring Semester Hours:\nMonday - Friday: 12 PM - Midnight\nSaturday & Sunday: 8 PM - Midnight\nSummer Hours:\nMonday - Thursday: 8 AM - 5:15 PM',
  'https://www.ramapo.edu/reslife/laurel-hall/': 'Office Hours:\nFall & Spring Semester Hours:\nMonday - Friday: 12 PM - Midnight\nSaturday & Sunday: 8 PM - Midnight\nSummer Hours:\nMonday - Thursday: 8 AM - 5:15 PM',
  'https://www.ramapo.edu/reslife/mackin-hall/': 'Office Hours:\nFall & Spring Semester Hours:\nMonday - Friday: 12 PM - Midnight\nSaturday & Sunday: 8 PM - Midnight\nSummer Hours:\nMonday - Thursday: 8 AM - 5:15 PM',
  'https://www.ramapo.edu/reslife/pine-hall/': 'Office Hours:\nFall & Spring Semester Hours:\nMonday - Friday: 12 PM - Midnight\nSaturday & Sunday: 8 PM - Midnight\nSummer Hours:\nMonday - Thursday: 8 AM - 5:15 PM',
  'https://www.ramapo.edu/reslife/the-overlook/': 'Office Hours:\nFall & Spring Semester Hours:\nMonday - Friday: 12 PM - Midnight\nSaturday & Sunday: 8 PM - Midnight\nSummer Hours:\nMonday - Thursday: 8 AM - 5:15 PM',
  'https://www.ramapo.edu/reslife/village/': 'Office Hours:\nFall & Spring Semester Hours:\nMonday - Friday: 12 PM - Midnight\nSaturday and Sunday: 8 PM - Midnight\nSummer Hours:\nMonday - Thursday: 8 AM - 5:15 PM\nFriday: Closed',
  'https://www.ramapo.edu/studentsuccess/': 'Center for Student Success\nD-207 (Academic Building)\nMonday-Friday\n8:30 a.m.-4:30 p.m.',
  'https://www.ramapo.edu/oss/': 'MAIN OFFICE: C-Wing, Room 205 - Meetings by appointment. | Office Hours Typically MON-FRI, 8:30 AM-4:30 PM | (201) 684-7514',
  'https://www.ramapo.edu/payroll/': 'Hours:\nFall/Spring, Mon. - Fri.\n8:30 a.m. - 4:30 p.m.\nSummer, Mon. - Thurs.,\n8 a.m. - 5:15 p.m.',
  'https://www.ramapo.edu/testing/': 'Hours\nSummer\nMonday to Thursday, 8:00 a.m. to 5:15 p.m.\nClosed Friday\nFall and Spring\nMonday to Friday, 8:30 a.m. to 4:30 p.m.',
  'https://www.ramapo.edu/publicsafety/id-cards/': 'In order to get a new identification card, please contact the ID room at publicsafety@ramapo.edu and make an appointment. The ID room is open Monday-Friday from 8:30am until 4:00pm.',
  'https://www.ramapo.edu/nursing/': 'Nursing Programs Contact Information:\nOffice: Adler Center for Nursing Excellence 215\nHours: Monday through Friday, 8:30 a.m.to 4:30 p.m.\nPhone: (201) 684-7749',
  'https://www.ramapo.edu/crw/': 'ANNOUNCEMENTS - Fall 2026\nThe CRW will open on August 31 at 10 AM.\nHours\nMonday - Thursday, 10 AM - 8:00 PM\nFriday - 10:00 AM - 4:00 PM\nWeekends - by virtual appointment\nPeter P. Mercer Learning Commons | Room 420 (4th floor)\np: 201-684-7557 | Summer: 201-684-7561',
  'https://www.ramapo.edu/csi/': "CSI Hours of Operation\nThe CSI main office is open Monday through Fridays 8:00am-midnight, Saturday from 4:00-10:00pm and Sunday from 3:00-8:00pm.\nJ.Lee's is open during the following hours:\nMondays-Thursdays 9 am-10 pm\nFridays: 9 am-9 pm\nSundays: 1 pm-6 pm\nCampus Hours",
  'https://www.ramapo.edu/csi/roadrunner-central/': 'Hours of Operation:\nPlease visit the Center for Student Involvement Main Office, located in SC202, for assistance during the following hours during the semester:\nMonday-Friday: 8:00am-12:00am\nSaturday- 4:00pm-10:00pm\nSunday- 3:00pm-8:00pm\nDuring the Summer months, our hours are as follows:\nMonday-Thursday: 8:00am-5:15pm',
  'https://www.ramapo.edu/photolab/hours/': "OPEN LAB HOURS\nThroughout the Fall and Spring semesters The Photography Suite (BC 135) is open six days a week.\nFALL 2026\nWe're open 6 days a week! No need to make reservations for the darkroom. We look forward to seeing you in the lab!\nSunday 6pm - 9pm\nMonday 10am - 6pm\nTuesday 10am - 6pm\nWednesday 10am - 8pm\nThursday 10am - 5pm\nFriday 10am - 6pm\nSaturday Closed",
};

test('the Counseling Center publishes its academic-year hours, and its summer ones are a separate entry', () => {
  const entry = OFFICE_HOURS_PAGES.find((office) => office.name === 'Counseling Center')!;
  const row = parseOfficeHours(entry.name, entry.label, counselingPage, '2026-09-28T13:00:00Z', fallTerms);
  assert.equal(row.hours.Monday, '8:30am-4:30pm');
  assert.equal(row.hours.Friday, '8:30am-4:30pm');
  assert.equal(row.hours.Saturday, 'Hours unavailable');
  assert.equal(row.notes, 'Academic Year Hours: Monday - Friday: 8:30 am - 4:30 pm');
  assert.deepEqual([row.validFrom, row.validUntil], [undefined, undefined]);
  assert.doesNotMatch(JSON.stringify(row), /5:15|Summer/);
  const summer = OFFICE_HOURS_PAGES.find((office) => office.name === 'Counseling Center (Summer)')!;
  const summerRow = parseOfficeHours(summer.name, summer.label, counselingPage, '2026-09-28T13:00:00Z', fallTerms);
  assert.equal(summerRow.hours.Thursday, '8:00am-5:15pm');
  assert.equal(summerRow.hours.Friday, 'CLOSED');
  assert.equal(summer.season, 'Summer');
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

test('an office page that states two different schedules can be withheld, keeping both statements', () => {
  // The `conflict` kind is no entry's today (the IT Help Desk's two statements are stored as readings), but it
  // remains for a page whose statements cannot be stored as schedules; here it reads the same page as before.
  const entry = {
    name: 'IT Help Desk', url: 'https://www.ramapo.edu/its/help-desk/',
    label: /Fall \/ Spring\nMonday-Thursday\nFriday\n8:30 AM - 8:00 PM\n8:30 AM - 6:00 PM/,
    against: /Fall\/Spring: Monday-Friday 8:00am-8:00pm/i,
  };
  const row = parseConflictingOfficeHours(entry.name, entry.label, entry.against!, helpDeskPage);
  assert.equal(row.availabilityIssue, 'conflicting-source-schedules');
  assert.ok(Object.values(row.hours).every((value) => value === 'Hours unavailable'));
  assert.match(row.notes!, /Monday-Thursday Friday 8:30 AM - 8:00 PM 8:30 AM - 6:00 PM/);
  assert.match(row.notes!, /Fall\/Spring: Monday-Friday 8:00am-8:00pm/);
  // Published, it says only that the hours are unverified; neither schedule is stated.
  const published = campusHoursPublication([{ ...row, sourceUrl: entry.url, collectedAt: '2026-10-06T12:00:00Z' }]).publishable[0];
  assert.equal(published.availabilityIssue, 'unverified-hours');
  assert.match(published.notes!, /two different schedules for the same hours/);
  // The student-facing fields state neither schedule; both statements stay in the row's evidence, as written.
  assert.ok(Object.values(published.hours).every((value) => value === 'Hours unavailable'));
  assert.doesNotMatch(JSON.stringify({ hours: published.hours, notes: published.notes }), /8:30 AM|8:00am/);
  const evidence = published.normalization_metadata?.evidence?.schedule;
  assert.equal(evidence?.status, 'conflicting');
  assert.equal(evidence?.source_statements?.length, 2);
  assert.match(evidence!.source_statements![0], /8:30 AM - 8:00 PM/);
  assert.match(evidence!.source_statements![1], /Fall\/Spring: Monday-Friday 8:00am-8:00pm/);
  // When the page agrees with itself, the collector stops for a person to look.
  assert.throws(() => parseConflictingOfficeHours(entry.name, entry.label, entry.against!,
    helpDeskPage.replace('Fall/Spring: Monday-Friday 8:00am-8:00pm', 'Fall/Spring: see the table above')),
    /no longer on its page/);
});

test('the IT Help Desk page prints two different Fall/Spring schedules; both are kept, neither chosen', () => {
  const [table, list] = OFFICE_HOURS_PAGES.filter((office) => office.name === 'IT Help Desk');
  assert.equal(table.kind, 'columns');
  assert.equal(table.season, 'Fall/Spring');
  assert.equal(list.season, 'Fall/Spring');
  // The "Hours of Support" table: one row of day ranges over one row of times, paired by position.
  const a = parseColumnHours(table.name, table.label, helpDeskPage);
  assert.deepEqual(Object.values(a.hours), ['8:30am-8:00pm', '8:30am-8:00pm', '8:30am-8:00pm', '8:30am-8:00pm',
    '8:30am-6:00pm', 'Hours unavailable', 'Hours unavailable']);
  assert.equal(a.notes, 'Monday-Thursday 8:30 AM - 8:00 PM; Friday 8:30 AM - 6:00 PM');
  // The list under "Ways to submit a ticket": one line, Monday-Friday.
  const b = parseOfficeHours(list.name, list.label, helpDeskPage, '2026-10-12T12:00:00Z', []);
  assert.deepEqual(Object.values(b.hours), [...Array(5).fill('8:00am-8:00pm'), 'Hours unavailable', 'Hours unavailable']);
  // A table that loses a cell stops the collector instead of being guessed at.
  assert.throws(() => parseColumnHours(table.name, table.label, helpDeskPage.replace('8:30 AM - 6:00 PM\n', '')),
    /row of days over a row of times/);
  assert.throws(() => parseColumnHours(table.name, table.label, helpDeskPage.replace('Monday-Thursday\nFriday', 'Monday-Thursday\nThursday')),
    /states two schedules for Thursday/);
  assert.throws(() => parseColumnHours(table.name, /^Missing label$/i, helpDeskPage), /line is unavailable/);
});

test('every reviewed office page replays from its archived capture, two offices sharing one capture', () => withoutReviewedOmissions(() => {
  const collectedAt = '2026-09-28T13:00:00Z';
  // Lines as the live pages printed them on 2026-10-07 (read in memory, not stored).
  const counselingFull = `${counselingPage}\nDrop-In Hours\nMonday-Friday, 1-3 pm* in Academic Building D, room 216\n`
    + 'Location: In person or via telehealth - please call 201-684-7522 during drop-in hours\n*Last meeting begins at 2:40 pm.';
  const pages: Record<string, string> = {
    'https://www.ramapo.edu/registrar/': 'Fall/Spring Hours:\n8:30 A.M. - 4:30 P.M. Monday - Friday\nSummer Hours:\n8:00 AM - 5:15 P.M. Monday-Thursday Closed Friday',
    'https://www.ramapo.edu/student-accounts/': 'Academic Year: Monday-Friday, 8:30 a.m.-4:30 p.m.\nSummer: Monday-Thursday, 8:00 a.m.-5:15 p.m.',
    'https://www.ramapo.edu/student-accounts/contacts/': 'Hours of Operation:\nAcademic Year: Monday - Friday, 8:30 a.m. - 4:00 p.m.\nSummer: Monday - Thursday, 8:00 a.m. - 4:30 p.m. Closed Fridays',
    'https://www.ramapo.edu/finaid/': 'Academic Year: Monday- Friday; 8:30 AM - 4:30 PM\nSummer: Monday - Thursday; 8:00 AM - 5:15 PM',
    'https://www.ramapo.edu/careercenter/': 'Office Hours: Monday to Friday, 8:30 am - 4:30 pm\nSummer Office Hours: Monday to Thursday, 8:00 am - 5:15 pm',
    'https://www.ramapo.edu/student-affairs/': 'Regular Office Hours: Monday - Friday 8:30 AM - 4:30 PM\nSummer Office Hours: Monday - Thursday 8:00 AM - 5:15 PM',
    'https://www.ramapo.edu/eof-program/': 'Academic Year Hours: Monday - Friday, 8:30 AM - 4:30 PM\nSummer Hours: Monday - Thursday, 8:00 AM - 5:15 PM',
    'https://www.ramapo.edu/student-conduct/': 'Fall and Spring Semester Hours: Monday - Friday 8:30 AM - 4:30 PM\nSummer Hours: Monday - Thursday 8:00 AM - 5:15 PM',
    'https://www.ramapo.edu/counseling/': counselingFull,
    'https://www.ramapo.edu/counseling/faq/': 'If you are experiencing a mental health emergency after hours, call the main number (201-684-7522) and press 2 for immediate assistance. Emergency counseling is available 24/7 at 201-684-7522.',
    'https://www.ramapo.edu/publicsafety/get-support/': publicSafetyPage,
    'https://www.ramapo.edu/its/help-desk/': helpDeskPage,
    'https://www.ramapo.edu/reslife/earlyarrival/': 'ID Room. Residents who have lost or damaged their Ramapo ID must visit the ID Room to obtain a replacement before checking in. ID Room hours: Monday to Friday, 8:30 AM to 4:30 PM.',
    'https://www.ramapo.edu/berriecenter/tickets-seating/': 'Box Office Schedule\nAs of August 26, 2026 the Box Office is open:\nMonday-Friday from 12:00pm to 3:00pm\n1 Hour Prior to All Performances',
    'https://www.ramapo.edu/student-affairs/student-communications/official-announcement-health-services-at-ramapo-college-july-14-2026/':
      'Date: Tue, Jul 14, 2026 at 2:03 PM\nLocated at the South Entrance, VMG will be open Monday through Friday from 8:30 a.m. to 4:30 p.m. in the Fall semester (summer hours are Monday through Thursday, 8:30 a.m. to 4:30 p.m.). Appointments can be made by calling 201-684-7536.',
    ...newOfficePages,
  };
  const html = (text: string) => `<body>${text.split('\n').map((line) => `<p>${line}</p>`).join('')}</body>`;
  const captures = [[ATHLETICS_HOURS_URL, athletics], [LIBRARY_HOURS_URL, library], [GENERAL_CAMPUS_HOURS_URL, general],
    [BERRIE_SEASON_URL, 'The Box Office is open from late August to early May. Our hours are Monday-Friday from 12pm to 3pm.'],
    ...Object.entries(pages)].map(([sourceUrl, text]) => ({ sourceUrl, collectedAt, html: html(text) }));
  assert.deepEqual([...new Set(OFFICE_HOURS_PAGES.map((office) => office.url))].sort(), Object.keys(pages).sort());
  const raw = campusHoursFromCaptures(captures, true, fallTerms);
  assert.equal(raw.length, 13 + OFFICE_HOURS_PAGES.length);
  // Replaying the archived captures gives the same records.
  assert.deepEqual(campusHoursFromCaptures(captures, true, fallTerms), raw);
  for (const office of OFFICE_HOURS_PAGES) {
    assert.ok(raw.some((row) => row.name === office.name && row.sourceUrl === office.url), `${office.name} ${office.url}`);
  }
  const byName = new Map(raw.map((row) => [row.name, row]));
  const safety = ['Public Safety (Emergency)', 'Public Safety (Non-Emergency)'].map((name) => byName.get(name)!);
  assert.deepEqual(safety.map((row) => row.sourceUrl), Array(2).fill('https://www.ramapo.edu/publicsafety/get-support/'));
  const result = campusHoursPublication(raw, new Date(collectedAt));
  const published = new Map(result.publishable.map((row) => [row.name, row]));
  assert.equal(published.get('Public Safety (Emergency)')!.hours.Sunday, '24 hours');
  assert.equal(published.get('Counseling Center')!.hours.Monday, '8:30am-4:30pm');
  // Both Fall/Spring statements are kept as their own records under one name; neither is withheld.
  assert.equal(raw.filter((row) => row.name === 'IT Help Desk').length, 2);
  assert.ok(!result.omitted.some(({ record }) => record.name === 'IT Help Desk'));
  // No office is dated by the academic calendar: only a date its own page prints becomes a boundary.
  assert.equal(byName.get('Center for Reading and Writing')?.validFrom, '2026-08-31');
  assert.equal(byName.get('Berrie Center Box Office')?.validFrom, '2026-08-26');
  const dated = raw.filter((row) => OFFICE_HOURS_PAGES.some((office) => office.name === row.name) && (row.validFrom || row.validUntil));
  assert.deepEqual(dated.map((row) => row.name).sort(), ['Berrie Center Box Office', 'Center for Reading and Writing']);
  assert.ok(raw.filter((row) => row.name.endsWith('(Summer)')).every((row) => row.normalization_metadata?.evidence?.schedule?.season?.startsWith('Summer')));
  // Two pages that print different Student Accounts hours keep both readings under the one name.
  assert.deepEqual(raw.filter((row) => row.name === 'Student Accounts').map((row) => row.sourceUrl),
    ['https://www.ramapo.edu/student-accounts/', 'https://www.ramapo.edu/student-accounts/contacts/']);
  // The ID Room's early-arrival hours differ from its routine ones; neither replaces the other.
  const early = byName.get('ID Card Room (Early Arrival)')!;
  assert.equal(early.normalization_metadata?.evidence?.schedule?.status, 'conflicting');
  assert.equal(early.sourceUrl, 'https://www.ramapo.edu/reslife/earlyarrival/');
  assert.equal(byName.get('ID Card Room')!.hours.Monday, '8:30am-4:00pm');
  assert.deepEqual(validateCampusHours(raw), raw);
}));

test('a reviewed hours omission attaches only while its captured section is unchanged', () => {
  const url = 'https://www.ramapo.edu/registrar/';
  const collectedAt = '2026-10-07T12:00:00Z';
  const html = (phone: string) => `<html><body><main><h2>Contact Information:</h2><p>Phone: ${phone}</p>`
    + '<p>Fall/Spring Hours:</p><p>8:30 A.M. - 4:30 P.M. Monday - Friday</p></main></body></html>';
  const section = (source: string) => {
    const page = buildRawPageFromHtml({ url, html: source, sourceType: 'seed', statusCode: 200, fetchedAt: collectedAt, allowedHost: 'www.ramapo.edu' });
    return page.sections[0];
  };
  const reviewed = section(html('(201) 684-7000'));
  const review = { schedule: 'Registrar', source_url: url, scope: 'Registrar timetable', reason: 'The section prints no weekend hours or dates.',
    missing_weekdays: ['Saturday', 'Sunday'], missing_validity: ['valid_from' as const, 'valid_until' as const],
    checks: [{ url, section: reviewed.heading, section_sha256: createHash('sha256').update(`${reviewed.heading}\n${reviewed.text}`).digest('hex') }] };
  const record = { name: 'Registrar', sourceUrl: url, collectedAt, notes: 'Fall/Spring Hours: 8:30 A.M. - 4:30 P.M. Monday - Friday',
    hours: { Monday: '8:30am-4:30pm', Tuesday: '8:30am-4:30pm', Wednesday: '8:30am-4:30pm', Thursday: '8:30am-4:30pm',
      Friday: '8:30am-4:30pm', Saturday: 'Hours unavailable', Sunday: 'Hours unavailable' } };
  const capture = (phone: string) => [{ sourceUrl: url, collectedAt, html: html(phone) }];
  // The reviewed schedule list stands in for the real file's, so only this one entry applies.
  const attach = (records: typeof record[], captures: ReturnType<typeof capture>) => {
    const saved = reviewData.schedules.splice(0, reviewData.schedules.length, review);
    try {
      return attachReviewedHoursAbsences(records as never, captures);
    } finally {
      reviewData.schedules.splice(0, reviewData.schedules.length, ...saved);
    }
  };
  const [attached] = attach([record], capture('(201) 684-7000'));
  const claims = attached.normalization_metadata?.evidence?.schedule?.not_published ?? [];
  assert.deepEqual(claims.map((claim) => claim.field), ['weekday_hours', 'valid_from', 'valid_until']);
  assert.deepEqual(claims[0].days, ['Saturday', 'Sunday']);
  assert.equal(claims[0].checks[0].checked_at, collectedAt);
  // Another record, or a review of another page, is left alone.
  assert.deepEqual(attach([{ ...record, name: 'Payroll' }], [])[0], { ...record, name: 'Payroll' });
  // A changed section, a missing capture, or a day the capture does state each stop the collector.
  assert.throws(() => attach([record], capture('(201) 684-7001')), /Reviewed hours section changed/);
  assert.throws(() => attach([record], []), /needs one source capture/);
  assert.throws(() => attach([{ ...record, hours: { ...record.hours, Saturday: '9:00am-1:00pm' } }], capture('(201) 684-7000')),
    /contradict the captured schedule/);
  assert.throws(() => attach([{ ...record, validFrom: '2026-08-26' } as typeof record], capture('(201) 684-7000')),
    /contradicts the captured schedule/);
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
    assert.deepEqual([record.validFrom, record.validUntil], [undefined, undefined], name);
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

test('pages that print a different time for different days read as a weekly schedule, exactly as printed', () => {
  const at = '2026-10-07T12:00:00Z';
  const week = (name: string) => {
    const entry = OFFICE_HOURS_PAGES.find((office) => office.name === name)!;
    assert.equal(entry.kind, 'week');
    return parseWeeklyHours(name, entry.label, newOfficePages[entry.url], at, fallTerms);
  };
  const days = (record: { hours: Record<string, string> }) => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    .map((day) => record.hours[day]);
  const reading = week('Center for Reading and Writing');
  assert.deepEqual(days(reading), Array(4).fill('10:00am-8:00pm').concat('10:00am-4:00pm', 'By virtual appointment', 'By virtual appointment'));
  assert.equal(reading.notes, 'Hours Monday - Thursday, 10 AM - 8:00 PM Friday - 10:00 AM - 4:00 PM Weekends - by virtual appointment');
  // One sentence with three segments, an "until midnight" end, and a start whose am/pm is the end's.
  const involvement = week('Center for Student Involvement');
  assert.deepEqual(days(involvement), Array(5).fill('8:00am-12:00am').concat('4:00pm-10:00pm', '3:00pm-8:00pm'));
  assert.doesNotMatch(involvement.notes!, /Lee/); // The lounge's hours beside it are another place's.
  const central = week('Roadrunner Central');
  assert.deepEqual(days(central), days(involvement));
  assert.doesNotMatch(central.notes!, /Summer|5:15/); // The undated summer schedule stays out.
  const lab = week('Photography Lab');
  assert.deepEqual(days(lab), ['10:00am-6:00pm', '10:00am-6:00pm', '10:00am-8:00pm', '10:00am-5:00pm', '10:00am-6:00pm', 'CLOSED', '6:00pm-9:00pm']);
  for (const record of [reading, involvement, central, lab]) {
    // The reader attaches no dates: a boundary is only a date the page itself prints (the CRW's opening day).
    assert.deepEqual([record.validFrom, record.validUntil], [undefined, undefined]);
  }
});

test('a weekly schedule the reader cannot fully account for stops the collector instead of being guessed', () => {
  const at = '2026-10-07T12:00:00Z';
  const read = (page: string) => parseWeeklyHours('Example', /^Hours$/i, page, at, fallTerms);
  assert.throws(() => read('Hours\nMonday 9am - 5pm\nMonday 10am - 6pm'), /two schedules for Monday/);
  assert.equal(read('Hours\nMonday 9am - 5pm\nMonday 9am - 5pm').hours.Monday, '9:00am-5:00pm');
  assert.throws(() => read('Hours\nMonday 10pm - 2am'), /do not run forward/);
  assert.throws(() => read('Hours\nSaturday 11 - 1pm'), /do not run forward/);
  assert.throws(() => read('Hours\nSaturday 8 - midnight'), /Unable to read the time/);
  assert.throws(() => read('Hours\nFriday - Monday 9am - 5pm'), /Unable to read the days/);
  assert.throws(() => read('Hours\nOpen all week'), /unrecognized/);
  assert.throws(() => read('Hours\none\ntwo\nthree\nfour\nMonday 9am - 5pm'), /unrecognized/);
  assert.throws(() => read('Closed on weekends'), /line is unavailable/);
  // The block ends at the first line that is not purely schedule, and that line must not mention a day:
  // a day that was not understood is a schedule that was not read, so the collector stops.
  assert.throws(() => read('Hours\nMonday 9am - 5pm\nTuesday call us\nWednesday 9am - 5pm'), /mentions a day/);
  assert.throws(() => read('Hours\nMonday 9am - 5pm\nThe lounge next door is open Tuesday 9am - 5pm'), /mentions a day/);
  assert.throws(() => read('Hours\nWe are open Monday 9am - 5pm. Questions? Ask.\nTuesday 9am - 5pm'), /mentions a day/);
  const ended = read('Hours\nMonday 9am - 5pm\nTuesday 9am - 5pm\nRoom 420 | phone 201-684-7557');
  assert.deepEqual([ended.hours.Monday, ended.hours.Tuesday, ended.hours.Wednesday], ['9:00am-5:00pm', '9:00am-5:00pm', 'Hours unavailable']);
  const prose = read('Hours\nWe are open Monday 9am - 5pm. Questions? Ask.\nSee the room for details.');
  assert.deepEqual([prose.hours.Monday, prose.hours.Tuesday], ['9:00am-5:00pm', 'Hours unavailable']);
  // Whatever a line says beyond its segments must be plain prose: a split shift, an exception, a day list.
  assert.throws(() => read('Hours\nMonday 9am - 12pm and 1pm - 5pm'), /cannot account for/);
  assert.throws(() => read('Hours\nMonday - Friday 9am - 5pm except holidays'), /cannot account for/);
  assert.throws(() => read('Hours\nMon, Wed, Fri 9am - 5pm'), /cannot account for/);
  assert.throws(() => read('Hours\nMonday 9am - 5pm\nTuesday 9am - 5pm by appointment only'), /cannot account for|mentions a day/);
  // Prose before the schedule may not be about another season or a closure.
  assert.throws(() => read('Hours\nSummer hours are shorter.\nMonday 9am - 5pm'), /before its schedule/);
  assert.throws(() => read('Hours\nThe office is closed over winter break.\nMonday 9am - 5pm'), /before its schedule/);
  // A hyphen character other than "-" still joins the days of a range.
  for (const dash of ['\u2010', '\u2011', '\u2012', '\u2212']) {
    const text = hoursPageText(`<body><p>Hours: Monday ${dash} Friday, 9 am - 5 pm</p></body>`);
    assert.equal(parseOfficeHours('Example', /^Hours:/i, text, at, fallTerms).hours.Friday, '9:00am-5:00pm', dash);
  }
  // A page that names its term is read through a label that names it too, so a new term's heading stops the
  // collector, and a label that matches two lines is no label.
  const named = (heading: string) => parseWeeklyHours('Example', /^FALL 2026$/i, `${heading}\nMonday 9am - 5pm`, at, []);
  assert.equal(named('FALL 2026').hours.Monday, '9:00am-5:00pm');
  assert.throws(() => named('SPRING 2027'), /line is unavailable/);
  assert.throws(() => read('Hours\nMonday 9am - 5pm\nHours\nTuesday 9am - 5pm'), /matches more than one line/);
  assert.throws(() => parseOfficeHours('Example', /^Hours:/i, 'Hours: Monday - Friday, 9 am - 5 pm\nHours: Monday - Friday, 10 am - 6 pm', at, fallTerms), /matches more than one line/);
  assert.throws(() => parseOfficeHours('Example', /^Hours:/i, 'Hours: Monday - Friday, 9 am - 5 pm, closed until 10 am - 11 am', at, fallTerms), /more than one time range/);
  assert.equal(read('Hours\nWeekdays 9am - 5pm\nWeekends Closed').hours.Sunday, 'CLOSED');
});

test('two adjacent days joined by & or "and" are those two days; any other pair stops the reader', () => {
  assert.equal(joinAdjacentDays('Saturday & Sunday: 8 PM - Midnight'), 'Saturday - Sunday: 8 PM - Midnight');
  assert.equal(joinAdjacentDays('Saturday and Sunday: 8 PM - Midnight'), 'Saturday - Sunday: 8 PM - Midnight');
  assert.equal(joinAdjacentDays('Fall & Spring Semester Hours:'), 'Fall & Spring Semester Hours:');
  assert.throws(() => joinAdjacentDays('Monday & Wednesday: 1 PM - 3 PM'), /two adjacent days/);
});

test('"Daily" office hours are every day of the week', () => {
  const read = parseOfficeHours('Lounge', /^Hours of Operation:/i, 'Hours of Operation: Daily, 8:30 a.m. - 4:30 p.m.', '2026-10-14T00:00:00Z', []);
  assert.deepEqual(Object.values(read.hours), Array(7).fill('8:30am-4:30pm'));
});

test('an opening time without am/pm is read only when one half of the day runs forward', () => {
  const read = (line: string) => parseOfficeHours('AHE', /^Hours:/i, `Hours: ${line}`, '2026-10-14T00:00:00Z', []);
  assert.equal(read('Monday-Friday 8:30-4:30 pm').hours.Monday, '8:30am-4:30pm');
  assert.throws(() => read('Monday-Friday 1-3 pm'), /am or pm/);
  assert.equal(read('Mon. - Fri., 8:30 a.m. - 4:30 p.m.').hours.Friday, '8:30am-4:30pm');
});

test('hours a page states with no weekdays keep every day unpublished, and "M. - Th." is a day range', () => {
  const text = 'Hours of Operation\nNormal: 8:30 a.m. to 4:30 p.m.\nSummer: M. - Th. 8 a.m. to 5:15 p.m.';
  const normal = parseUnstatedDayHours('Purchasing Department', /^Normal:/i, text);
  assert.ok(Object.values(normal.hours).every((hours) => hours === 'Hours unavailable'));
  assert.equal(normal.notes, 'Normal: 8:30 a.m. to 4:30 p.m.');
  assert.throws(() => parseUnstatedDayHours('X', /^Normal:/i, 'Normal: Monday - Friday 8:30 a.m. to 4:30 p.m.'), /now names its days/);
  const summer = parseOfficeHours('Purchasing Department (Summer)', /^(?=Summer: M\.)/i, text, '2026-10-15T12:00:00Z', []);
  assert.deepEqual([summer.hours.Monday, summer.hours.Thursday, summer.hours.Friday], ['8:00am-5:15pm', '8:00am-5:15pm', 'Hours unavailable']);
  // "a.m. to" is not "M. to": a time is never read as a day.
  assert.throws(() => parseOfficeHours('Y', /^Open:/i, 'Open: 8 a.m. to 4 p.m.', '2026-10-15T12:00:00Z', []), /unrecognized/);
});
