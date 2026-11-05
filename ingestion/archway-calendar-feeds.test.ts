import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calendarFilePages, campusDateLabel, campusTimeLabel, feedEvent, feedLocation, feedTags, groupFeedUrl, groupsToRead,
  mergeFeedEvents, ownerName, parseFeedIndex, parseIcs,
} from './archway-calendar-feeds';

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

test("a file's HTML line breaks and Archway's internal request form never reach the events", () => {
  const withDescription = (description: string) => roukema.replace(
    /DESCRIPTION:[^\r]*\r\n hments\./, `DESCRIPTION:${description}`);
  const [html] = parseIcs(withDescription('Free sushi!<br>Bring a friend.&lt;br /&gt;All welcome.'));
  assert.equal(feedEvent(html, { groupId: '36419', url: groupFeedUrl('36419') }, now)!.description,
    'Free sushi! Bring a friend. All welcome.');
  const [form] = parseIcs(withDescription('Organization: Hillel<br>Event Name: Kosher Sushi Night<br>Expected Headcount: 40'));
  const event = feedEvent(form, { groupId: '36419', url: groupFeedUrl('36419') }, now)!;
  assert.equal(event.description, undefined);
  assert.equal('description' in event, false);
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


test("tonight's capture is one page per calendar file that lists a published event, linking to its events", () => {
  const fetchedAt = '2026-11-05T11:32:00.000Z';
  const files = [
    { groupId: '36419', url: groupFeedUrl('36419'), name: 'Roukema Center for International Education', text: roukema, fetchedAt },
    { groupId: '9', url: groupFeedUrl('9'), text: 'BEGIN:VCALENDAR\nEND:VCALENDAR', fetchedAt },
  ];
  const events = mergeFeedEvents(files, fetchedAt, new Date('2026-11-03T12:00:00Z'));
  assert.ok(events.length > 0);
  const pages = calendarFilePages(files, events);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, groupFeedUrl('36419'));
  assert.equal(pages[0].sourceType, 'detail');
  assert.equal(pages[0].statusCode, 200);
  assert.equal(pages[0].title, 'Roukema Center for International Education');
  assert.deepEqual(pages[0].links, [...new Set(events.map(event => event.url!))].sort());
  // An entry that is not among tonight's events (already over, say) is not linked.
  assert.deepEqual(calendarFilePages(files, events.slice(1)).flatMap(page => page.links).includes(events[0].url!), false);
});
