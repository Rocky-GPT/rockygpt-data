import assert from 'node:assert/strict';
import test from 'node:test';
import seedJson from '../reference/campus-identities.json';
import review from '../reference/program-identity-migration-20260923.json';
import { validateCampusIdentities, type CampusIdentities } from './campus-identities';
import { catalogEvidence, programContinuityEvidence, reconcileProgramIdentities, type ProgramEvidence } from './program-identity-reconciliation';
import { compileCampusIdentities, programArtifactRows } from './compile-campus-identities';
import { programRecordKey } from './program-records';
import { compileRequirementGroups } from './requirement-groups';
import { compileCourseIdentities } from './course-identities';

const previous: ProgramEvidence = { pointer: '/programs/0', sha256: 'fixture', id: 'old', code: 'OLD-BA-HIST', name: 'History BA', programGroupId: 'old-group', status: 'Active', academicLevel: 'UG', changeNote: '', requirementIds: ['block', 'rule'] };
const next = (changes: Partial<ProgramEvidence>): ProgramEvidence => ({ ...previous, id: 'new', code: 'NEW-BA-HIST', programGroupId: 'new-group', ...changes });

test('review requires multiple exact source attributes, not name or school-prefix similarity', () => {
  assert.deepEqual(programContinuityEvidence(previous, next({ requirementIds: [] })), []);
  assert.deepEqual(programContinuityEvidence(previous, next({ name: 'Different program', code: 'NEW-BA-OTHER' })), []);
  assert.deepEqual(programContinuityEvidence(previous, next({ requirementIds: ['block'] })), []);
  assert.deepEqual(programContinuityEvidence(previous, next({ requirementIds: [] , programGroupId: 'old-group' })), ['same_program_group']);
  assert.deepEqual(programContinuityEvidence(previous, next({})), ['retained_requirement_ids']);
});

test('source excerpts carry original pointers, record hashes and nested requirement identifiers', () => {
  const capture = { scrapedAt: '2026-09-23T19:44:12.134Z', programs: [{ code: 'AH-BA-HIST', name: 'History BA', id: 'source-id', programGroupId: 'source-group', status: 'Active', requisites: { requisitesSimple: [{ id: 'block', rules: [{ id: 'rule' }] }] } }] };
  const extracted = catalogEvidence(capture);
  assert.equal(extracted.programs[0].pointer, '/programs/0');
  assert.deepEqual(extracted.programs[0].requirementIds, ['block', 'rule']);
  const changed = catalogEvidence({ ...capture, programs: [{ ...capture.programs[0], status: 'Inactive' }] });
  assert.notEqual(extracted.sha256, changed.sha256);
  assert.notEqual(extracted.programs[0].sha256, changed.programs[0].sha256);
});

test('review rejects competing active successors and competing old identity owners', () => {
  const makeEntity = (id: string) => ({ id, kind: 'program' as const, name: previous.name, aliases: [], links: [{ collection: 'programs' as const, source_key: 'academic-programs', source_record_keys: [], selector: { field: 'catalog_code' as const, values: [previous.code], evidence: 'fixture' } }] });
  const old = { scrapedAt: '2026-07-01', sha256: 'old', programs: [previous] };
  const current = { scrapedAt: '2026-09-01', sha256: 'new', programs: [next({}), next({ code: 'THIRD-BA-HIST' })] };
  assert.equal(reconcileProgramIdentities({ schema_version: 1, entities: [makeEntity('one')] }, old, current)[0].classification, 'ambiguous');
  const owners = reconcileProgramIdentities({ schema_version: 1, entities: [makeEntity('one'), makeEntity('two')] }, old, { ...current, programs: current.programs.slice(0, 1) });
  assert.ok(owners.every(row => row.classification === 'ambiguous' && !row.currentCode));
});

test('committed review reproduces exact decisions and retains all retired UUIDs for reactivation', () => {
  const seed = seedJson as CampusIdentities;
  validateCampusIdentities(seed);
  const oldIds = new Set(review.entries.map(row => row.entityId));
  const originalSeed: CampusIdentities = { schema_version: 1, entities: [...seed.entities.filter(entity => oldIds.has(entity.id)), ...review.retired_entities as CampusIdentities['entities']] };
  const actual = reconcileProgramIdentities(originalSeed, review.previous, review.current);
  const byId = (rows: typeof actual) => [...rows].sort((a, b) => a.entityId.localeCompare(b.entityId));
  assert.deepEqual(byId(actual), byId(review.entries as typeof actual));
  for (const entry of review.entries) {
    const entity = seed.entities.find(entity => entity.id === entry.entityId);
    if (entry.classification === 'inactive') {
      assert.equal(entity, undefined);
      assert.ok(review.retired_entities.some(entity => entity.id === entry.entityId));
      assert.equal(review.current.programs.find(row => row.code === entry.currentCode)?.status, 'Inactive');
    } else {
      assert.ok(entity);
      const values = entity.links.flatMap(link => link.selector?.values || []);
      assert.ok(values.includes(entry.previousCode));
      if (entry.currentCode) assert.ok(values.includes(entry.currentCode));
      else assert.deepEqual(values, [entry.previousCode]);
    }
  }
});

test('catalog source keys keep same-name degree paths and requirements separate', () => {
  const codes = ['AH-BA-PEDS', 'AH-BS-PEDS'];
  const identities: CampusIdentities = { schema_version: 1, entities: codes.map((code, index) => ({
    id: `11111111-1111-4111-8111-00000000000${index}`, kind: 'program', name: 'Special Education 4+1', aliases: [], links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: [], selector: { field: 'catalog_code', values: [code], evidence: 'Independent exact source code' } }],
  })) };
  const programs = { schools: [{ school: 'School', majors: codes.map((catalogCode, index) => ({ name: 'Special Education 4+1', catalogCode, requirements: [{ section: `Distinct requirement ${index}`, note: `Degree path ${index}` }] })) }] };
  const rows = programArtifactRows(programs).map(row => ({ ...row, source_key: 'academic-programs' }));
  const result = compileCampusIdentities(identities, { campus_contacts: [], campus_hours: [], dining_hours: [], menu_items: [], programs: rows, artifacts: { programs } });
  const entities = result.registry.entities.filter(entity => entity.kind === 'program');
  assert.equal(entities.length, 2);
  entities.forEach((entity, index) => assert.deepEqual(entity.links[0].source_record_keys, [`catalog:${codes[index]}`]));
  assert.equal(result.requirementGroups.edges.filter(edge => edge.type === 'requirement_group').length, 2);
  const historical: CampusIdentities = { schema_version: 1, entities: [{ ...identities.entities[0], links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: ['School:Special Education 4+1'] }] }] };
  assert.equal(compileRequirementGroups(programs, historical, compileCourseIdentities({})).edges.filter(edge => edge.type === 'requirement_group').length, 0);
  assert.equal(programRecordKey({ name: ' Legacy  program ', catalogCode: ' AH-BA-HIST ' }, 'School'), 'catalog:AH-BA-HIST');
  assert.equal(programRecordKey({ name: ' Legacy  program ' }, 'School'), 'School:Legacy program');
});
