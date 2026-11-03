import assert from 'node:assert/strict';
import test from 'node:test';
import {
  campusDateLabel, campusTimeLabel, feedEvent, feedLocation, feedTags, groupFeedUrl, groupsToRead,
  mergeFeedEvents, ownerName, parseFeedIndex, parseIcs,
} from './archway-calendar-feeds';
import { ticketStatusFromDetailPage, withDetailPageFacts } from './archway-events';
import type { RawDatasetV1, RawPageV1 } from './raw-types';

// The shape of Archway's group files, as read from ical_club_36419.ics on November 3, 2026.
const roukema = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Roukema Center for International Education',
  'BEGIN:VEVENT',
  'UID:abc@campusgroups.com',
  'SUMMARY:Bocelli\\, Biscotti & Beyond: Your Passport to Study Abroad in Italy',
  'DTSTART:20261116T180000Z', 'DTEND:20261116T190000Z',
  'LOCATION:York Room\\, 505 Ramapo Valley Road\\, ASB-123\\, Mahwah\\, New 07430\\, United States',
  'DESCRIPTION:Learn about study abroad in Italy with Professor Rosina D\'Angelo.\\nMusic and refres',
  ' hments.',
  'URL:https://archway.ramapo.edu/rsvp?id=1411709',
  'ORGANIZER;CN="Roukema Center for International Education":mailto:noreply@archway.ramapo.edu',
  'CATEGORIES;X-CG-CATEGORY=club_acronym:ROUKEMA',
  'CATEGORIES;X-CG-CATEGORY=event_type:Lecture/Speaker/Info Session',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Past Event', 'DTSTART:20261001T180000Z', 'DTEND:20261001T190000Z',
  'URL:https://archway.ramapo.edu/rsvp?id=1400000',
  'ORGANIZER;CN="Roukema Center for International Education":mailto:noreply@archway.ramapo.edu',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const now = '2026-11-03T20:00:00.000Z';

test('a group file entry reads as the listing wrote events', () => {
  const [entry] = parseIcs(roukema);
  const event = feedEvent(entry, { groupId: '36419', url: groupFeedUrl('36419') }, now)!;
  assert.deepEqual(event, {
    title: 'Bocelli, Biscotti & Beyond: Your Passport to Study Abroad in Italy',
    date: 'Mon, Nov 16, 2026', time: '1 PM', endTime: '2 PM',
    organizer: 'Roukema Center for International Education',
    organizerIdentity: { groupId: '36419', sourceUrl: groupFeedUrl('36419'), collectedAt: now },
    location: 'York Room',
    description: "Learn about study abroad in Italy with Professor Rosina D'Angelo. Music and refreshments.",
    url: 'https://archway.ramapo.edu/rsvp_boot?id=1411709',
    tags: ['Lecture/Speaker/Info Session'],
  });
});

test('campus labels follow New York time across daylight saving', () => {
  assert.equal(campusDateLabel(new Date('2026-10-31T03:30:00Z')), 'Fri, Oct 30, 2026');
  assert.equal(campusTimeLabel(new Date('2026-10-31T03:30:00Z')), '11:30 PM');
  assert.equal(campusTimeLabel(new Date('2026-11-16T17:00:00Z')), '12 PM');
  assert.equal(campusTimeLabel(new Date('2026-11-16T05:05:00Z')), '12:05 AM');
});

test('places drop the street address; a dash is no place', () => {
  assert.equal(feedLocation('ASB 332\\, 505 Ramapo Valley Road\\, ASB-123\\, Mahwah'), 'ASB 332');
  assert.equal(feedLocation('-'), undefined);
  assert.equal(feedLocation('Mahwah Senior Center'), 'Mahwah Senior Center');
  assert.equal(feedLocation('undefined'), undefined);
  assert.equal(feedLocation('Sign in to download the location'), undefined);
  assert.equal(feedLocation('Mansion York Room\\, 41.081276\\,-74.175518'), 'Mansion York Room');
});

test('the group acronym is never a tag', () => {
  const [entry] = parseIcs(roukema);
  assert.deepEqual(feedTags(entry), ['Lecture/Speaker/Info Session']);
});

test('past events are left out and an event in two files keeps its own group', () => {
  const cohost = roukema.replace(/Roukema Center for International Education/g, 'Italian Club');
  const events = mergeFeedEvents([
    { groupId: '111', url: groupFeedUrl('111'), groupName: 'Italian Club', text: roukema },
    { groupId: '36419', url: groupFeedUrl('36419'), groupName: 'Roukema Center for International Education', text: roukema },
    { groupId: '222', url: groupFeedUrl('222'), groupName: 'Italian Club', text: cohost },
  ], now);
  assert.equal(events.length, 1);
  assert.equal(events[0].organizerIdentity?.groupId, '36419');
});

test("a co-host's file never claims the organizer's event", () => {
  const [entry] = parseIcs(roukema);
  const event = feedEvent(entry, { groupId: '111', url: groupFeedUrl('111'), groupName: 'Italian Club' }, now)!;
  assert.equal(event.organizerIdentity, undefined);
  assert.equal(event.organizer, 'Roukema Center for International Education');
});

test('the Subscribe page names each group file once', () => {
  const html = '<a href="webcal://archway.ramapo.edu/ical/ramapo/ical_club_65192.ics">A</a>'
    + '<input value="https://archway.ramapo.edu/ical/ramapo/ical_club_65192.ics">'
    + '<a href="https://archway.ramapo.edu/ical/ramapo/ical_club_34108.ics">B</a>'
    + '<a href="https://archway.ramapo.edu/ical/ramapo/ical_ramapo.ics">All</a>';
  assert.deepEqual(parseFeedIndex(html).map(g => g.groupId), ['65192', '34108']);
});

test('a normal day reads only groups with events; Mondays and first runs read every group', () => {
  const index = [{ groupId: '1' }, { groupId: '2' }, { groupId: '3' }];
  const previous = [{ title: 'x', date: 'Tue, Nov 3, 2026', organizerIdentity: { groupId: '2', sourceUrl: 's', collectedAt: now } }];
  const tuesday = new Date('2026-11-03T15:00:00Z');
  assert.deepEqual(groupsToRead(index, previous, tuesday, {}).groups.map(g => g.groupId), ['2']);
  assert.equal(groupsToRead(index, previous, new Date('2026-11-02T15:00:00Z'), {}).all, true);
  assert.equal(groupsToRead(index, null, tuesday, {}).groups.length, 3);
  assert.equal(groupsToRead(index, previous, tuesday, { ARCHWAY_FEEDS_ALL: '1' }).all, true);
});

test("a file's owner is the organizer on most of its entries", () => {
  assert.equal(ownerName(roukema), 'Roukema Center for International Education');
});

test('the event page supplies the ticket line and its own Where line', () => {
  const page = { url: 'https://archway.ramapo.edu/ccec/rsvp_boot?id=1411135', sourceType: 'detail', statusCode: 200,
    fetchedAt: now, title: 't', links: [], externalLinks: [], lists: [], tables: [], contacts: [], documents: [],
    sections: [{ heading: 'Service Opportunity', text: 'Oct 30 FREE' }, { heading: 'Where', text: 'Mahwah Senior Center' }],
  } as unknown as RawPageV1;
  assert.equal(ticketStatusFromDetailPage(page), 'FREE');
  assert.equal(ticketStatusFromDetailPage({ ...page, sections: [{ heading: 'h', text: 'Nov 7 $5 - $10' }] }), '$5 - $10');
  assert.equal(ticketStatusFromDetailPage({ ...page, sections: [{ heading: 'h', text: 'FREE pizza for everyone' }] }), undefined);
  const dataset = { pages: [page] } as unknown as RawDatasetV1;
  const [event] = withDetailPageFacts([{ title: 't', date: 'Fri, Oct 30, 2026', location: 'Mahwah Senior Ctr',
    url: 'https://archway.ramapo.edu/rsvp_boot?id=1411135' }], dataset);
  assert.equal(event.ticketStatus, 'FREE');
  assert.equal(event.location, 'Mahwah Senior Center');
});
