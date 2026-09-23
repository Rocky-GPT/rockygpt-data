import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCalendarHtml, mergeCalendarSemesters } from './academic-calendar';
import { validateAcademicCalendar } from './schema';
import { calendarWithConcepts } from '../src/data-v2/calendar-concepts';

const event = (title: string, time = '12:00 am') => `<div class="ramapo-tribe-event-body"><span class="month">Aug.</span><span class="date">26</span><div class="ramapo-tribe-event-title"><a>${title}</a></div><div class="ramapo-tribe-event-time">${time}</div></div>`;

test('the semester repeated across current and future pages is published once', () => {
  const current = `<h1>Fall 2026</h1>${event('Classes Begin')}${event('Another Published Event')}`;
  const future = `<div class="collapsableContent"><h2 class="collapsableTitle">Fall 2026</h2>${event('Classes Begin')}</div><div class="collapsableContent"><h2 class="collapsableTitle">Spring 2027</h2>${event('Classes Begin')}</div>`;
  const result = parseCalendarHtml(current, future);
  assert.deepEqual(result.map(term => [term.name, term.events.length]), [['Fall 2026', 2], ['Spring 2027', 1]]);
});

test('conflicting event times are surfaced instead of selected silently', () => {
  const current = `<h1>Fall 2026</h1>${event('Classes Begin')}`;
  const future = `<div class="collapsableContent"><h2 class="collapsableTitle">Fall 2026</h2>${event('Classes Begin', '8:00 am')}</div>`;
  assert.throws(() => parseCalendarHtml(current, future), /calendar sources disagree/);
});

test('calendar merging does not mutate raw semester or event arrays', () => {
  const raw = [{ name: 'Fall 2026', events: [{ date: 'Aug. 26', title: 'Classes Begin', description: '12:00 am' }] }];
  const before = structuredClone(raw);
  mergeCalendarSemesters([...raw, { name: 'Fall 2026', events: [{ date: 'Aug. 27', title: 'Second Event', description: '' }] }]);
  assert.deepEqual(raw, before);
});

test('legacy raw overlaps merge before calendar concepts are assigned', () => {
  const shared = { date: 'Aug. 26', title: 'Classes Begin', description: '12:00 am' };
  const raw = [
    { name: 'Fall 2026', events: [shared] },
    { name: 'Fall 2026', events: [shared, { date: 'Aug. 27', title: 'Last Day to Add/Drop', description: '11:59 pm' }] },
  ];
  const normalized = calendarWithConcepts(mergeCalendarSemesters(validateAcademicCalendar(raw)));
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].events.length, 2);
  assert.deepEqual(normalized[0].events.map(item => [item.termId, item.kind]), [
    ['fall-2026', 'classes_begin'], ['fall-2026', 'add_drop_deadline'],
  ]);
  assert.deepEqual(calendarWithConcepts(mergeCalendarSemesters(validateAcademicCalendar(normalized))), normalized);
});
