import assert from 'node:assert/strict';
import test from 'node:test';
import rawSeed from '../reference/campus-identities.json';
import { buildStructuredDirectoryContacts } from '../directory/structured-contacts';
import { validateCampusIdentities, type CampusIdentities } from './campus-identities';

const seed = rawSeed as CampusIdentities;

test('the CSI seed links the published contact key without copying its facts', () => {
  validateCampusIdentities(seed);
  const contact = buildStructuredDirectoryContacts([]).find(record =>
    record.sourceRecordKey === seed.entities[0].links[0].source_record_keys[0]
  );
  assert.ok(contact);
  assert.equal(contact.publicationSourceKey, seed.entities[0].links[0].source_key);
  assert.equal(contact.name, seed.entities[0].name);
  assert.equal(seed.entities[0].links[1].source_record_keys.length, 7);
  assert.equal('phone' in seed.entities[0], false);
  assert.equal('collected_at' in seed, false);
});

test('identity is retained across a reviewed rename and upstream record-key change', () => {
  const renamed = structuredClone(seed);
  const original = renamed.entities[0];
  original.aliases.push(original.name);
  original.name = 'Renamed Student Office';
  original.links[0].source_record_keys = ['office:renamed-student-office'];
  validateCampusIdentities(renamed);
  assert.equal(renamed.entities[0].id, seed.entities[0].id);
});

test('shared aliases are valid data for an ambiguous lookup, not an automatic merge', () => {
  const registry = { schema_version: 1 as const, entities: [structuredClone(seed.entities[0])] };
  registry.entities.push({
    ...structuredClone(seed.entities[0]),
    id: 'b2e836ce-b832-44ca-8a92-42f0fbd1fdb1',
    name: 'Another Office',
    aliases: ['CSI'],
    links: [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:another'] }],
  });
  validateCampusIdentities(registry);
  assert.equal(registry.entities.length, 2);
});

test('one source record cannot assert two different canonical identities', () => {
  const registry = structuredClone(seed);
  registry.entities.push({
    ...structuredClone(seed.entities[0]),
    id: 'b2e836ce-b832-44ca-8a92-42f0fbd1fdb1',
  });
  assert.throws(() => validateCampusIdentities(registry), /exactly one identity link/);
  registry.entities[1].id = registry.entities[0].id;
  assert.throws(() => validateCampusIdentities(registry), /unique, persistent/);
});

test('malformed mappings fail before publication instead of guessing identity', () => {
  const entity = (changes: Record<string, unknown>) => ({
    ...seed, entities: [{ ...seed.entities[0], ...changes }],
  });
  const link = (changes: Record<string, unknown>) => entity({
    links: [{ ...seed.entities[0].links[0], ...changes }],
  });
  for (const registry of [
    { ...seed, schema_version: 2 },
    entity({ id: 'center-for-student-involvement' }),
    entity({ aliases: [' '] }),
    link({ collection: 'documents' }),
    link({ source_record_keys: [], selector: undefined }),
    link({ source_key: '' }),
    link({ source_record_keys: ['office:duplicate', 'office:duplicate'] }),
    entity({ verified_at: '2026-09-21' }),
  ]) {
    assert.throws(() => validateCampusIdentities(registry));
  }
});

test('a listed_faculty relationship targets an identity, never a record', () => {
  const registry = structuredClone(seed);
  const [first] = registry.entities;
  const evidence = [{ collection: 'programs' as const, source_key: 'academic-programs', source_record_key: 'School:Program', field: 'customFields.xiQxl' }];
  first.relationships = [{ type: 'listed_faculty', target_entity_id: first.id, evidence }];
  validateCampusIdentities(registry);
  (first.relationships[0] as Record<string, unknown>).target_record = { collection: 'faculty', source_key: 'faculty', source_record_key: 'x' };
  assert.throws(() => validateCampusIdentities(registry), /Invalid identity target/);
});
