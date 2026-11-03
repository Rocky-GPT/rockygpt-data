import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { berrieEventFromPage, berrieEventsFromCapture, withBerrieEvents } from './berrie-events';
import { berrieEventId, canonicalBerrieEventUrl } from '../src/berrie-event-url';
import type { RawSourceCaptureV1 } from './raw-collector';

type Page = RawSourceCaptureV1['pages'][number];

/** An Events Calendar single-event page, as the Berrie Center's site writes one. */
const showPage = (opts: { day: string; start?: string; end?: string; jsonLd?: boolean; title?: string; cost?: string } = { day: '2026-11-13' }) => {
  const title = opts.title ?? 'RCNJ Theater Presents: As You Like It';
  const ld = opts.jsonLd === false ? '' : `<script type="application/ld+json">[{"@context":"http://schema.org","@type":"Event","name":"RCNJ Theater Presents: As You Like It",
    "description":"&lt;p&gt;Shakespeare&#8217;s comedy.&lt;/p&gt;","url":"https://www.ramapo.edu/berriecenter/event/as-you-like-it/${opts.day}/",
    "startDate":"${opts.day}T${opts.start ?? '19:30'}:00-05:00","endDate":"${opts.day}T${opts.end ?? '22:00'}:00-05:00",
    "location":{"@type":"Place","name":"Sharp Theater","address":{"@type":"PostalAddress","streetAddress":"505 Ramapo Valley Road"}},
    "organizer":{"@type":"Person","name":"CA Theater Program Productions"},"performer":"Organization"}]</script>`;
  return `<html><head>${ld}</head><body class="tribe-events-page-template tribe-theme-twentytwenty single-tribe_events postid-10001758">
<main><div class="tribe-events-single">
<h1 class="tribe-events-single-event-title">${title}</h1>
<div class="tribe-events-schedule tribe-clearfix"><h2><span class="tribe-event-date-start">November 13 @ 7:30 pm</span> - <span class="tribe-event-time">10:00 pm</span></h2></div>
<div class="tribe-events-single-event-description tribe-events-content"><p>Shakespeare&#8217;s comedy of love in the forest.</p><p>Adults $18; RCNJ Students $8.</p></div>
<div class="tribe-events-meta-group tribe-events-meta-group-details"><h2 class="tribe-events-single-section-title"> Details </h2><dl>
<dt class="tribe-events-start-date-label"> Date: </dt><dd><abbr class="tribe-events-abbr tribe-events-start-date published dtstart" title="${opts.day}"> November 13 </abbr></dd>
<dt class="tribe-events-start-time-label"> Time: </dt><dd><div class="tribe-events-abbr tribe-events-start-time published dtstart" title="${opts.day}"> 7:30 pm - 10:00 pm </div></dd>
${opts.cost ? `<dt class="tribe-events-event-cost-label"> Cost: </dt><dd class="tribe-events-event-cost"> ${opts.cost} </dd>` : ''}
<dt class="tribe-events-event-categories-label">Event Categories:</dt><dd class="tribe-events-event-categories"><a href="x" rel="tag">Berrie Center</a>, <a href="y" rel="tag">CA</a></dd>
</dl></div>
<div class="tribe-events-meta-group tribe-events-meta-group-organizer"><h2 class="tribe-events-single-section-title">Organizer</h2><dl>
<dt class="tribe-common-a11y-visual-hide">Organizer name:</dt><dd class="tribe-organizer"> CA Theater Program Productions </dd></dl></div>
<div class="tribe-events-meta-group tribe-events-meta-group-venue"><h2 class="tribe-events-single-section-title"> Venue </h2><dl>
<dt class="tribe-common-a11y-visual-hide">Venue name:</dt><dd class="tribe-venue"> Sharp Theater </dd></dl></div>
</div></main></body></html>`;
};
const page = (url: string, html: string, zipped = false): Page => ({
  url, requestedUrl: url, statusCode: 200, sourceType: 'detail', fetchedAt: '2026-11-01T12:00:00Z', contentHash: 'x',
  ...(zipped ? { html: '', htmlGzip: gzipSync(html).toString('base64') } : { html }),
} as Page);
const url = (day: string) => `https://www.ramapo.edu/berriecenter/event/as-you-like-it/${day}/`;

test('a show page path is the show ID; other addresses are not shows', () => {
  assert.equal(berrieEventId('https://www.ramapo.edu/berriecenter/event/as-you-like-it/2026-11-13/'), 'as-you-like-it/2026-11-13');
  assert.equal(berrieEventId('https://ramapo.edu/berriecenter/event/john_lloyd_young'), 'john_lloyd_young');
  assert.equal(canonicalBerrieEventUrl('https://ramapo.edu/berriecenter/event/john_lloyd_young'), 'https://www.ramapo.edu/berriecenter/event/john_lloyd_young/');
  for (const other of ['https://www.ramapo.edu/berriecenter/performance-schedule/', 'https://www.ramapo.edu/holocaust/event/talk/',
    'https://archway.ramapo.edu/rsvp_boot?id=1', 'https://evil.example/berriecenter/event/x/', 'not a url']) assert.equal(berrieEventId(other), '');
});

test('a show page gives its title, campus date and time, venue, organizer, description and categories', () => {
  const show = berrieEventFromPage(page(url('2026-11-13'), showPage({ day: '2026-11-13', cost: '$8 - $18' }), true));
  assert.deepEqual(show, {
    title: 'RCNJ Theater Presents: As You Like It', date: 'Fri, Nov 13, 2026', url: url('2026-11-13'), time: '7:30 PM', endTime: '10 PM',
    location: 'Sharp Theater', organizer: 'CA Theater Program Productions',
    description: 'Shakespeare’s comedy of love in the forest. Adults $18; RCNJ Students $8.',
    ticketStatus: '$8 - $18', tags: ['Berrie Center', 'CA'],
  });
});

test('without the schema.org block the page\'s own date and time lines still date the show', () => {
  const show = berrieEventFromPage(page(url('2026-11-13'), showPage({ day: '2026-11-13', jsonLd: false })));
  assert.equal(show?.date, 'Fri, Nov 13, 2026');
  assert.equal(show?.time, '7:30 PM');
  assert.equal(show?.endTime, '10 PM');
  assert.equal(show?.location, 'Sharp Theater');
});

test('a page that is not a dated event page is no show', () => {
  assert.equal(berrieEventFromPage(page('https://www.ramapo.edu/berriecenter/event/x/', '<body class="page">x</body>')), null);
  assert.equal(berrieEventFromPage(page('https://www.ramapo.edu/berriecenter/tickets-seating/', showPage({ day: '2026-11-13' }))), null);
});

test('only shows starting today or later on campus are kept, once each, soonest first', () => {
  const capture = { pages: [
    page(url('2026-11-20'), showPage({ day: '2026-11-20' })),
    page(url('2026-11-13'), showPage({ day: '2026-11-13' })),
    page(url('2026-11-13').replace('www.', ''), showPage({ day: '2026-11-13' })),
    page(url('2026-10-30'), showPage({ day: '2026-10-30' })),
    { ...page(url('2026-11-21'), showPage({ day: '2026-11-21' })), statusCode: 404 },
  ] };
  // 8 p.m. on Nov 12 in New York is already Nov 13 in UTC; the Nov 13 show is still ahead.
  const shows = berrieEventsFromCapture(capture, new Date('2026-11-13T01:00:00Z'));
  assert.deepEqual(shows.map(s => s.url), [url('2026-11-13'), url('2026-11-20')]);
});

test('a show Archway already lists stays Archway\'s; the others are added after Archway\'s events', () => {
  const archway = [{ title: 'As You Like It Performance', date: 'Fri, Nov 13, 2026', time: '7:30 PM', url: 'https://archway.ramapo.edu/rsvp_boot?id=5' }];
  const berrie = [
    { title: 'RCNJ Theater Presents: As You Like It', date: 'Fri, Nov 13, 2026', time: '7:30 PM', url: url('2026-11-13') },
    { title: 'RCNJ Theater Presents: As You Like It', date: 'Fri, Nov 20, 2026', time: '7:30 PM', url: url('2026-11-20') },
    { title: 'A Holiday Evening with John Lloyd Young', date: 'Sat, Dec 5, 2026', time: '7:30 PM', url: 'https://www.ramapo.edu/berriecenter/event/john_lloyd_young/' },
  ];
  assert.deepEqual(withBerrieEvents(archway, berrie).map(e => e.url), [archway[0].url, berrie[1].url, berrie[2].url]);
});
