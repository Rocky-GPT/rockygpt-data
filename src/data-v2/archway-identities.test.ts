import assert from 'node:assert/strict';
import test from 'node:test';
import { archwayEventId, archwayIdentityId, compileArchwayIdentities, eventOrganizersArtifact } from './archway-identities';
import { validateCampusIdentities } from './campus-identities';
import { compileCampusIdentities, type IdentitySnapshot } from './compile-campus-identities';
import { validateArchwayClubs } from '../../ingestion/schema';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const club = { id: id(1), source_key: 'archway-clubs', source_record_key: 'Example Club', name: 'Example Club', category: 'Student Organization', website_url: 'https://archway.ramapo.edu/example/' };
const event = { id: id(2), source_key: 'archway-events', source_record_key: 'Sep 21:Meeting', title: 'Meeting', starts_at: '2026-09-22T01:00:00Z', organizer: 'Example Club', event_url: 'https://archway.ramapo.edu/rsvp_boot?id=901' };
const sourceClub = { name: 'Example Club', category: 'Student Organization', websiteUrl: club.website_url, clubId: '801' };
const page = { url: event.event_url, statusCode: 200, fetchedAt: '2026-09-20T14:00:00Z', links: [club.website_url, 'https://archway.ramapo.edu/events?group_ids=801'], sections: [{ heading: 'Meeting', text: 'by Example Club Social/Entertainment' }] };
const fixture = (): IdentitySnapshot => ({ campus_contacts: [], campus_hours: [], dining_hours: [], menu_items: [], programs: [], clubs: [{ ...club }], events: [{ ...event }], artifacts: { clubs: [{ ...sourceClub }] } });
const inputs = () => ({ eventDetails: { pages: [structuredClone(page)] } });

test('explicit source IDs assemble event→club with original records and actual page time', () => {
  const snapshot = fixture(); const before = JSON.stringify(snapshot);
  const result = compileCampusIdentities({ schema_version: 1, entities: [] }, snapshot, undefined, inputs());
  assert.equal(result.registry.entities.length, 2);
  const eventIdentity = result.registry.entities.find(e => e.kind === 'event')!;
  const clubIdentity = result.registry.entities.find(e => e.kind === 'club')!;
  assert.equal(eventIdentity.name, 'Meeting (2026-09-21)');
  assert.deepEqual(eventIdentity.aliases, ['Meeting']);
  assert.equal(eventIdentity.relationships?.[0].type, 'organized_by');
  assert.equal(eventIdentity.relationships?.[0].target_entity_id, clubIdentity.id);
  assert.deepEqual(eventIdentity.links[0].source_record_ids, [event.id]);
  assert.equal(result.eventOrganizers.events[0].collected_at, page.fetchedAt);
  assert.equal(result.eventOrganizers.events[0].source_record_id, event.id);
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(compileCampusIdentities({ schema_version: 1, entities: [] }, snapshot, undefined, inputs()), result);
});

test('identity survives title, date, club name, website and publication row-ID refresh', () => {
  const initial = compileArchwayIdentities(fixture(), inputs());
  const next = fixture();
  next.events![0] = { ...event, id: id(20), title: 'New Meeting', source_record_key: 'Oct 2:New Meeting', starts_at: '2026-10-03T01:00:00Z' };
  next.clubs![0] = { ...club, id: id(21), name: 'Renamed Club', source_record_key: 'Renamed Club', website_url: 'https://archway.ramapo.edu/new-example/' };
  next.artifacts.clubs = [{ ...sourceClub, name: 'Renamed Club', websiteUrl: 'https://archway.ramapo.edu/new-example/' }];
  next.events!.push({ ...event, id: id(22), event_url: 'https://archway.ramapo.edu/rsvp_boot?id=902' });
  const updated = compileArchwayIdentities(next);
  assert.equal(updated.entities.find(e => e.kind === 'club')!.id, initial.entities.find(e => e.kind === 'club')!.id);
  const same = updated.entities.find(e => e.id === archwayIdentityId('event', '901'))!;
  assert.equal(same.name, 'New Meeting (2026-10-02)');
  assert.deepEqual(same.links[0].source_record_keys, ['Oct 2:New Meeting']);
  assert.deepEqual(same.links[0].source_record_ids, [id(20)]);
  assert.equal(updated.entities.filter(e => e.kind === 'event').length, 2);
});

test('same title/date legacy key collisions stay distinct via external IDs and pinned rows', () => {
  const snapshot = fixture();
  snapshot.events!.push({ ...event, id: id(3), event_url: 'https://archway.ramapo.edu/rsvp_boot?id=902' });
  const result = compileCampusIdentities({ schema_version: 1, entities: [] }, snapshot);
  const events = result.registry.entities.filter(e => e.kind === 'event');
  assert.equal(events.length, 2); assert.notEqual(events[0].id, events[1].id);
  assert.deepEqual(events[0].links[0].source_record_keys, events[1].links[0].source_record_keys);
  validateCampusIdentities(result.registry);
  const invalid = structuredClone(result.registry);
  for (const e of invalid.entities.filter(e => e.kind === 'event')) delete e.links[0].source_record_ids;
  assert.throws(() => validateCampusIdentities(invalid), /exactly one/);
});

test('recurring names across dates are separate occurrences; duplicated external occurrence ID fails closed', () => {
  const snapshot = fixture();
  snapshot.events!.push({ ...event, id: id(3), source_record_key: 'Sep 28:Meeting', starts_at: '2026-09-29T01:00:00Z', event_url: 'https://archway.ramapo.edu/rsvp_boot?id=902' });
  assert.equal(compileArchwayIdentities(snapshot).entities.filter(e => e.kind === 'event').length, 2);
  snapshot.events![1].event_url = event.event_url;
  const result = compileArchwayIdentities(snapshot);
  assert.equal(result.entities.filter(e => e.kind === 'event').length, 0);
  assert.equal(result.unresolved.filter(i => i.reason.includes('nonunique')).length, 2);
});

test('missing date preserves occurrence identity without pretending a date is known', () => {
  const snapshot = fixture(); snapshot.events![0].starts_at = null;
  const result = compileArchwayIdentities(snapshot);
  const e = result.entities.find(e => e.kind === 'event')!;
  assert.equal(e.id, archwayIdentityId('event', '901'));
  assert.equal(e.name, 'Meeting (date not published)');
  assert.ok(result.unresolved.some(i => i.reason.includes('date is not published')));
});

test('organizer name and venue text alone never join identities; a group needs its explicit ID bridge', () => {
  const snapshot = fixture();
  snapshot.clubs!.push({ ...club, id: id(4), name: 'Center for Student Involvement', source_record_key: 'CSI', category: 'Department', website_url: 'https://archway.ramapo.edu/CSI/' });
  const result = compileArchwayIdentities(snapshot);
  assert.equal(result.entities.filter(e => e.kind === 'club').length, 1);
  assert.equal(result.entities.filter(e => e.kind === 'organization').length, 0);
  assert.equal(result.entities.find(e => e.kind === 'event')!.relationships, undefined);
  assert.ok(result.unresolved.some(i => i.record === 'CSI' && i.reason.includes('No unique explicit Archway group ID')));
  assert.ok(result.unresolved.some(i => i.reason.includes('organizer and location names remain source text')));
});

test('non-club directory groups become organizations that can organize events and keep IDs across categories', () => {
  const snapshot = fixture();
  const center = { ...club, id: id(5), name: "Women's Center", source_record_key: "Women's Center", category: 'Department', website_url: 'https://archway.ramapo.edu/Womens/' };
  snapshot.clubs = [center];
  snapshot.artifacts.clubs = [{ name: "Women's Center", category: 'Department', websiteUrl: center.website_url, clubId: '34151' }];
  snapshot.events = [{ ...event, organizer: "Women's Center" }];
  const detail = { ...structuredClone(page), links: [center.website_url, 'https://archway.ramapo.edu/events?group_ids=34151'], sections: [{ heading: 'Meeting', text: "by Women's Center Social" }] };
  const result = compileCampusIdentities({ schema_version: 1, entities: [] }, snapshot, undefined, { eventDetails: { pages: [detail] } });
  validateCampusIdentities(result.registry);
  const organization = result.registry.entities.find(e => e.kind === 'organization')!;
  assert.equal(organization.id, archwayIdentityId('club', '34151'));
  const occurrence = result.registry.entities.find(e => e.kind === 'event')!;
  assert.equal(occurrence.relationships?.[0].type, 'organized_by');
  assert.equal(occurrence.relationships?.[0].target_entity_id, organization.id);
  snapshot.clubs[0].category = 'Student Organization';
  const recategorized = compileArchwayIdentities(snapshot, { eventDetails: { pages: [detail] } });
  assert.equal(recategorized.entities.find(e => e.kind === 'club')!.id, organization.id);
});

test('an Archway group named like a reviewed identity is reported instead of duplicated', () => {
  const snapshot = fixture();
  snapshot.clubs!.push({ ...club, id: id(6), name: 'Center for Student Involvement', source_record_key: 'CSI', category: 'Department', website_url: 'https://archway.ramapo.edu/CSI/' });
  snapshot.artifacts.clubs = [{ ...sourceClub }, { name: 'Center for Student Involvement', category: 'Department', websiteUrl: 'https://archway.ramapo.edu/CSI/', clubId: '34106' }];
  assert.equal(compileArchwayIdentities(snapshot).entities.filter(e => e.kind === 'organization').length, 1);
  const reviewed = compileCampusIdentities({ schema_version: 1, entities: [{
    id: id(90), kind: 'office', name: 'Center for Student Involvement', aliases: ['CSI'],
    links: [{ collection: 'contacts', source_key: 'directory', source_record_keys: ['office:csi'] }],
  }] }, { ...snapshot, campus_contacts: [{ source_key: 'directory', source_record_key: 'office:csi', name: 'Center for Student Involvement' }] });
  assert.equal(reviewed.registry.entities.filter(e => e.kind === 'organization').length, 0);
  assert.ok(reviewed.report.unresolved.some(i => i.record === 'CSI' && i.reason.includes('needs a reviewed link')));
});

test('ambiguous URL→group ID, missing website and malformed source URLs never create identities', () => {
  const snapshot = fixture();
  const result = compileArchwayIdentities(snapshot, { clubs: [{ ...sourceClub, clubId: '999' }] });
  assert.equal(result.entities.filter(e => e.kind === 'club').length, 0);
  snapshot.clubs![0].website_url = null;
  assert.equal(compileArchwayIdentities(snapshot).entities.filter(e => e.kind === 'club').length, 0);
  for (const url of ['ftp://archway.ramapo.edu/rsvp_boot?id=901', 'https://other.example/rsvp_boot?id=901', 'https://archway.ramapo.edu/events?id=901']) assert.equal(archwayEventId(url), '');
});

test('same-organizer repeated captures preserve timestamps; conflicting captures/current names block the edge', () => {
  const snapshot = fixture();
  const repeated = { eventDetails: { pages: [page, { ...page, fetchedAt: '2026-09-21T15:00:00Z' }] } };
  const first = compileArchwayIdentities(snapshot, repeated);
  assert.equal(first.organizers.events.length, 2);
  assert.equal(first.entities.find(e => e.kind === 'event')!.relationships?.length, 1);
  snapshot.events![0].organizer = 'Someone Else';
  const conflict = compileArchwayIdentities(snapshot, repeated);
  assert.equal(conflict.organizers.events.length, 2);
  assert.equal(conflict.entities.find(e => e.kind === 'event')!.relationships, undefined);
  assert.ok(conflict.unresolved.some(i => i.reason.includes('conflicts')));
  snapshot.events![0].organizer = 'Example Club';
  snapshot.artifacts.clubs = [sourceClub, { ...sourceClub, name: 'Other Club', clubId: '802', websiteUrl: 'https://archway.ramapo.edu/other/' }];
  const other = { ...page, links: ['https://archway.ramapo.edu/other/', 'https://archway.ramapo.edu/events?group_ids=802'], sections: [{ text: 'by Other Club Social' }] };
  const changed = compileArchwayIdentities(snapshot, { eventDetails: { pages: [page, other] } });
  assert.equal(changed.organizers.events.length, 2);
  assert.equal(changed.entities.find(e => e.kind === 'event')!.relationships, undefined);
});

test('relationship extraction requires explicit by-line, group link, exact event ID and real capture time', () => {
  const snapshot = fixture();
  for (const bad of [{ ...page, fetchedAt: '' }, { ...page, statusCode: 403 }, { ...page, sections: [{ text: 'by Example Clubhouse' }] }, { ...page, links: [club.website_url] }, { ...page, links: ['https://archway.ramapo.edu/events?group_ids=801'] }]) {
    assert.equal(eventOrganizersArtifact(snapshot, { eventDetails: { pages: [bad] } }).events.length, 0);
  }
});

test('normal ingestion preserves the official group ID without inventing one', () => {
  assert.equal(validateArchwayClubs([sourceClub])[0].clubId, '801');
  assert.equal(validateArchwayClubs([{ ...sourceClub, clubId: 'not-an-id' }])[0].clubId, undefined);
});
