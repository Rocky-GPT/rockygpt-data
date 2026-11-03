import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { applyBuildingNicknames } from './building-nicknames';
import { campusBuildingId, campusBuildingsArtifact, compileBuildingIdentities } from './campus-buildings';
import { aliasRecords, type AliasLedger } from './identity-aliases';

const pin = (id: string) => `https://map.ramapo.edu/?id=2292#!m/${id}?sbc/`;
const building = (key: string, name: string, id: string, aliases: string[]) => ({
  key, name, category: 'Buildings', aliases: [name.toLowerCase(), ...aliases], roomPrefixes: [], mapUrl: pin(id),
});
const map = {
  buildings: [
    building('building_bradley', 'Bill Bradley Sports and Recreation Center', '1133348', ['bradley center', 'fitness center', 'gym']),
    building('building_d', 'Academic Building D', '1133371', ['d building', 'd wing', 'D-Wing']),
    building('building_a', 'Academic Building A', '1133340', ['a building', 'a wing']),
    building('building_h', 'Academic Building H', '1133374', ['h wing']),
    building('building_ln', 'Laurel Hall North Building', '1133458', ['laurel hall']),
    building('building_ls', 'Laurel Hall South Building', '1133458', ['laurel hall']),
    building('building_lc', 'Peter P. Mercer Learning Commons', '1133420', ['library']),
    building('building_lodge', 'The Lodge (CPA)', '1133470', []),
  ],
  offices: [
    { key: 'office_aux', name: 'Auxiliary Gym', buildingKey: 'building_bradley' },
    { key: 'office_sharp', name: 'Sharp Fitness Center', buildingKey: 'building_bradley' },
    { key: 'office_lodge_fitness', name: 'Lodge Fitness Center', buildingKey: 'building_lodge' },
    { key: 'office_h_aud', name: 'H-Wing Auditorium', buildingKey: 'building_h' },
  ],
};
const office = (id: string, name: string, aliases: string[] = []): CampusIdentity =>
  ({ id, kind: 'office', name, aliases, links: [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: [`office:${id}`] }] });

function compile() {
  const artifact = campusBuildingsArtifact(map);
  const offices = [office('library', 'Library', ['Potter Library']), office('lounge', 'Bradley Center (Student & Recreation Lounge)')];
  const entities = [...offices, ...compileBuildingIdentities(artifact, offices, new Map()).buildings];
  const ledger: AliasLedger = new Map();
  const result = applyBuildingNicknames(entities, artifact, map, ledger);
  const aliases = (name: string) => entities.find(entity => entity.name === name)?.aliases;
  return { artifact, entities, ledger, result, aliases };
}

test('a building keeps the map search names it lists, each once and apart from its own name', () => {
  const { artifact } = compile();
  const d = artifact.buildings.find(b => b.name === 'Academic Building D');
  assert.deepEqual(d?.search_names, ['d building', 'd wing']);
  assert.equal(artifact.buildings.find(b => b.name === 'The Lodge (CPA)')?.search_names, undefined);
});

test('the map search names become building nicknames, each citing the building record', () => {
  const { artifact, entities, ledger, result, aliases } = compile();
  assert.deepEqual(aliases('Bill Bradley Sports and Recreation Center'), ['gym']);
  assert.deepEqual(aliases('Academic Building D'), ['d building', 'd wing']);
  // Places in the building may share it: the H-Wing Auditorium is in Academic Building H.
  assert.deepEqual(aliases('Academic Building H'), ['h wing']);
  assert.equal(result.applied, 4);
  const d = artifact.buildings.find(b => b.name === 'Academic Building D')!;
  const records = aliasRecords(entities.filter(entity => entity.kind === 'building'), ledger);
  assert.deepEqual(records.find(record => record.alias === 'd wing'), {
    entity_id: campusBuildingId(d), entity: 'Academic Building D', kind: 'building', alias: 'd wing',
    sources: [{ basis: 'map_search_name', evidence: { collection: 'buildings', source_key: 'campus-map',
      source_record_key: d.record_key, field: 'search_names', source_url: pin('1133371') } }],
  });
});

test('a search name that would name something else is skipped and reported', () => {
  const { result, aliases } = compile();
  for (const name of ['Academic Building A', 'Laurel Hall North Building', 'Laurel Hall South Building', 'Peter P. Mercer Learning Commons']) {
    assert.deepEqual(aliases(name), [], name);
  }
  assert.deepEqual(result.unresolved.map(issue => [issue.entity, issue.reason, issue.kind]), [
    ['Academic Building A', 'The campus map\'s search name "a building" starts with "a" or "an" and reads as plain English; it is not a nickname of this building.', 'note'],
    ['Academic Building A', 'The campus map\'s search name "a wing" starts with "a" or "an" and reads as plain English; it is not a nickname of this building.', 'note'],
    ['Bill Bradley Sports and Recreation Center', 'The campus map\'s search name "bradley center" is already the name of office "Bradley Center (Student & Recreation Lounge)"; it is not a nickname of this building.', 'note'],
    ['Bill Bradley Sports and Recreation Center', 'The campus map\'s search name "fitness center" is part of the name of map place "Lodge Fitness Center", which is not in this building; it is not a nickname of this building.', 'note'],
    ['Peter P. Mercer Learning Commons', 'The campus map\'s search name "library" is already the name of office "Library"; it is not a nickname of this building.', 'note'],
    ['Laurel Hall North Building', 'The campus map\'s search name "laurel hall" is listed for more than one building; it is not a nickname of this building.', 'note'],
    ['Laurel Hall South Building', 'The campus map\'s search name "laurel hall" is listed for more than one building; it is not a nickname of this building.', 'note'],
  ]);
});
