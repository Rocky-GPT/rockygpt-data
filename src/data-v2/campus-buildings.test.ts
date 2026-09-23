import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { buildingIdentityId, campusBuildingsArtifact, compileBuildingIdentities, roomBuildings } from './campus-buildings';

const building = (name: string, id: string | null, roomPrefixes: string[]) => ({
  key: `building_${name}`, name, category: 'Academic Buildings', aliases: [name.toLowerCase()], roomPrefixes,
  mapUrl: id ? `https://map.ramapo.edu/?id=2292#!m/${id}?sbc/` : 'https://map.ramapo.edu/?id=2292#!ct/99549?sbc/',
});
const map = { source: 'https://api.concept3d.com/locations?map=2292', generatedAt: '2026-08-27T16:58:11.587Z', buildings: [
  building('Academic Building D', '1133371', ['D']),
  building('Anisfield School of Business (ASB)', '1133424', ['ASB']),
  building('Laurel Hall North Building', '1133458', ['LN']), building('Laurel Hall South Building', '1133458', []),
  building('Visitor Kiosk', null, ['VK']),
  building('Residence Hall', '1133500', []),
] };
const person = (id: string, name: string, key: string): CampusIdentity => ({ id, kind: 'person', name, aliases: [], links: [{ collection: 'contacts', source_key: 'faculty', source_record_keys: [key] }] });

test('only buildings with reviewed room prefixes and their own map location become identities', () => {
  const artifact = campusBuildingsArtifact(map);
  assert.deepEqual(artifact.buildings.map(b => [b.concept3d_id, b.name, b.room_prefixes]), [
    ['1133371', 'Academic Building D', ['D']], ['1133424', 'Anisfield School of Business (ASB)', ['ASB']],
  ]);
  assert.deepEqual(artifact.unresolved.map(u => u.name), ['Laurel Hall North Building', 'Visitor Kiosk']);
  assert.deepEqual(artifact.source, { source_key: 'campus-map', title: 'Ramapo Campus Map', canonical_url: 'https://map.ramapo.edu/', trust_tier: 'official_primary', freshness_sla_hours: 4320, domain: 'map' });
  assert.equal(artifact.map_generated_at, map.generatedAt);
  // A rename keeps the building's identity; the ID derives from its map location.
  assert.equal(buildingIdentityId('1133371'), buildingIdentityId('1133371'));
  assert.notEqual(buildingIdentityId('1133371'), buildingIdentityId('1133424'));
  assert.deepEqual(campusBuildingsArtifact(undefined).buildings, []);
});

test('a room names a building only as PREFIX-NUMBER rooms with reviewed prefixes', () => {
  const prefixes = new Map([['D', 'building-d'], ['ASB', 'building-asb']]);
  assert.deepEqual(roomBuildings('D-224', prefixes), { buildings: ['building-d'] });
  assert.deepEqual(roomBuildings('D-216C', prefixes), { buildings: ['building-d'] });
  assert.deepEqual(roomBuildings('D-203B / ASB-431D', prefixes), { buildings: ['building-d', 'building-asb'] });
  assert.deepEqual(roomBuildings('D-201 / D-202', prefixes), { buildings: ['building-d'] });
  for (const room of ['Learning Commons 204A', 'The Lodge', 'SS-106', 'd-224', 'D224', 'D-224, ASB-100', 'D-224 / Lobby']) {
    assert.ok('reason' in (roomBuildings(room, prefixes) ?? {}), room);
  }
  assert.equal(roomBuildings(null, prefixes), null);
  assert.equal(roomBuildings('  ', prefixes), null);
});

test('people get office_at and offices get located_at from their own contact rooms', () => {
  const artifact = campusBuildingsArtifact(map);
  const professor = person('00000000-0000-4000-8000-000000000001', 'Test Professor', 'faculty:test');
  const shared = person('00000000-0000-4000-8000-000000000002', 'Two Rooms', 'faculty:two');
  const unplaced = person('00000000-0000-4000-8000-000000000003', 'No Building', 'faculty:none');
  const registrar: CampusIdentity = { id: '00000000-0000-4000-8000-000000000004', kind: 'office', name: 'Registrar', aliases: [], links: [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:registrar'] }] };
  const program: CampusIdentity = { id: '00000000-0000-4000-8000-000000000005', kind: 'program', name: 'Academic Building D', aliases: [], links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: ['p'] }] };
  const contacts = new Map([
    ['faculty:faculty:test', { office: 'ASB-409' }], ['faculty:faculty:two', { office: 'D-203B / ASB-431D' }],
    ['faculty:faculty:none', { office: 'Learning Commons 204A' }], ['campus-directory:office:registrar', { office: 'D-224' }],
  ]);
  const { buildings, unresolved } = compileBuildingIdentities(artifact, [professor, shared, unplaced, registrar, program], contacts);
  const [d, asb] = buildings;
  assert.deepEqual([d.id, d.kind, d.name, d.aliases], [buildingIdentityId('1133371'), 'building', 'Academic Building D', []]);
  assert.deepEqual(d.links, [{ collection: 'buildings', source_key: 'campus-map', source_record_keys: ['1133371'] }]);
  assert.deepEqual(professor.relationships, [{ type: 'office_at', target_entity_id: asb.id, evidence: [
    { collection: 'contacts', source_key: 'faculty', source_record_key: 'faculty:test', field: 'office' },
  ] }]);
  assert.deepEqual(shared.relationships?.map(r => [r.type, 'target_entity_id' in r && r.target_entity_id]), [['office_at', d.id], ['office_at', asb.id]]);
  assert.deepEqual(registrar.relationships?.map(r => [r.type, 'target_entity_id' in r && r.target_entity_id]), [['located_at', d.id]]);
  assert.equal(unplaced.relationships, undefined);
  assert.equal(program.relationships, undefined);
  assert.ok(unresolved.some(u => u.entity === 'No Building' && u.reason.includes('no building is inferred')));
  // A building named like another identity is kept for an ambiguous lookup, not merged.
  assert.ok(unresolved.some(u => u.entity === 'Academic Building D' && u.reason.includes('program "Academic Building D"')));
});
