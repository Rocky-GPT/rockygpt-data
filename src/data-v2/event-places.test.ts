import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { linkEventOrganizers, linkEventPlaces, withoutWhereInside, type ReviewedEventPlaces } from './event-places';
import eventPlaceReadings from '../reference/event-places.json';

const pin = (id: string) => `https://map.ramapo.edu/?id=2292#!m/${id}?sbc/`;
const artifact = campusBuildingsArtifact({ buildings: [
  { key: 'building_berrie', name: 'Berrie Center', mapUrl: pin('1133432'), roomPrefixes: ['BC'] },
  { key: 'building_e', name: 'Academic Building E', mapUrl: pin('1133372'), roomPrefixes: ['E'] },
  { key: 'building_birch', name: 'Birch Mansion', mapUrl: pin('1133345'), roomPrefixes: [] },
  { key: 'building_thomases', name: 'Thomases Commons', mapUrl: pin('1133475'), roomPrefixes: [] },
  { key: 'building_c', name: 'Academic Building C', mapUrl: pin('1133370'), roomPrefixes: ['C'] },
  { key: 'building_sc', name: 'Student Center (SC)', mapUrl: pin('1218428'), roomPrefixes: ['SC'] },
  { key: 'building_pavilion', name: 'Trustees Pavilion', mapUrl: pin('1099060'), roomPrefixes: [] },
  { key: 'building_mackin', name: 'Nancy Mackin Hall', mapUrl: pin('1133462'), roomPrefixes: [] },
] });
const id = (key: string) => campusBuildingId(artifact.buildings.find(b => b.map_key === key)!);
const building = (key: string, name: string, aliases: string[] = []): CampusIdentity => ({ id: id(key), kind: 'building', name, aliases, links: [] });
/** A place the campus map lists in a building. */
const mapPlace = (n: number, kind: CampusIdentity['kind'], name: string, buildingKey: string, aliases: string[] = []): CampusIdentity => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, kind, name, aliases,
  links: [{ collection: 'map_places', source_key: 'campus-map', source_record_keys: [`office_${n}`] }],
  relationships: [{ type: 'located_at', target_entity_id: id(buildingKey), evidence: [{ collection: 'map_places', source_key: 'campus-map', source_record_key: `office_${n}`, field: 'building' }] }] });
const york = mapPlace(10, 'facility', 'York Room', 'building_birch');
const event = (n: number, location: string) => ({
  entity: { id: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`, kind: 'event', name: `Event ${n}`, aliases: [],
    links: [{ collection: 'events', source_key: 'archway-events', source_record_keys: [`e${n}`] }] } as CampusIdentity,
  row: { source_key: 'archway-events', source_record_key: `e${n}`, event_url: `https://archway.ramapo.edu/rsvp_boot?id=${n}`, listing: { location } },
});
const heldAt = (events: ReturnType<typeof event>[], entities: CampusIdentity[]) =>
  events.map(e => (e.entity.relationships ?? []).map(r => 'target_entity_id' in r ? entities.find(x => x.id === r.target_entity_id)?.name : null));

test('an event is held_at the place or building its listed location names', () => {
  const events = [
    event(1, 'Berrie Center Sharp Theater (BC 125)'), event(2, 'Wellness Room (E-216)'), event(3, 'The York Room - Mansion'),
    event(4, 'Thomases Commons'), event(5, 'Online Event'), event(6, '-'), event(7, 'Private Location (register to display)'),
  ];
  const entities = [building('building_berrie', 'Berrie Center'), building('building_e', 'Academic Building E'),
    building('building_birch', 'Birch Mansion'), building('building_thomases', 'Thomases Commons'), york, ...events.map(e => e.entity)];
  const result = linkEventPlaces(entities, events.map(e => e.row), artifact);
  assert.deepEqual(heldAt(events, entities), [['Berrie Center'], ['Academic Building E'], ['York Room'], ['Thomases Commons'], [], [], []]);
  assert.equal(result.linked, 4);
  assert.deepEqual(events[0].entity.relationships?.[0].evidence, [{ collection: 'events', source_key: 'archway-events', source_record_key: 'e1', field: 'location', source_url: 'https://archway.ramapo.edu/rsvp_boot?id=1' }]);
});

test('words that only say where inside a place are set aside: a floor, a lounge or lobby, a room number', () => {
  assert.equal(withoutWhereInside('Mackin 1st Floor Lounge'), 'Mackin');
  assert.equal(withoutWhereInside('Bischoff 2nd floor lounge'), 'Bischoff');
  assert.equal(withoutWhereInside('Laurel 1st FL Lounge'), 'Laurel');
  assert.equal(withoutWhereInside('Laurel Hall 1st Floor Movie Theatre'), 'Laurel Hall');
  assert.equal(withoutWhereInside('2nd Floor Student Center Lobby'), 'Student Center');
  assert.equal(withoutWhereInside('CPA Lodge Main Lobby'), 'CPA Lodge');
  assert.equal(withoutWhereInside('Trustees Pavilion 1-3'), 'Trustees Pavilion');
  // Words that say the event is beside a place, or a place of its own, stay.
  assert.equal(withoutWhereInside('Outside of Atrium'), 'Outside of Atrium');
  assert.equal(withoutWhereInside('Arch Courtyard'), 'Arch Courtyard');
  assert.equal(withoutWhereInside('Bradley Center Bus Stop'), 'Bradley Center Bus Stop');
});

test('an event in a lounge, lobby, floor or numbered room of a building is held_at that building, and only a building', () => {
  // "Alumni Lounge" is not the Alumni Office, though the office's name drops to "alumni" as map places compare.
  const alumni = mapPlace(11, 'office', 'Office of Alumni Relations', 'building_birch', ['Alumni Office']);
  const atrium = mapPlace(12, 'venue', 'The Atrium', 'building_sc');
  const events = [event(1, 'Thomases Commons Lounge'), event(2, '2nd Floor Student Center Lobby'), event(3, 'Trustees Pavilion 1-3'),
    event(4, 'Alumni Lounge'), event(5, 'Outside of Atrium')];
  const entities = [building('building_thomases', 'Thomases Commons'), building('building_sc', 'Student Center (SC)', ['Student Center']),
    building('building_pavilion', 'Trustees Pavilion'), building('building_birch', 'Birch Mansion'), alumni, atrium, ...events.map(e => e.entity)];
  const result = linkEventPlaces(entities, events.map(e => e.row), artifact);
  assert.deepEqual(heldAt(events, entities), [['Thomases Commons'], ['Student Center (SC)'], ['Trustees Pavilion'], [], []]);
  assert.equal(result.linked, 3);
  assert.equal(events[0].entity.relationships?.[0].evidence.length, 1);
});

test('a name no node carries places an event by a reviewed reading, only while the captured page still says so', () => {
  const fishbowl = mapPlace(13, 'facility', 'Fishbowl Lounge', 'building_c');
  const reading = { reviewed_at: '2026-11-03', note: 'Read for the test.' };
  const reviewed: ReviewedEventPlaces = { schema_version: 1, places: [
    { ...reading, names: ['Friends Hall'], room: 'SC-219', url: 'https://www.ramapo.edu/csi/', section: 'Conference and Meeting Rooms', quote: 'Friends Hall (SC-219) – Large tiled multipurpose room.' },
    { ...reading, names: ['Fish Bowl', 'Fishbowl'], place: 'Fishbowl Lounge', url: 'https://www.ramapo.edu/conferences/nj-deca/', section: 'Waiting areas', quote: 'C Wing 2nd floor Lounge, also known as the Fishbowl' },
    { ...reading, names: ['Mackin'], place: 'Nancy Mackin Hall', url: 'https://www.ramapo.edu/reslife/gtcl/', section: 'Hotspots', quote: 'Front entrances to each traditional residence hall: Bischoff, Mackin' },
    // The page has since given J. Lee's another room: the reading is withheld, not published from the older page.
    { ...reading, names: ['J. Lee’s'], room: 'SC-226', url: 'https://www.ramapo.edu/csi/', section: 'J. Lee’s', quote: 'Location: Student Center Annex, SC-226' },
    // A room the quote does not give, and a place that is no node, place nothing.
    { ...reading, names: ['Conference Room'], room: 'SC-999', url: 'https://www.ramapo.edu/csi/', section: 'Conference and Meeting Rooms', quote: 'Friends Hall (SC-219)' },
    { ...reading, names: ['Nowhere'], place: 'Nowhere Hall', url: 'https://www.ramapo.edu/reslife/gtcl/', section: 'Hotspots', quote: 'Bischoff, Mackin' },
  ] };
  const pages = [
    { source_key: 'office-pages', source_record_key: 'www.ramapo.edu/csi/', sections: [
      { heading: 'Conference and Meeting Rooms', text: 'Conference Room (SC-217). Friends Hall (SC-219) –  Large tiled\nmultipurpose room. Ideal for movies.' },
      { heading: 'J. Lee’s', text: 'Location: Student Center Annex, SC-230' }] },
    { source_key: 'office-pages', source_record_key: 'www.ramapo.edu/conferences/nj-deca/', sections: [
      { heading: 'Waiting areas', text: 'B Wing 2nd floor Lounge C Wing 2nd floor Lounge, also known as the Fishbowl D215 classroom' }] },
    { source_key: 'office-pages', source_record_key: 'www.ramapo.edu/reslife/gtcl/', sections: [
      { heading: 'Hotspots', text: 'Front entrances to each traditional residence hall: Bischoff, Mackin, Laurel, and Overlook' }] },
  ];
  const events = [event(1, 'Friends Hall'), event(2, 'Fish Bowl'), event(3, 'Mackin 1st Floor Lounge'), event(4, 'J Lees'), event(5, 'Friends Hall, SC219')];
  const entities = [building('building_sc', 'Student Center (SC)'), building('building_c', 'Academic Building C'), building('building_mackin', 'Nancy Mackin Hall'),
    fishbowl, ...events.map(e => e.entity)];
  const result = linkEventPlaces(entities, events.map(e => e.row), artifact, [], pages, reviewed);
  // The Fishbowl is the map place, which stands for its building.
  assert.deepEqual(heldAt(events, entities), [['Student Center (SC)'], ['Fishbowl Lounge'], ['Nancy Mackin Hall'], [], ['Student Center (SC)']]);
  // The link cites the page the reading quotes, beside the listing.
  assert.deepEqual(events[0].entity.relationships?.[0].evidence.map(e => [e.collection, e.source_record_key, e.field, e.source_url]),
    [['events', 'e1', 'location', 'https://archway.ramapo.edu/rsvp_boot?id=1'], ['office_sections', 'www.ramapo.edu/csi/', 'sections', 'https://www.ramapo.edu/csi/']]);
  // A listing that gives the room itself needs no reading.
  assert.equal(events[4].entity.relationships?.[0].evidence.length, 1);
  assert.deepEqual(result.unresolved.map(issue => [issue.entity, issue.record]),
    [['J. Lee’s', 'www.ramapo.edu/csi/'], ['Conference Room', 'www.ramapo.edu/csi/'], ['Nowhere', 'www.ramapo.edu/reslife/gtcl/']]);
});

test('each reviewed event place gives its listing names, one room or place, and the quote that backs it', () => {
  const reviewed = eventPlaceReadings as ReviewedEventPlaces;
  assert.equal(reviewed.schema_version, 1);
  for (const entry of reviewed.places) {
    assert.ok(entry.names.length && entry.names.every(name => name && name === name.trim()), entry.names.join(', '));
    assert.notEqual(Boolean(entry.room), Boolean(entry.place), `${entry.names[0]} names a room or a place`);
    if (entry.room) assert.ok(entry.quote.includes(entry.room), `${entry.names[0]}: the quote gives ${entry.room}`);
    assert.match(entry.url, /^https:\/\/www\.ramapo\.edu\//);
    assert.match(entry.reviewed_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.section && entry.quote && entry.note);
  }
});

test('an event with no organizer group is organized_by the one node named like its organizer', () => {
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

test('an organizer written like one node is that node, though another matches once "Office" is dropped', () => {
  // The school and its own office both compare as "school of arts humanities and education" once
  // placeName drops the trailing "Office"; the organizer writes the school's name (a period for a comma).
  const school: CampusIdentity = { id: '00000000-0000-4000-8000-000000000202', kind: 'school', name: 'School of Arts, Humanities, and Education', aliases: ['AHE'], links: [] };
  const schoolOffice: CampusIdentity = { id: '00000000-0000-4000-8000-000000000205', kind: 'office', name: 'School of Arts, Humanities, and Education Office', aliases: ['AHE Office'], links: [] };
  const registrar: CampusIdentity = { id: '00000000-0000-4000-8000-000000000206', kind: 'office', name: 'Registrar', aliases: [], links: [] };
  const made = [event(1, ''), event(2, ''), event(3, ''), event(4, '')];
  const organizers = ['School of Arts. Humanities, and Education', 'School of Arts, Humanities, and Education Office', 'Office of the Registrar', 'AHE'];
  const rows = made.map((e, index) => ({ ...e.row, organizer: organizers[index] }));
  linkEventOrganizers([school, schoolOffice, registrar, ...made.map(e => e.entity)], rows);
  // Only placeName finds the Registrar ("Office of the" dropped); no node is written that way.
  assert.deepEqual(made.map(e => e.entity.relationships?.map(r => 'target_entity_id' in r ? r.target_entity_id : null)), [[school.id], [schoolOffice.id], [registrar.id], [school.id]]);
});

test('a stored event row, which has no location column, is placed from the release listing with its URL', () => {
  const { entity, row } = event(8, '');
  const stored: Record<string, unknown> = { ...row }; delete stored.listing;
  const listings = [{ url: 'https://archway.ramapo.edu/rsvp_boot?id=8', location: 'Berrie Center Sharp Theater (BC 125)' },
    { url: 'https://archway.ramapo.edu/rsvp_boot?id=9', location: 'Wellness Room (E-216)' }];
  linkEventPlaces([building('building_berrie', 'Berrie Center'), entity], [stored], artifact, listings);
  assert.deepEqual(entity.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]), [['held_at', id('building_berrie')]]);
});
