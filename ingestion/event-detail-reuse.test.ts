import assert from 'node:assert/strict';
import test from 'node:test';

import { EVENT_DETAIL_REUSE_HOURS, reusableEventDetails, withDetailPageFacts } from './archway-events';
import type { RawPageV1 } from './raw-types';
import { validateArchwayEvents } from './schema';
import type { ArchwayEvent } from './schema';

const now = new Date('2026-11-03T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const url = (id: number) => `https://archway.ramapo.edu/rsvp_boot?id=${id}`;
const event = (id: number, extra: Partial<ArchwayEvent> = {}): ArchwayEvent => ({
  title: `Event ${id}`, date: 'Wednesday, November 4 2026', time: '7:00 PM', location: 'Friends Hall', url: url(id),
  organizerIdentity: { groupId: '12', sourceUrl: 'https://archway.ramapo.edu/home/events/', collectedAt: hoursAgo(20) },
  ...extra,
});
const page = (id: number, fetchedHoursAgo: number, statusCode: number | null = 200): RawPageV1 => ({
  url: url(id), sourceType: 'detail', fetchedAt: hoursAgo(fetchedHoursAgo), statusCode, title: `Event ${id}`,
  links: [], externalLinks: [], sections: [], lists: [], tables: [], contacts: [], documents: [],
});

test('an event listed the same as last night reuses its page; a new, changed, failed or old one is downloaded', () => {
  const previous = {
    events: [event(1), event(2), event(3), event(4), event(5)],
    pages: [page(1, 20), page(2, 20), page(3, 20, null), page(4, EVENT_DETAIL_REUSE_HOURS + 1), page(5, 20)],
    signalByUrl: new Map([[url(1), { description: 'Trivia night with pizza.', offersFreeFood: true }]]),
  };
  const tonight = [
    // Same listing; only its collection time moved on.
    event(1, { organizerIdentity: { groupId: '12', sourceUrl: 'https://archway.ramapo.edu/home/events/', collectedAt: now.toISOString() } }),
    event(2, { time: '8:00 PM' }), // moved: download again
    event(3), // last night's page failed
    event(4), // page older than the reuse window
    event(5),
    event(6), // new
  ];
  const reusable = reusableEventDetails(tonight, previous, now);
  assert.deepEqual([...reusable.keys()].sort(), [url(1), url(5)].sort());
  assert.equal(reusable.get(url(1))?.signal?.description, 'Trivia night with pizza.');
  assert.equal(reusable.get(url(1))?.page.fetchedAt, hoursAgo(20));
  assert.equal(reusable.get(url(5))?.signal, undefined);
});

test('nothing is reused without last night\'s capture', () => {
  assert.equal(reusableEventDetails([event(1)], null, now).size, 0);
});

test('last night\'s events, saved with their pages\' place and ticket, still match tonight\'s bare listing', () => {
  // The calendar file spells the place its own way and has no ticket; the page says both.
  const withWhere = (id: number): RawPageV1 => ({
    ...page(id, 20),
    sections: [
      { heading: '', text: 'Nov 4 FREE' },
      { heading: 'Where', text: 'Friends Hall & Lounge' },
    ],
  });
  const listing = [event(1, { location: 'Friends Hall and Lounge', tags: ['Social'] }), event(2), event(3)];
  const pages = [withWhere(1), withWhere(2), withWhere(3)];
  const enriched = withDetailPageFacts(listing, { pages });
  assert.equal(enriched[0].location, 'Friends Hall & Lounge');
  assert.equal(enriched[0].ticketStatus, 'FREE');
  // Saved to disk and read back, as the next night's run does.
  const saved = validateArchwayEvents(JSON.parse(JSON.stringify(enriched)));
  const tonight = [listing[0], listing[1], event(3, { time: '9:00 PM' })];
  const reusable = reusableEventDetails(tonight, { events: saved, pages, signalByUrl: new Map() }, now);
  assert.deepEqual([...reusable.keys()].sort(), [url(1), url(2)].sort());
});
