import assert from 'node:assert/strict';
import test from 'node:test';
import { activeSeasonSchedule, campusLocalDate, DINING_HOURS_UNKNOWN, formatDiningRange, seasonalPublicationRows, SEASONAL_CLOSURE } from './dining-seasons';
const period = (label: string, h1: string, p1: string, h2: string, p2: string) => ({ label, startTime: { hour: h1, minute: '00', period: p1 }, finishTime: { hour: h2, minute: '00', period: p2 } });

test('dining blank/malformed ranges remain unknown and explicit Closed is preserved', () => {
  assert.equal(formatDiningRange({ allDay: false }), DINING_HOURS_UNKNOWN);
  assert.equal(formatDiningRange({ allDay: true }), DINING_HOURS_UNKNOWN);
  assert.equal(formatDiningRange({ label: 'Summer Break', allDay: true }), `Summer Break: ${DINING_HOURS_UNKNOWN}`);
  assert.equal(formatDiningRange({ label: 'Closed', allDay: true }), 'Closed');
  assert.equal(formatDiningRange({ ...period('Dinner', '99', 'PM', '12', 'AM') }), `Dinner: ${DINING_HOURS_UNKNOWN}`);
});

test('meal labels, split periods and midnight survive publication without flattening', () => {
  const opening = { seasonalHours: [{ from: '2026-09-21T04:00:00Z', to: '2026-09-22T03:59:59Z', openingHours: [
    { days: [{ value: 'Monday' }], hours: [period('Lunch', '11', 'AM', '02', 'PM')] },
    { days: [{ value: 'Monday' }], hours: [period('Dinner', '05', 'PM', '12', 'AM')] },
  ] }] };
  const expected = 'Lunch: 11:00 AM - 02:00 PM; Dinner: 05:00 PM - 12:00 AM';
  assert.equal(activeSeasonSchedule(opening, 'Monday', new Date('2026-09-21T18:00:00Z')), expected);
  assert.equal(seasonalPublicationRows(opening).find(r => r.day === 'Monday')?.schedule, expected);
});

test('season rows cover only the weekdays inside the season, and a covered day without hours stays unknown', () => {
  // Sunday 2026-08-23 through Tuesday 2026-08-25, campus time; no Tuesday hours are listed.
  const opening = { seasonalHours: [{ from: '2026-08-23T04:00:00Z', to: '2026-08-26T03:59:59Z', openingHours: [
    { days: [{ value: 'Sunday' }, { value: 'Monday' }], hours: [period('Dinner', '05', 'PM', '07', 'PM')] },
  ] }] };
  const rows = seasonalPublicationRows(opening);
  assert.deepEqual(rows.map(r => r.day), ['Sunday', 'Monday', 'Tuesday']);
  assert.ok(rows.every(r => r.validFrom === '2026-08-23' && r.validUntil === '2026-08-25'));
  assert.equal(rows.find(r => r.day === 'Tuesday')?.schedule, DINING_HOURS_UNKNOWN);
  const summer = { seasonalHours: [{ from: '2026-05-26T04:00:00Z', to: '2026-08-23T03:59:59Z', openingHours: [] }] };
  assert.equal(seasonalPublicationRows(summer).length, 7);
});

test('active empty exceptions block weekly fallback without inventing a closure', () => {
  const opening = { seasonalHours: [{ from: '2026-09-21T04:00:00Z', to: '2026-09-22T03:59:59Z', openingHours: [] }] };
  assert.equal(activeSeasonSchedule(opening, 'Monday', new Date('2026-09-21T18:00:00Z')), DINING_HOURS_UNKNOWN);
  assert.equal(activeSeasonSchedule(opening, 'Tuesday', new Date('2026-09-22T18:00:00Z')), null);
  const closed = { seasonalHours: [{ ...opening.seasonalHours[0], openingHours: [{ days: [{ value: 'Monday' }], hours: [{ label: 'Closed' }] }] }] };
  assert.equal(activeSeasonSchedule(closed, 'Monday', new Date('2026-09-21T18:00:00Z')), SEASONAL_CLOSURE);
});

test('campus date and exception eligibility use the supplied deterministic instant at DST and midnight', () => {
  assert.equal(campusLocalDate(new Date('2026-09-22T03:59:59Z')), '2026-09-21');
  assert.equal(campusLocalDate(new Date('2026-09-22T04:00:00Z')), '2026-09-22');
  assert.equal(campusLocalDate(new Date('2026-03-08T06:59:59Z')), '2026-03-08');
  assert.equal(campusLocalDate(new Date('2026-03-08T07:00:00Z')), '2026-03-08');
});
