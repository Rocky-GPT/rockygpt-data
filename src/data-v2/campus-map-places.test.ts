import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { compileMapPlaces, facilityIdentityId, placeName } from './campus-map-places';

const pin = (id: string) => `https://map.ramapo.edu/?id=2292#!m/${id}?sbc/`;
const map = {
  buildings: [
    { key: 'building_bradley', name: 'Bill Bradley Sports and Recreation Center', category: 'Athletics', mapUrl: pin('1133348'), roomPrefixes: ['BR'] },
    { key: 'building_d', name: 'Academic Building D', category: 'Academic Buildings', mapUrl: pin('1133371'), roomPrefixes: ['D'] },
    { key: 'building_pine-hall', name: 'Pine Hall', category: 'Residences', mapUrl: pin('1133459'), roomPrefixes: [] },
    { key: 'building_lodge', name: 'The Lodge (CPA)', category: 'Residences', mapUrl: pin('1133346'), roomPrefixes: ['CPA'] },
  ],
  offices: [
    { key: 'office_auxiliary-gym', name: 'Auxiliary Gym', buildingKey: 'building_bradley', mapUrl: pin('1133348') },
    { key: 'office_athletics', name: 'Athletics Office', buildingKey: 'building_bradley', mapUrl: pin('1133348') },
    { key: 'office_pool', name: 'Thomas Swimming Pool', buildingKey: 'building_bradley', mapUrl: pin('1133348') },
    { key: 'office_arena', name: 'Arena', buildingKey: 'building_bradley', mapUrl: pin('1133348') },
    { key: 'office_registrar', name: 'Registrar', buildingKey: 'building_d', mapUrl: pin('1133371') },
    { key: 'office_public-safety', name: 'Public Safety', buildingKey: 'building_d', mapUrl: pin('1133371') },
    { key: 'office_lodge', name: 'Lodge', buildingKey: 'building_lodge', mapUrl: pin('1133346') },
    { key: 'office_nowhere', name: 'Lost Room', buildingKey: 'building_gone', mapUrl: pin('1') },
  ],
};
const node = (n: number, kind: CampusIdentity['kind'], name: string, aliases: string[] = []): CampusIdentity =>
  ({ id: `00000000-0000-4000-8000-00000000000${n}`, kind, name, aliases, links: [] });

test('a map place links the node named like it, a listed match, or a new facility, each located_at its building', () => {
  const gym = node(1, 'office', 'Auxiliary Gym');
  const athletics = node(2, 'office', 'Athletics');
  const pool = node(3, 'office', 'Swimming Pool');
  const registrar = node(4, 'office', 'Registrar', ['Office of the Registrar']);
  const safetyA = node(5, 'office', 'Public Safety (Emergency)', ['Public Safety']);
  const safetyB = node(6, 'office', 'Public Safety (Non-Emergency)', ['Public Safety']);
  const pine = node(7, 'office', 'Pine Hall');
  const program = node(8, 'program', 'Arena Studies');
  const entities = [gym, athletics, pool, registrar, safetyA, safetyB, pine, program];
  const buildings = campusBuildingsArtifact(map);
  const bradley = campusBuildingId(buildings.buildings.find(b => b.map_key === 'building_bradley')!);
  const result = compileMapPlaces(map, buildings, entities, {
    places: [{ map_key: 'office_pool', map_name: 'Thomas Swimming Pool', entity_ids: [pool.id], entities: ['Swimming Pool'], note: 'donor name' }],
  }, '2026-11-02T00:00:00.000Z');

  for (const placed of [gym, athletics, pool]) {
    assert.deepEqual(placed.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]), [['located_at', bradley]], placed.name);
    assert.deepEqual(placed.links, [{ collection: 'map_places', source_key: 'campus-map', source_record_keys: [placed === gym ? 'office_auxiliary-gym' : placed === athletics ? 'office_athletics' : 'office_pool'] }]);
  }
  assert.deepEqual(gym.relationships?.[0].evidence, [{ collection: 'map_places', source_key: 'campus-map', source_record_key: 'office_auxiliary-gym', field: 'building', source_url: pin('1133348') }]);
  // A place no node is gets a node of its own; a program is never a place.
  assert.deepEqual(result.entities.map(e => [e.id, e.kind, e.name]), [[facilityIdentityId('office_arena'), 'facility', 'Arena']]);
  assert.equal(program.relationships, undefined);
  // A name two nodes share places neither, until the list says which.
  assert.equal(safetyA.relationships, undefined);
  assert.ok(result.unresolved.some(u => u.record === 'office_public-safety' && u.kind === 'missing_connection'));
  // "Lodge" in The Lodge (CPA) is the building itself; a place in no building is reported.
  assert.ok(!result.entities.some(e => e.name === 'Lodge'));
  assert.ok(result.unresolved.some(u => u.entity === 'Lost Room'));
  // An office named for a building is in it.
  assert.deepEqual(pine.relationships?.map(r => [r.type, r.evidence[0].field]), [['located_at', 'name']]);
  assert.deepEqual(result.places.rows.map(r => r.source_record_key), ['office_auxiliary-gym', 'office_athletics', 'office_pool', 'office_arena', 'office_registrar', 'office_public-safety', 'office_lodge']);
  assert.deepEqual(result.buildings.rows.map(r => [r.source_record_key, r.name]), [
    ['1133346', 'The Lodge (CPA)'], ['1133348', 'Bill Bradley Sports and Recreation Center'], ['1133371', 'Academic Building D'], ['1133459', 'Pine Hall']]);
  assert.equal(result.places.collected_at, '2026-11-02T00:00:00.000Z');
});

test('a listed match that no longer names its node places nothing', () => {
  const pool = node(3, 'office', 'Pool');
  const result = compileMapPlaces(map, campusBuildingsArtifact(map), [pool], {
    places: [{ map_key: 'office_pool', map_name: 'Thomas Swimming Pool', entity_ids: [pool.id], entities: ['Swimming Pool'], note: '' }],
  });
  assert.equal(pool.relationships, undefined);
  assert.ok(result.unresolved.some(u => u.record === 'office_pool'));
});

test('place names drop only the words the map and directory spell differently', () => {
  assert.equal(placeName('Center for Student Involvement (CSI)'), 'center for student involvement');
  assert.equal(placeName('Office of the Registrar'), 'registrar');
  assert.equal(placeName('Athletics Office'), 'athletics');
  assert.equal(placeName('Building Maintenance (Repairs &amp; Trades Shops)'), 'building maintenance');
  assert.equal(placeName("Dunkin'"), 'dunkin');
  assert.notEqual(placeName('Health Services'), placeName('Counseling/Health Services'));
});
