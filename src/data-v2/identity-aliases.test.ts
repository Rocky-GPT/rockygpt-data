import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { validateCampusIdentities } from './campus-identities';
import { aliasRecords, applyPublishedAliases, applyReviewedAliases, noteAlias, programFamily, type AliasLedger } from './identity-aliases';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const contact = (key: string, source = 'campus-directory') => [{ collection: 'contacts' as const, source_key: source, source_record_keys: [key] }];

test('a program family is the catalog name without its degree designation', () => {
  assert.equal(programFamily('Computer Science BS'), 'Computer Science');
  assert.equal(programFamily('Computer Science 4+1'), 'Computer Science');
  assert.equal(programFamily('Computer Science Minor'), 'Computer Science');
  assert.equal(programFamily('Data Analyst-Graduate Certificate'), 'Data Analyst');
  assert.equal(programFamily('Social Work BSW'), 'Social Work');
  for (const name of ['Nursing RN to BSN', 'Elementary Education BS (TA to Teacher)', 'SB-BA-Matric Undeclared', 'Prov-MASE', 'BS']) {
    assert.equal(programFamily(name), null, name);
  }
});

test('aliases come only from the identity own name and records, and shared aliases stay shared', () => {
  const entities: CampusIdentity[] = [
    { id: id(1), kind: 'office', name: 'Library', aliases: [], links: contact('office:library') },
    { id: id(2), kind: 'office', name: 'Public Safety (Emergency)', aliases: [], links: contact('office:ps-emergency') },
    { id: id(3), kind: 'office', name: 'Public Safety (Non-Emergency)', aliases: [], links: contact('office:ps-non-emergency') },
    { id: id(4), kind: 'person', name: 'Jo Doe', aliases: [], links: contact('other:jo') },
    { id: id(5), kind: 'building', name: 'Student Center (SC)', aliases: [], links: [{ collection: 'buildings', source_key: 'campus-map', source_record_keys: ['1'] }] },
    { id: id(6), kind: 'program', name: 'Computer Science BS', aliases: ['CS BS'], links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: ['p'] }] },
    { id: id(7), kind: 'person', name: 'Retired Professor', aliases: [], links: contact('faculty:retired', 'faculty') },
  ];
  const rows = new Map<string, Record<string, unknown>>([
    ['contacts:campus-directory:office:library', { department: 'Potter Library' }],
    ['contacts:campus-directory:office:ps-emergency', { department: 'Public Safety' }],
    ['contacts:campus-directory:office:ps-non-emergency', { department: 'Public Safety' }],
    ['contacts:campus-directory:other:jo', { department: 'Office of the President' }],
    ['contacts:faculty:faculty:retired', { status: 'retired', department: 'School of Social Sciences and Social Work' }],
  ]);
  const ledger: AliasLedger = new Map();
  noteAlias(ledger, id(6), 'CS BS', { basis: 'identity_map' });
  applyPublishedAliases(entities, rows, ledger);
  assert.deepEqual(entities.map(e => e.aliases), [
    ['Potter Library'], ['Public Safety'], ['Public Safety'],
    [], // A person's department never names the person.
    ['SC', 'Student Center'], ['CS BS', 'Computer Science'], [],
  ]);
  // Each alias records the rule that found it, and a department its directory entry.
  assert.deepEqual(aliasRecords(entities, ledger).map(r => [r.entity, r.alias, r.sources]), [
    ['Library', 'Potter Library', [{ basis: 'department', evidence: { collection: 'contacts', source_key: 'campus-directory', source_record_key: 'office:library', field: 'department' } }]],
    ['Public Safety (Emergency)', 'Public Safety', [{ basis: 'department', evidence: { collection: 'contacts', source_key: 'campus-directory', source_record_key: 'office:ps-emergency', field: 'department' } }]],
    ['Public Safety (Non-Emergency)', 'Public Safety', [{ basis: 'department', evidence: { collection: 'contacts', source_key: 'campus-directory', source_record_key: 'office:ps-non-emergency', field: 'department' } }]],
    ['Student Center (SC)', 'SC', [{ basis: 'abbreviation' }]],
    ['Student Center (SC)', 'Student Center', [{ basis: 'abbreviation' }]],
    ['Computer Science BS', 'CS BS', [{ basis: 'identity_map' }]],
    ['Computer Science BS', 'Computer Science', [{ basis: 'program_family' }]],
  ]);
  assert.deepEqual(entities[6].status, { state: 'retired', evidence: [{ collection: 'contacts', source_key: 'faculty', source_record_key: 'faculty:retired', field: 'status' }] });
  assert.equal(entities[3].status, undefined);
  validateCampusIdentities({ schema_version: 1, entities });
  const invalid = structuredClone(entities);
  (invalid[6].status as unknown as { state: string }).state = 'emeritus';
  assert.throws(() => validateCampusIdentities({ schema_version: 1, entities: invalid }), /Unsupported identity status/);
});

test('a human-reviewed alias is applied by persistent ID and recorded as human-reviewed', () => {
  const venue: CampusIdentity = { id: id(8), kind: 'venue', name: 'Birch Tree Inn', aliases: [], links: contact('office:birch-tree-inn') };
  const review = { entity_id: id(8), entity: 'Birch Tree Inn', alias: 'Birch', reviewed_at: '2026-09-23', note: 'Approved.' };
  const ledger: AliasLedger = new Map();
  const { applied, unresolved } = applyReviewedAliases([venue], [review, { ...review, entity_id: id(9) }], ledger);
  assert.deepEqual(venue.aliases, ['Birch']);
  assert.deepEqual(applied, [{ entity_id: id(8), entity: 'Birch Tree Inn', alias: 'Birch', basis: 'human_reviewed', reviewed_at: '2026-09-23' }]);
  assert.equal(unresolved.length, 1);
  assert.deepEqual(aliasRecords([venue], ledger), [{ entity_id: id(8), entity: 'Birch Tree Inn', kind: 'venue', alias: 'Birch', sources: [{ basis: 'human_reviewed', reviewed_at: '2026-09-23', note: 'Approved.' }] }]);
  // A renamed identity is not silently given the reviewed alias.
  assert.equal(applyReviewedAliases([{ ...venue, aliases: [], name: 'Renamed' }], [review]).applied.length, 0);
});

test('an alias no rule noted is a compiler error, and a repeated source is kept once', () => {
  const venue: CampusIdentity = { id: id(8), kind: 'venue', name: 'Birch Tree Inn', aliases: ['Birch'], links: contact('office:birch-tree-inn') };
  const ledger: AliasLedger = new Map();
  assert.throws(() => aliasRecords([venue], ledger), /"Birch" of venue "Birch Tree Inn" has no recorded source/);
  noteAlias(ledger, id(8), 'Birch', { basis: 'human_reviewed', reviewed_at: '2026-09-23', note: 'Approved.' });
  noteAlias(ledger, id(8), 'Birch', { basis: 'human_reviewed', reviewed_at: '2026-09-23', note: 'Approved.' });
  assert.equal(aliasRecords([venue], ledger)[0].sources.length, 1);
});
