import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentities, CampusIdentity, CampusIdentityRelationship } from './campus-identities';
import { reviewConvenerReplacements } from './convener-continuity';
import { compareIdentityRegistries } from './identity-continuity';

const profile = (name: string) => `https://www.ramapo.edu/test/faculty/${name}/`;
const html = (name: string, label = name) => `<p>Convener: <a href="${profile(name)}">${label}</a></p>`;
const code = 'TEST-BA';
const catalogUrl = `https://catalog.ramapo.edu/programs/${code}`;
function person(id: string, name: string, sourceProfile = profile(id)): CampusIdentity {
  return { id, name, kind: 'person', aliases: [], links: [
    { collection: 'faculty', source_key: 'faculty', source_record_keys: [sourceProfile] },
  ] };
}
function program(targets: string[], key = `catalog:${code}`): CampusIdentity {
  return { id: 'program', name: 'Test BA', kind: 'program', aliases: [], links: [
    { collection: 'programs', source_key: 'academic-programs', source_record_keys: [key] },
  ], relationships: targets.map(target => ({ type: 'convener', target_entity_id: target, evidence: [
    { collection: 'programs', source_key: 'academic-programs', source_record_key: key,
      field: 'customFields.rJQmj', source_url: catalogUrl },
  ] })) };
}
const registry = (program: CampusIdentity, extra: CampusIdentity[] = []): CampusIdentities => ({
  schema_version: 1, entities: [person('alice', 'Alice Smith'), person('bob', 'Bob Jones'), program, ...extra],
});
const capture = (raw: string) => ({ collected_at: '2026-09-23T19:44:12.134Z',
  source_url: 'https://catalog.ramapo.edu/api/programs',
  programs: [{ catalogCode: code, catalogUrl, customFields: { rJQmj: raw } }],
});
const before = () => registry(program(['alice'], 'Test:Test BA'));
const after = () => registry(program(['bob']));
const previous = () => capture(html('alice', 'Alice Smith'));
const current = () => capture(html('bob', 'Bob Jones'));

test('exact source-backed replacement preserves old and new proof across a catalog-key migration', () => {
  const result = reviewConvenerReplacements(before(), after(), previous(), current());
  assert.deepEqual(result.rejected, []);
  assert.equal(result.replacements.length, 1);
  const proof = result.replacements[0];
  assert.equal(proof.relationship_key, JSON.stringify(['program', 'convener', 'entity', 'alice']));
  assert.equal(proof.program_id, 'program');
  assert.equal(proof.previous_target_id, 'alice');
  assert.equal(proof.previous.raw_field, html('alice', 'Alice Smith'));
  assert.equal(proof.previous.source_record_key, 'Test:Test BA');
  assert.equal(proof.replacements[0].evidence.source_record_key, `catalog:${code}`);
  assert.equal(proof.replacements[0].evidence.raw_field, html('bob', 'Bob Jones'));
  assert.equal(proof.replacements[0].evidence.collected_at, current().collected_at);
  assert.equal(proof.replacements[0].target.entity_id, 'bob');
  assert.equal(proof.replacements[0].target.source_profile_url, profile('bob').replace(/\/$/, ''));
  const report = compareIdentityRegistries(before(), after(), after(), new Set(), { convenerReplacements: result });
  assert.deepEqual(report.expected_relationship_losses_by_type, { convener: 1 });
  assert.deepEqual(report.lost_relationships_by_type, {});
  assert.deepEqual(report.convener_replacement_evidence, result);
});

test('missing, empty, malformed, duplicate and undated source captures cannot explain a lost edge', () => {
  const valid = current();
  const cases: unknown[] = [undefined, {}, capture(''), capture('Convener: Bob Jones'),
    { ...valid, collected_at: 'unknown' },
    { ...valid, programs: [valid.programs[0], valid.programs[0]] },
    { ...valid, programs: [{ ...valid.programs[0], catalogCode: 'OTHER-BA' }] },
    { ...valid, programs: [{ ...valid.programs[0], customFields: { xiQxl: html('bob') } }] },
  ];
  for (const raw of cases) {
    const result = reviewConvenerReplacements(before(), after(), previous(), raw);
    assert.equal(result.replacements.length, 0);
    assert.equal(result.rejected.length, 1);
  }
});

test('source names or links retaining the old convener block an extraction-loss exemption', () => {
  for (const raw of [html('bob') + html('alice'), html('bob') + '<p>Alice Smith, Co-Convener</p>',
    html('bob') + '<p>Professor Alice Smith</p>']) {
    const result = reviewConvenerReplacements(before(), after(), previous(), capture(raw));
    assert.equal(result.replacements.length, 0);
    assert.match(result.rejected[0].reason, /still names or links/);
  }
});

test('an unresolved source replacement or a relation to a different person remains a lost edge', () => {
  for (const candidate of [registry(program([])), after()]) {
    const result = reviewConvenerReplacements(before(), candidate, previous(), capture(html('charlie', 'Charlie Brown')));
    assert.equal(result.replacements.length, 0);
    assert.equal(result.rejected.length, 1);
    const report = compareIdentityRegistries(before(), candidate, candidate, new Set(), { convenerReplacements: result });
    assert.deepEqual(report.expected_relationship_losses_by_type, {});
    assert.deepEqual(report.lost_relationships_by_type, { convener: 1 });
  }
});

test('ambiguous faculty URLs and ungrounded previous relations fail closed', () => {
  const ambiguous = registry(program(['bob']), [person('other', 'Other Person', profile('bob'))]);
  const unresolved = reviewConvenerReplacements(before(), ambiguous, previous(), current());
  assert.equal(unresolved.replacements.length, 0);
  assert.match(unresolved.rejected[0].reason, /no uniquely verified/);
  const badOld = reviewConvenerReplacements(before(), after(), capture(html('charlie')), current());
  assert.equal(badOld.replacements.length, 0);
  assert.match(badOld.rejected[0].reason, /Previous relationship/);
});

test('a current relation needs exact program ownership, catalog URL and explicit Convener field', () => {
  for (const changes of [
    { field: 'customFields.xiQxl' }, { source_record_key: 'catalog:OTHER-BA' },
    { source_url: 'https://catalog.ramapo.edu/programs/OTHER-BA' },
    { source_url: 'https://example.com/programs/TEST-BA' },
  ]) {
    const next = after();
    Object.assign(next.entities[2].relationships![0].evidence[0], changes);
    assert.equal(reviewConvenerReplacements(before(), next, previous(), current()).replacements.length, 0);
  }
});

test('the exemption cannot migrate between stable programs or cover an unchanged relation', () => {
  const different = after(); different.entities[2].id = 'another-program';
  assert.deepEqual(reviewConvenerReplacements(before(), different, previous(), current()), { replacements: [], rejected: [] });
  const retained = registry(program(['alice', 'bob']));
  assert.deepEqual(reviewConvenerReplacements(before(), retained, previous(), capture(html('alice') + html('bob'))),
    { replacements: [], rejected: [] });
});

test('every current convener relation must cite a complete current field; unrelated relationships are irrelevant', () => {
  const next = after();
  const unrelated: CampusIdentityRelationship = { type: 'listed_faculty', target_entity_id: 'alice', evidence: [] };
  next.entities[2].relationships!.push(unrelated);
  assert.equal(reviewConvenerReplacements(before(), next, previous(), current()).replacements.length, 1);
  next.entities[2].relationships!.push({ type: 'convener', target_entity_id: 'other', evidence: [] });
  assert.equal(reviewConvenerReplacements(before(), next, previous(), current()).replacements.length, 0);
});

test('two previous conveners can be explicitly replaced by one with a separate proof for each lost edge', () => {
  const old = registry(program(['alice', 'charlie']), [person('charlie', 'Charlie Brown')]);
  const next = registry(program(['bob']), [person('charlie', 'Charlie Brown')]);
  const result = reviewConvenerReplacements(old, next, capture(html('alice') + html('charlie')), current());
  assert.deepEqual(result.replacements.map(proof => proof.previous_target_id), ['alice', 'charlie']);
  assert.equal(result.rejected.length, 0);
});
