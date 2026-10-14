import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRenderedClosures, type RenderedDiningHours } from './dining-rendered';

const state = (hours: Record<string, unknown>[]) => ({ composition: { subject: { regions: [{ fragments: [{ content: { main: {
  name: 'The Atrium', openingHours: { standardHours: [
    { days: [{ value: 'Monday' }, { value: 'Friday' }], hours: [{ allDay: false, startTime: { hour: '07', minute: '30', period: 'AM' }, finishTime: { hour: '07', minute: '00', period: 'PM' } }] },
    { days: [{ value: 'Saturday' }, { value: 'Sunday' }], hours },
  ] } } } }] }] } } });
const rendered = (hours: string[]): RenderedDiningHours => ({ sourceUrl: 'https://example.test/hours', renderedAt: '2026-10-14T18:00:00Z',
  venues: [{ name: 'The Atrium', regular: [{ days: 'Monday - Friday', hours: ['07:30 AM - 07:00 PM'] }, { days: 'Saturday - Sunday', hours }] }] });

test('an empty range is Closed only where the rendered page prints Closed for the same days', () => {
  const closed = state([{ allDay: false }]);
  assert.deepEqual(applyRenderedClosures(closed, rendered(['Closed'])), ['The Atrium: Saturday - Sunday']);
  const ranges = (closed.composition.subject.regions[0].fragments[0].content.main.openingHours.standardHours[1].hours) as Record<string, unknown>[];
  assert.deepEqual(ranges[0], { allDay: false, closed: true, label: 'Closed' });
  // The page printing anything else, or nothing for those days, leaves the range unknown.
  for (const shown of [['10:00 AM - 02:00 PM'], []]) {
    const open = state([{ allDay: false }]);
    assert.deepEqual(applyRenderedClosures(open, rendered(shown)), []);
  }
  // A range that has times or a label is never touched.
  const labelled = state([{ allDay: false, label: 'Brunch' }]);
  assert.deepEqual(applyRenderedClosures(labelled, rendered(['Closed'])), []);
});
