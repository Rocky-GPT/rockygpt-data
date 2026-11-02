import assert from 'node:assert/strict';
import test from 'node:test';

import { calendarConcept } from './calendar-concepts';

function kindOf(title: string): string | undefined {
  return calendarConcept('Fall 2026', { date: 'Dec. 15', title }).kind;
}

test("a term's own last day of instruction is classes_end, not other", () => {
  // The reported bug. Every published term carries this row, and it was the
  // only record naming when the semester itself ends — filed as `other`, so
  // `classes_end` held nothing but the sub-sessions and "when does the fall
  // semester end" answered with Session I's date in October.
  assert.equal(kindOf('Full and Session II Courses - Last Day of the Semester'), 'classes_end');
  // The source spells the same row with an en dash in later terms.
  assert.equal(kindOf('Full and Session II Courses – Last Day of the Semester'), 'classes_end');
});

test('a session ending is still classes_end', () => {
  assert.equal(kindOf('Session I Courses - Last Day of the Session'), 'classes_end');
  assert.equal(kindOf('First Day of Classes'), 'classes_begin');
});

test('a deadline that merely falls on a last day keeps its own kind', () => {
  // `last day of` appears in several deadline titles. Widening the instruction
  // rule must not swallow them.
  assert.equal(
    kindOf('Full Semester Courses - Last Day of Add/Drop for 100% Tuition Refund'),
    'add_drop_deadline'
  );
  assert.equal(
    kindOf('Session I Courses - Last Day of Add/Drop for 100% Tuition Refund'),
    'add_drop_deadline'
  );
  assert.equal(kindOf('Fall 2026 - Full and Session II Courses - Faculty Grades Due'), 'grades_due');
});

test('a row that is genuinely two things keeps the more specific one', () => {
  // Winter files its semester end and its finals as one row, and its last day
  // of classes with a grading deadline. Both readings are true; the classifier
  // takes the first rule that matches and these stay where they were.
  assert.equal(kindOf('Finals and the Last Day of Winter Semester'), 'finals');
  assert.equal(
    kindOf('Last Day of Classes and to Request an Incomplete Grade ("I" Grade)'),
    'grading_option_deadline'
  );
});

test('a date just outside its term takes the year nearest the term', () => {
  // Winter 2027 lists its December start; it was dated December 2027, a year late.
  assert.equal(calendarConcept('Winter 2027', { date: 'Dec. 17', title: 'First Day of Winter Classes' }).startsAt?.slice(0, 10), '2026-12-17');
  assert.equal(calendarConcept('Winter 2027', { date: 'Jan. 13', title: 'Finals and the Last Day of Winter Semester' }).startsAt?.slice(0, 10), '2027-01-13');
  // A fall term's January grades are the next year's January.
  assert.equal(calendarConcept('Fall 2026', { date: 'Jan. 04', title: 'Fall Grades Posted' }).startsAt?.slice(0, 10), '2027-01-04');
  assert.equal(calendarConcept('Spring 2027', { date: 'Jun. 17', title: 'June - Degree Conferral Date' }).startsAt?.slice(0, 10), '2027-06-17');
  assert.equal(calendarConcept('Fall 2026', { date: 'Aug. 26', title: 'Classes Begin' }).startsAt?.slice(0, 10), '2026-08-26');
});

test("a term's named first day of classes is classes_begin", () => {
  assert.equal(kindOf('First Day of Winter Classes'), 'classes_begin');
});
