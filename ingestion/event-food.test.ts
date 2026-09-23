import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedFoodSignal } from './event-food';
import { applyDetailSignalsToEvents, extractEventDetailSignalFromHtml, rebuildEventSignals, rebuildEventsFromRaw } from './archway-events';
import { type RawDatasetV1, type RawPageV1 } from './raw-types';

test('food mentions, free admission, and serving food do not establish free food', () => {
  for (const text of ['Project L.E.A.D. Treat Yo Self-Care', 'Dinner discussion', 'Free RSVP. Pizza available for purchase.', 'Serving food? Yes', 'Food will be served.', 'No free food', 'If there is free food, join us.']) {
    assert.equal(publishedFoodSignal(text).offersFreeFood, undefined, text);
  }
  assert.deepEqual(publishedFoodSignal('Complimentary BBQ lunch'), { offersFreeFood: true, foodCategory: 'food' });
  assert.deepEqual(publishedFoodSignal('Join us for free snacks.'), { offersFreeFood: true, foodCategory: 'snacks' });
  assert.deepEqual(publishedFoodSignal('Free pizza. Serving food? No'), { offersFreeFood: false });
});

test('HTML extraction requires an explicit food offer, independently of the RSVP price', () => {
  const html = '<title>Treat Yo Self-Care</title><meta name="description" content="Discover self-care"><body>Price FREE</body>';
  assert.equal(extractEventDetailSignalFromHtml(html).offersFreeFood, undefined);
  assert.equal(extractEventDetailSignalFromHtml('<meta name="description" content="Complimentary lunch"><body>Serving food? Yes</body>').offersFreeFood, true);
});

test('food flags stay on their own occurrence, including an explicit no-food occurrence', () => {
  const events = [1, 2, 3].map(id => ({ title: 'Weekly meeting', organizer: 'Club', date: `Sep ${id}, 2026`, url: `https://archway.ramapo.edu/rsvp_boot?id=${id}` }));
  const signals = new Map([[events[0].url, { offersFreeFood: true, foodCategory: 'food' as const }], [events[1].url, { offersFreeFood: false }]]);
  const result = applyDetailSignalsToEvents(events, signals);
  assert.equal(result[0].offersFreeFood, true);
  assert.equal(result[1].offersFreeFood, false);
  assert.equal(result[2].offersFreeFood, undefined);
});

test('cached keyword guesses are replaced using each successfully captured detail page', () => {
  const page: RawPageV1 = { url: 'https://archway.ramapo.edu/rsvp_boot?id=1', sourceType: 'detail', fetchedAt: '2026-09-23T00:00:00Z', statusCode: 200, title: 'Treat Yo Self-Care', links: [], externalLinks: [], sections: [], lists: [], tables: [], contacts: [], documents: [] };
  const dataset: RawDatasetV1 = { version: '1.0', dataset: 'events-detail', collectedAt: page.fetchedAt, seedUrls: [], stats: { pagesFetched: 1, pagesFailed: 0, externalLinksSeen: 0 }, pages: [page] };
  const saved = new Map([[page.url, { offersFreeFood: true, foodCategory: 'snacks' as const, description: 'Discover self-care.' }]]);
  assert.deepEqual(rebuildEventSignals(dataset, saved).get(page.url), { description: 'Discover self-care.' });
  const rebuilt = rebuildEventsFromRaw([{ title: 'Treat Yo Self-Care', date: 'Sep 23, 2026', url: page.url, offersFreeFood: true, foodCategory: 'snacks' }], dataset, saved);
  assert.equal(rebuilt[0].offersFreeFood, undefined);
  assert.equal(rebuilt[0].foodCategory, undefined);
  assert.equal(rebuilt[0].description, 'Discover self-care.');
  page.statusCode = 403;
  assert.equal(rebuildEventSignals(dataset, saved).size, 0);
});
