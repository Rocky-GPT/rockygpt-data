import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { compileStops, linkTopicOffices, stopIdentityId } from './graph-links';
import { aliasRecords, type AliasLedger } from './identity-aliases';

const node = (n: number, kind: CampusIdentity['kind'], name: string, links: CampusIdentity['links'] = []): CampusIdentity =>
  ({ id: `00000000-0000-4000-8000-00000000030${n}`, kind, name, aliases: [], links });

test('a topic is handled_by each office its row names exactly', () => {
  const aid = node(1, 'office', 'Financial Aid');
  const accounts = node(2, 'office', 'Student Accounts');
  const topic = node(3, 'topic', 'Scholarships', [{ collection: 'campus_topics', source_key: 'office-pages', source_record_keys: ['Scholarships'] }]);
  linkTopicOffices([aid, accounts, topic], [{ source_key: 'office-pages', source_record_key: 'Scholarships', url: 'https://www.ramapo.edu/scholarships/faqs/', handled_by: ['Student Accounts', 'Financial Aid', 'Nobody'] }]);
  assert.deepEqual(topic.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]), [['handled_by', accounts.id], ['handled_by', aid.id]]);
});

test('routes stop at shared stop nodes, and a campus stop is in the building it names', () => {
  const map = { buildings: [{ key: 'building_bradley', name: 'Bill Bradley Sports and Recreation Center', aliases: ['bradley center', 'gym'], mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1133348?sbc/', roomPrefixes: ['BR'] }] };
  const artifact = campusBuildingsArtifact(map);
  const bradley = node(9, 'building', 'Bill Bradley Sports and Recreation Center');
  bradley.id = campusBuildingId(artifact.buildings[0]);
  const route = (n: number, name: string) => node(n, 'route', name, [{ collection: 'shuttle_stops', source_key: 'transportation', source_record_keys: [`${name}:stop:Ramapo College (Bradley Center)`, `${name}:stop:Garden State Plaza`] }]);
  const sunday = route(1, 'Sunday'); const saturday = route(2, 'Saturday');
  const rows = ['Sunday', 'Saturday'].flatMap(r => [
    { source_key: 'transportation', source_record_key: `${r}:stop:Ramapo College (Bradley Center)`, name: 'Ramapo College (Bradley Center)', label: 'Ramapo College' },
    { source_key: 'transportation', source_record_key: `${r}:stop:Garden State Plaza`, name: 'Garden State Plaza', pickup: 'the Bus Shelters' }]);
  const result = compileStops([bradley, sunday, saturday], rows, artifact, map);
  assert.deepEqual(result.entities.map(e => [e.id, e.kind, e.name]), [
    [stopIdentityId('Ramapo College (Bradley Center)'), 'stop', 'Ramapo College (Bradley Center)'], [stopIdentityId('Garden State Plaza'), 'stop', 'Garden State Plaza']]);
  for (const r of [sunday, saturday]) assert.deepEqual(r.relationships?.map(x => x.type), ['stops_at', 'stops_at']);
  assert.deepEqual(result.entities[0].relationships?.map(r => 'target_entity_id' in r ? r.target_entity_id : null), [bradley.id]);
  assert.equal(result.entities[1].relationships, undefined);
  assert.deepEqual(result.records.rows.map(r => [r.source_record_key, r.pickup]), [['Ramapo College (Bradley Center)', null], ['Garden State Plaza', 'the Bus Shelters']]);
});

test('a stop label is an alias with its source noted, so the alias report can trace it', () => {
  const route = node(1, 'route', 'Sunday', [{ collection: 'shuttle_stops', source_key: 'transportation', source_record_keys: ['Sunday:stop:City MD Ramsey'] }]);
  const ledger: AliasLedger = new Map();
  const result = compileStops([route], [{ source_key: 'transportation', source_record_key: 'Sunday:stop:City MD Ramsey', name: 'City MD Ramsey', label: 'CityMD Ramsey Urgent Care' }],
    campusBuildingsArtifact({ buildings: [] }), { buildings: [] }, '', ledger);
  assert.deepEqual(result.entities[0].aliases, ['CityMD Ramsey Urgent Care']);
  assert.deepEqual(aliasRecords(result.entities, ledger)[0].sources, [{ basis: 'record_name', evidence: { collection: 'shuttle_stops', source_key: 'transportation',
    source_record_key: 'Sunday:stop:City MD Ramsey', field: 'label', source_url: 'https://www.ramapo.edu/about/transportation-services/ramapo-roadrunner-express-shuttle/' } }]);
});
