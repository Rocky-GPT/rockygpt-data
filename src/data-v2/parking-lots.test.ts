import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { compileParkingLots, parkingLotId } from './parking-lots';

const artifact = campusBuildingsArtifact({ buildings: [
  { key: 'building_student-center-sc', name: 'Student Center (SC)', mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1218428?sbc/', roomPrefixes: ['SC'] },
] });
const safety: CampusIdentity = { id: '00000000-0000-4000-8000-000000000401', kind: 'office', name: 'Public Safety (Non-Emergency)', aliases: [], links: [] };
const page = { source_key: 'office-pages', source_record_key: 'www.ramapo.edu/publicsafety/parking-maps/', url: 'https://www.ramapo.edu/publicsafety/parking-maps/',
  collected_at: '2026-11-02T00:00:00Z', sections: [
    { heading: 'Guest Parking', text: 'Visitors are permitted to park only in the south parking lots (Lot D-1 and D-2).' },
    { heading: 'Special Needs', text: 'Special needs parking lots are available behind Academic Buildings A/B and adjacent to the Student Center.' }] };
const reviewed = { office: 'Public Safety (Non-Emergency)', pages: { maps: 'www.ramapo.edu/publicsafety/parking-maps/' }, lots: [
  { name: 'Lot D-1', aliases: ['D1'], facts: [
    { group: 'Guests', page: 'maps', quote: 'Visitors are permitted to park only in the south parking lots (Lot D-1 and D-2).' },
    { group: 'Faculty and staff', page: 'maps', quote: 'Faculty may park in D-1.' }] },
  { name: 'Student Center lot', aliases: [], near: [{ building: 'building_student-center-sc', page: 'maps', quote: 'adjacent to the Student Center' }],
    facts: [{ group: 'Special needs', page: 'maps', quote: 'Special needs parking lots are available behind Academic Buildings A/B and adjacent to the Student Center.' }] },
  { name: 'Gone lot', aliases: [], facts: [{ group: 'Anyone', page: 'maps', quote: 'Park in the Gone lot.' }] },
] };

test('a parking lot keeps only the facts its page still says, word for word', () => {
  const result = compileParkingLots([safety], [page], reviewed, artifact);
  assert.deepEqual(result.entities.map(e => [e.id, e.kind, e.name]), [[parkingLotId('Lot D-1'), 'parking_lot', 'Lot D-1'], [parkingLotId('Student Center lot'), 'parking_lot', 'Student Center lot']]);
  assert.deepEqual(result.records.rows[0].open_to, ['Guests']);
  assert.deepEqual(result.entities[1].relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]),
    [['listed_by', safety.id], ['near', campusBuildingId(artifact.buildings[0])]]);
  // The fact the page does not say, and the lot with nothing said, are reported, not published.
  assert.deepEqual(result.unresolved.map(u => u.entity), ['Lot D-1', 'Gone lot']);
  assert.equal(result.records.collected_at, '2026-11-02T00:00:00Z');
});
