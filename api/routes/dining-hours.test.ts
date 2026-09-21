import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGeneralHours, resolveLocationHoursForToday } from './dining-hours';
const venue = (standardHours: unknown[], seasonalHours: unknown[] = []) => ({ type: 'Location', content: { main: { name: 'Birch Tree Inn', openingHours: { standardHours, seasonalHours } } } }) as Parameters<typeof resolveLocationHoursForToday>[0];
const now = new Date('2026-09-21T18:00:00Z');

test('Student UI hours do not convert absent schedules/ranges into closure claims', () => {
  for (const fragment of [venue([]), venue([{ days: [{ value: 'Monday' }], hours: [{ allDay: false }] }]), venue([], [{ from: '2026-09-21T04:00:00Z', to: '2026-09-22T03:59:59Z', openingHours: [] }])]) {
    assert.equal(resolveLocationHoursForToday(fragment, now, 'America/New_York').hours[0].time, 'Hours unavailable');
    assert.equal(resolveGeneralHours(fragment).schedule[0].hours[0].time, 'Hours unavailable');
  }
});

test('Student UI retains explicit closure and multiple same-day meal groups', () => {
  const group = (label: string, hour: string) => ({ days: [{ value: 'Monday' }], hours: [{ allDay: false, label, startTime: { hour, minute: '00', period: 'PM' }, finishTime: { hour: '12', minute: '00', period: 'AM' } }] });
  const result = resolveLocationHoursForToday(venue([group('Dinner', '05'), group('Late Night', '09')]), now, 'America/New_York');
  assert.equal(result.hours.length, 2);
  assert.equal(result.hours[0].time, 'Dinner: 05:00 PM - 12:00 AM');
  assert.equal(resolveLocationHoursForToday(venue([{ days: [{ value: 'Monday' }], hours: [{ allDay: true, label: 'Closed' }] }]), now, 'America/New_York').hours[0].time, 'Closed');
});
