import assert from 'node:assert/strict';
import test from 'node:test';

import { calendarFileDataset, listingEventSignals, rebuildEventsFromRaw } from './archway-events';
import type { ArchwayEvent } from './schema';

const event = (id: number, extra: Partial<ArchwayEvent> = {}): ArchwayEvent => ({
  title: `Event ${id}`, date: 'Friday, November 20 2026', time: '7:00 PM', url: `https://archway.ramapo.edu/rsvp_boot?id=${id}`,
  ...extra,
});

test("an event's food note and description come from its own calendar entry", () => {
  const signals = listingEventSignals([
    event(1, { description: 'Trivia night. Free pizza for everyone who comes!' }),
    event(2, { title: 'Bake sale', description: 'No free food, sorry; proceeds go to the food pantry drive this week.' }),
    event(3),
  ]);
  assert.equal(signals.get('https://archway.ramapo.edu/rsvp_boot?id=1')?.offersFreeFood, true);
  assert.equal(signals.get('https://archway.ramapo.edu/rsvp_boot?id=1')?.foodCategory, 'food');
  assert.equal(signals.get('https://archway.ramapo.edu/rsvp_boot?id=2')?.offersFreeFood, undefined);
  assert.equal(signals.has('https://archway.ramapo.edu/rsvp_boot?id=3'), false);
});

test('a rebuild from a calendar-file capture keeps the food note the entry gives', () => {
  const capture = calendarFileDataset([{
    url: 'https://archway.ramapo.edu/ical/ramapo/ical_club_12.ics', sourceType: 'detail', fetchedAt: '2026-11-05T11:32:00Z',
    statusCode: 200, title: 'Trivia Club', links: ['https://archway.ramapo.edu/rsvp_boot?id=1'], externalLinks: [],
    sections: [], lists: [], tables: [], contacts: [], documents: [],
  }], '2026-11-05T11:33:00Z');
  const [rebuilt] = rebuildEventsFromRaw([event(1, {
    description: 'Trivia night with free snacks for every team.', offersFreeFood: false,
  })], capture);
  assert.equal(rebuilt.offersFreeFood, true);
  assert.equal(rebuilt.foodCategory, 'snacks');
  assert.equal(rebuilt.description, 'Trivia night with free snacks for every team.');
});
