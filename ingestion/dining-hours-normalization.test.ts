import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDiningHoursState } from './schema';
import { formatHoursList, toContextDiningHours } from './generate-dining-hours-md';
import { formatDiningRange } from '../src/data-v2/dining-seasons';
import { resolveGeneralHours, resolveLocationHoursForToday } from '../api/routes/dining-hours';

function normalized(ranges: unknown[]) {
  return validateDiningHoursState({ composition: { subject: { regions: [{ fragments: [{
    type: 'Location', content: { main: { name: 'Example Dining', openingHours: {
      standardHours: [{ days: ['Monday'], hours: ranges }], seasonalHours: [],
    } } },
  }] }] } } });
}

test('an explicit source CLOSED value survives normalization and every rendering', () => {
  // Sodexo publishes allDay as both a string and a taxonomy object.
  for (const allDay of ['CLOSED', { value: 'CLOSED' }]) {
    const state = normalized([{ allDay, label: 'Summer Break' }]);
    assert.deepEqual(validateDiningHoursState(state), state);
    const fragment = state.composition.subject.regions[0].fragments[0];
    const hours = fragment.content.main.openingHours.standardHours[0].hours;
    assert.equal(hours[0].closed, true);
    assert.equal(formatHoursList(hours), 'Closed');
    assert.equal(formatDiningRange({ ...hours[0] }), 'Closed');
    assert.equal(resolveGeneralHours(fragment).schedule[0].hours[0].time, 'Closed');
    assert.equal(resolveLocationHoursForToday(fragment, new Date('2026-09-21T18:00:00Z'),
      'America/New_York').hours[0].time, 'Closed');
  }
});

test('offline normalization replays the actual source shape and rejects unsupported captures', () => {
  const state = normalized([{ allDay: { value: 'CLOSED' } }]);
  assert.deepEqual(validateDiningHoursState(state), state);
  assert.throws(() => validateDiningHoursState({ error: 'API format changed' }));
  assert.throws(() => validateDiningHoursState([]));
});

test('a general-hours label retains its explicit closure when the label is displayed separately', () => {
  const fragment = normalized([{ allDay: 'true', label: 'Closed' }])
    .composition.subject.regions[0].fragments[0];
  assert.equal(resolveGeneralHours(fragment).schedule[0].hours[0].time, 'Closed');
});

test('missing clocks and unexplained all-day flags never become open-all-day or closed facts', () => {
  for (const allDay of [false, true, 'false', 'true']) {
    const state = normalized([{ allDay }]);
    const fragment = state.composition.subject.regions[0].fragments[0];
    const hours = fragment.content.main.openingHours.standardHours[0].hours;
    assert.equal(formatHoursList(hours), 'Hours unavailable');
    assert.equal(toContextDiningHours(state, new Date('2026-09-21T18:00:00Z'))[0]
      .sections[0].groups[0].hours, 'Hours unavailable');
  }
  assert.equal(formatHoursList([]), 'Hours unavailable');
});
