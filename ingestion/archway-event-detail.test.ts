import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildArchwayEventDetailPage } from './archway-event-detail';
import { validateRawDatasetV1 } from './raw-types';
import { archwayIdentityId, compileArchwayIdentities } from '../src/data-v2/archway-identities';
import type { IdentitySnapshot } from '../src/data-v2/compile-campus-identities';
import { publicListingEvent } from './archway-events';
import { validateArchwayEvents } from './schema';

const html = fs.readFileSync(path.join(__dirname, 'fixtures/archway-event-host.html'), 'utf8');
const options = { requestedUrl: 'https://archway.ramapo.edu/rsvp_boot?id=1409871',
  url: 'https://archway.ramapo.edu/sport/rsvp_boot?id=1409871', html, statusCode: 200, fetchedAt: '2026-09-22T19:00:00Z' };
const club = { name: 'Sports Club', clubId: '62965', websiteUrl: 'https://archway.ramapo.edu/Sport/' };
const snapshot = (): IdentitySnapshot => ({ campus_contacts: [], campus_hours: [], dining_hours: [], menu_items: [], programs: [],
  clubs: [{ id: '9161ba3c-42f2-4081-b19f-718159905c45', source_key: 'archway-clubs', source_record_key: club.name,
    name: club.name, category: 'Student Organization', website_url: club.websiteUrl }],
  events: [{ id: 'f4b84867-2ab7-413b-a97b-784718345ed7', source_key: 'archway-events', source_record_key: 'Oct19:Commanders',
    title: 'Commanders VS 49ers', starts_at: '2026-10-20T00:00:00Z', organizer: club.name, event_url: options.requestedUrl }],
  artifacts: { clubs: [club] } });

test('real Hosted By markup survives raw normalization and serialization into an evidenced organized_by edge', () => {
  const page = buildArchwayEventDetailPage(options);
  assert.deepEqual(page.archwayOrganizers, [{ groupId: club.clubId, groupUrl: club.websiteUrl, name: club.name }]);
  const dataset = validateRawDatasetV1(JSON.parse(JSON.stringify({ version: '1.0', dataset: 'events-detail',
    collectedAt: options.fetchedAt, seedUrls: [options.requestedUrl], stats: { pagesFetched: 1, pagesFailed: 0, externalLinksSeen: 0 }, pages: [page] })));
  const result = compileArchwayIdentities(snapshot(), { eventDetails: dataset });
  const event = result.entities.find(e => e.kind === 'event')!;
  const relationship = event.relationships?.[0];
  assert.ok(relationship && 'target_entity_id' in relationship);
  assert.equal(relationship.target_entity_id, archwayIdentityId('club', '62965'));
  assert.equal(event.relationships?.[0].evidence[0].field, 'organizer_group_id');
  assert.equal(result.organizers.events[0].source_url, options.url);
  assert.equal(result.organizers.events[0].collected_at, options.fetchedAt);
  assert.equal(result.organizers.events[0].source_record_id, snapshot().events![0].id);
});

test('sign-in HTML, offsite redirects, changed event IDs and failed responses cannot be successful detail captures', () => {
  for (const patch of [{ html: '<title>Sign In or Register</title><h1>Sign in</h1>' },
    { url: 'https://archway.ramapo.edu/home_login' }, { url: options.url.replace('1409871', '999') },
    { url: options.url.replace('archway.ramapo.edu', 'example.org') }, { statusCode: 403 },
    { url: options.url + '&id=999' }]) {
    assert.throws(() => buildArchwayEventDetailPage({ ...options, ...patch }), /Archway detail/);
  }
});

test('text alone, outside links, ambiguous host IDs and mismatched bylines never create organizer links', () => {
  const variants = [
    html + html,
    html.replace('href="/events?group_ids=62965"', 'href="/events"'),
    html.replace('href="/Sport/"', 'href="https://example.org/Sport/"'),
    html.replace('href="/events?group_ids=62965"', 'href="/events?group_ids=62965&group_ids=999"'),
    html.replace('</strong>', '</strong><a href="/events?group_ids=999">Other</a>'),
    html.replace('>Sports Club</button>', '>Someone Else</button>'),
    html.replace('id="event_host"', 'id="unrelated"'),
  ];
  for (const source of variants) {
    const page = buildArchwayEventDetailPage({ ...options, html: source });
    assert.deepEqual(page.archwayOrganizers, []);
    // Even page-wide legacy-looking links/byline cannot bypass scoped capture.
    page.links.push(club.websiteUrl, 'https://archway.ramapo.edu/events?group_ids=62965');
    page.sections.push({ heading: 'Event', text: 'by Sports Club' });
    assert.equal(compileArchwayIdentities(snapshot(), { eventDetails: { pages: [page] } }).organizers.events.length, 0);
  }
});

test('matching names cannot override a different group ID or website', () => {
  const page = buildArchwayEventDetailPage(options);
  for (const patch of [{ clubId: '999' }, { websiteUrl: 'https://archway.ramapo.edu/another/' }]) {
    const data = snapshot(); data.artifacts.clubs = [{ ...club, ...patch }];
    assert.equal(compileArchwayIdentities(data, { eventDetails: { pages: [page] } }).organizers.events.length, 0);
  }
});

test('listing clubId and clubLogin survive normalization/publication even without accessible detail HTML', () => {
  const listing = publicListingEvent({ fields: 'displayType,eventName,eventDates,clubId,clubLogin,clubName,eventUrl,',
    p0: 'event', p1: 'Commanders VS 49ers', p2: '<p>Mon, Oct 19, 2026</p><p>8 PM – 10 PM</p>',
    p3: '62965', p4: 'Sport', p5: 'Sports Club', p6: '/rsvp_boot?id=1409871' }, options.fetchedAt)!;
  const data = snapshot();
  data.artifacts.events = JSON.parse(JSON.stringify(validateArchwayEvents([listing])));
  const result = compileArchwayIdentities(data);
  assert.equal(result.entities.find(e => e.kind === 'event')?.relationships?.[0].type, 'organized_by');
  assert.equal(result.organizers.events[0].organizer_group_id, '62965');
  assert.equal(result.organizers.events[0].source_url, 'https://archway.ramapo.edu/home/events/');
  assert.equal(result.organizers.events[0].collected_at, options.fetchedAt);
  for (const patch of [{ groupId: '999' }, { groupLogin: 'Other' }, { collectedAt: '' }, { sourceUrl: 'https://example.org/' }]) {
    data.artifacts.events = [{ ...listing, organizerIdentity: { ...listing.organizerIdentity, ...patch } }];
    assert.equal(compileArchwayIdentities(data).organizers.events.length, 0);
  }
  const invalid = validateArchwayEvents([{ ...listing, organizerIdentity: { ...listing.organizerIdentity, groupId: 'bad' } }]);
  assert.equal(invalid[0].organizerIdentity, undefined);
});

test('listing and detail disagreements retain evidence but block the relationship', () => {
  const data = snapshot();
  data.artifacts.events = [{ url: options.requestedUrl, organizer: 'Other Club', organizerIdentity: {
    groupId: '999', groupLogin: 'Other', sourceUrl: 'https://archway.ramapo.edu/home/events/', collectedAt: options.fetchedAt,
  } }];
  (data.artifacts.clubs as object[]).push({ name: 'Other Club', clubId: '999', websiteUrl: 'https://archway.ramapo.edu/Other/' });
  const result = compileArchwayIdentities(data, { eventDetails: { pages: [buildArchwayEventDetailPage(options)] } });
  assert.equal(result.organizers.events.length, 2);
  assert.equal(result.entities.find(e => e.kind === 'event')?.relationships, undefined);
  assert.ok(result.unresolved.some(i => i.reason.includes('conflict')));
});
