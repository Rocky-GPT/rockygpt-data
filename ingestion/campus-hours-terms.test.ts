import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredOfficeHours, OFFICE_HOURS_PAGES } from './campus-hours';

// Audit 2026-11-17, cause 6: readers with the term written into them stop reading next term.
const office = (name: string) => OFFICE_HOURS_PAGES.find((entry) => entry.name === name)!;
const at = '2027-01-10T12:00:00Z';
const crwHours = 'Hours\nMonday - Thursday, 10 AM - 8:00 PM\nFriday - 10:00 AM - 4:00 PM\nWeekends - by virtual appointment';

test("the writing center's term and opening date come from its own announcement", () => {
  const spring = configuredOfficeHours(office('Center for Reading and Writing'),
    `ANNOUNCEMENTS - Spring 2027\nThe CRW will open on January 20 at 10 AM.\n${crwHours}`, at);
  assert.equal(spring.validFrom, '2027-01-20');
  assert.equal(spring.normalization_metadata?.evidence?.schedule?.season, 'Spring 2027');
  assert.match(spring.notes!, /^The CRW will open on January 20 at 10 AM\. Spring 2027: Hours/);
  assert.equal(spring.hours.Friday, '10:00am-4:00pm');
});

test('without an announcement the writing center still reads, undated', () => {
  const plain = configuredOfficeHours(office('Center for Reading and Writing'), `Welcome to the CRW\n${crwHours}`, at);
  assert.equal(plain.validFrom, undefined);
  assert.equal(plain.normalization_metadata?.evidence?.schedule?.season, undefined);
  assert.equal(plain.hours.Monday, '10:00am-8:00pm');
});

test("the Box Office's opening date is whatever date its page prints", () => {
  const box = configuredOfficeHours(office('Berrie Center Box Office'),
    'Box Office Schedule\nAs of January 19, 2027 the Box Office is open:\nMonday-Friday from 12:00pm to 3:00pm\n1 Hour Prior to All Performances', at);
  assert.equal(box.validFrom, '2027-01-19');
  assert.equal(box.hours.Wednesday, '12:00pm-3:00pm');
});
