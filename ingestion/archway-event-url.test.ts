import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalArchwayEventUrl } from '../src/archway-event-url';
import { eventDetailCoverageErrors, eventQualityErrors } from '../pipeline/quality/content-policy';
import { buildArchwayEventDetailPage } from './archway-event-detail';
import { normalizeEventUrlForLookup, readEventSignalMapFromRawFile, rebuildEventsFromRaw } from './archway-events';
import { validateRawDatasetV1 } from './raw-types';

const listingUrl = 'https://archway.ramapo.edu/rsvp_boot?id=1409871';
const detailUrl = 'https://archway.ramapo.edu/sport/rsvp_boot?id=1409871';
const capturedAt = '2026-09-23T12:00:00Z';

test('official root and group RSVP URLs share a numeric occurrence lookup key', () => {
  for (const url of [listingUrl, detailUrl, `${detailUrl}&rel=calendar#details`,
    'https://archway.ramapo.edu/sport/rsvp/?utm_source=calendar&id=1409871']) {
    assert.equal(canonicalArchwayEventUrl(url), listingUrl);
    assert.equal(normalizeEventUrlForLookup(url), listingUrl);
  }
  for (const url of [detailUrl.replace('1409871', 'other'), `${detailUrl}&id=1409871`,
    detailUrl.replace('archway.ramapo.edu', 'example.org'),
    detailUrl.replace('archway.ramapo.edu', 'archway.ramapo.edu.example.org'),
    detailUrl.replace('https:', 'ftp:'), detailUrl.replace('https://', 'https://user@'),
    detailUrl.replace('archway.ramapo.edu', 'archway.ramapo.edu:8443'),
    detailUrl.replace('rsvp_boot', 'events')]) {
    assert.equal(canonicalArchwayEventUrl(url), undefined, url);
    assert.notEqual(normalizeEventUrlForLookup(url), listingUrl, url);
  }
  assert.notEqual(canonicalArchwayEventUrl(detailUrl.replace('1409871', '1409872')), listingUrl);
});

test('raw replay joins validated group redirects to cached descriptions without rewriting provenance', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/archway-event-host.html'), 'utf8');
  const page = buildArchwayEventDetailPage({ requestedUrl: listingUrl, url: detailUrl,
    html, statusCode: 200, fetchedAt: capturedAt });
  const raw = validateRawDatasetV1(JSON.parse(JSON.stringify({ version: '1.0', dataset: 'events-detail',
    collectedAt: capturedAt, seedUrls: [listingUrl], stats: { pagesFetched: 1, pagesFailed: 0, externalLinksSeen: 0 }, pages: [page] })));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-event-url-'));
  try {
    const signalPath = path.join(directory, 'events-signals.raw.json');
    const description = 'Join this occurrence for complimentary lunch and a campus discussion.';
    // Captures can use either the requested URL or the final redirect URL.
    for (const signalUrl of [listingUrl, detailUrl]) {
      fs.writeFileSync(signalPath, JSON.stringify({ dataset: 'events-signals', signals: [{ url: signalUrl, description }] }));
      const rebuilt = rebuildEventsFromRaw([{ title: 'Commanders VS 49ers', date: 'Oct 19, 2026', url: listingUrl }],
        raw, readEventSignalMapFromRawFile(signalPath));
      assert.equal(rebuilt[0].description, description);
      assert.equal(rebuilt[0].offersFreeFood, true);
      assert.equal(rebuilt[0].url, listingUrl);
      assert.equal(raw.pages[0].url, detailUrl);
      assert.equal(raw.pages[0].fetchedAt, capturedAt);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('event quality counts successful group redirects and rejects unrelated occurrence matches', () => {
  const events = [1, 2, 3, 4].map(id => ({ title: `Event ${id}`, date: `Sep ${id}, 2026`,
    description: 'A campus event.', url: `https://archway.ramapo.edu/rsvp_boot?id=${id}` }));
  const pages = events.slice(0, 3).map((event, index) => ({ sourceType: 'detail', statusCode: 200,
    url: event.url.replace('/rsvp_boot', `/group${index}/rsvp_boot`) }));
  assert.deepEqual(eventDetailCoverageErrors(events, { pages }), []);
  assert.match(eventDetailCoverageErrors(events, { pages: [
    { ...pages[0], url: pages[0].url.replace('archway.ramapo.edu', 'example.org') },
    { ...pages[1], url: `${pages[1].url}&id=2` },
    { ...pages[2], url: pages[2].url.replace('id=3', 'id=99') },
    { ...pages[0], statusCode: 403 },
  ] })[0], /0\/4 current event URLs/);
  assert.ok(eventQualityErrors([events[0], { ...events[1], url: pages[0].url }])
    .some(error => error.includes('share the same URL')));
});
