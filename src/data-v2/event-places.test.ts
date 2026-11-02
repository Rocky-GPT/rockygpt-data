import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { linkEventPlaces } from './event-places';

const pin = (id: string) => `https://map.ramapo.edu/?id=2292#!m/${id}?sbc/`;
const artifact = campusBuildingsArtifact({ buildings: [
  { key: 'building_berrie', name: 'Berrie Center', mapUrl: pin('1133432'), roomPrefixes: ['BC'] },
  { key: 'building_e', name: 'Academic Building E', mapUrl: pin('1133372'), roomPrefixes: ['E'] },
  { key: 'building_birch', name: 'Birch Mansion', mapUrl: pin('1133345'), roomPrefixes: [] },
  { key: 'building_thomases', name: 'Thomases Commons', mapUrl: pin('1133475'), roomPrefixes: [] },
] });
const id = (key: string) => campusBuildingId(artifact.buildings.find(b => b.map_key === key)!);
const building = (key: string, name: string): CampusIdentity => ({ id: id(key), kind: 'building', name, aliases: [], links: [] });
const york: CampusIdentity = { id: '00000000-0000-4000-8000-000000000010', kind: 'facility', name: 'York Room', aliases: [],
  links: [{ collection: 'map_places', source_key: 'campus-map', source_record_keys: ['office_york-room'] }],
  relationships: [{ type: 'located_at', target_entity_id: id('building_birch'), evidence: [{ collection: 'map_places', source_key: 'campus-map', source_record_key: 'office_york-room', field: 'building' }] }] };
const event = (n: number, location: string) => ({
  entity: { id: `00000000-0000-4000-8000-00000000010${n}`, kind: 'event', name: `Event ${n}`, aliases: [],
    links: [{ collection: 'events', source_key: 'archway-events', source_record_keys: [`e${n}`] }] } as CampusIdentity,
  row: { source_key: 'archway-events', source_record_key: `e${n}`, event_url: `https://archway.ramapo.edu/rsvp_boot?id=${n}`, listing: { location } },
});

test('an event is held_at the place or building its listed location names', () => {
  const events = [
    event(1, 'Berrie Center Sharp Theater (BC 125)'), event(2, 'Wellness Room (E-216)'), event(3, 'The York Room - Mansion'),
    event(4, 'Thomases Commons'), event(5, 'Online Event'), event(6, '-'), event(7, 'Private Location (register to display)'),
  ];
  const entities = [building('building_berrie', 'Berrie Center'), building('building_e', 'Academic Building E'),
    building('building_birch', 'Birch Mansion'), building('building_thomases', 'Thomases Commons'), york, ...events.map(e => e.entity)];
  const result = linkEventPlaces(entities, events.map(e => e.row), artifact);
  const held = events.map(e => (e.entity.relationships ?? []).map(r => 'target_entity_id' in r ? entities.find(x => x.id === r.target_entity_id)?.name : null));
  assert.deepEqual(held, [['Berrie Center'], ['Academic Building E'], ['York Room'], ['Thomases Commons'], [], [], []]);
  assert.equal(result.linked, 4);
  assert.deepEqual(events[0].entity.relationships?.[0].evidence, [{ collection: 'events', source_key: 'archway-events', source_record_key: 'e1', field: 'location', source_url: 'https://archway.ramapo.edu/rsvp_boot?id=1' }]);
});

test('an event with no organizer group is organized_by the one node named like its organizer', async () => {
  const { linkEventOrganizers } = await import('./event-places');
  const office: CampusIdentity = { id: '00000000-0000-4000-8000-000000000201', kind: 'office', name: 'Roukema Center for International Education', aliases: [], links: [] };
  const school: CampusIdentity = { id: '00000000-0000-4000-8000-000000000202', kind: 'school', name: 'School of Arts, Humanities, and Education', aliases: [], links: [] };
  const twinA: CampusIdentity = { id: '00000000-0000-4000-8000-000000000203', kind: 'office', name: 'Public Safety (Emergency)', aliases: [], links: [] };
  const twinB: CampusIdentity = { id: '00000000-0000-4000-8000-000000000204', kind: 'office', name: 'Public Safety (Non-Emergency)', aliases: [], links: [] };
  const made = [event(1, ''), event(2, ''), event(3, ''), event(4, '')];
  const organizers = ['Roukema Center for International Education', 'School of Arts. Humanities, and Education', 'Public Safety', 'Somebody Else'];
  const rows = made.map((e, index) => ({ ...e.row, organizer: organizers[index] }));
  const result = linkEventOrganizers([office, school, twinA, twinB, ...made.map(e => e.entity)], rows);
  assert.deepEqual(made.map(e => e.entity.relationships?.map(r => 'target_entity_id' in r ? r.target_entity_id : null)), [[office.id], [school.id], undefined, undefined]);
  assert.equal(result.linked, 2);
  assert.equal(made[0].entity.relationships?.[0].evidence[0].field, 'organizer');
});

test('a stored event row, which has no location column, is placed from the release listing with its URL', () => {
  const { entity, row } = event(8, '');
  const stored: Record<string, unknown> = { ...row }; delete stored.listing;
  const listings = [{ url: 'https://archway.ramapo.edu/rsvp_boot?id=8', location: 'Berrie Center Sharp Theater (BC 125)' },
    { url: 'https://archway.ramapo.edu/rsvp_boot?id=9', location: 'Wellness Room (E-216)' }];
  linkEventPlaces([building('building_berrie', 'Berrie Center'), entity], [stored], artifact, listings);
  assert.deepEqual(entity.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]), [['held_at', id('building_berrie')]]);
});
