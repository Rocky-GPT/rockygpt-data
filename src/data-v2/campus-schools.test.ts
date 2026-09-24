import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import schoolsReference from '../reference/campus-schools.json';
import { campusSchoolsArtifact, compileSchoolIdentities } from './campus-schools';
import { aliasRecords, type AliasLedger } from './identity-aliases';

const reference = {
  source_url: 'https://www.ramapo.edu/academics/schools/', captured_at: '2026-09-23T12:31:43Z',
  schools: [
    { id: '00000000-0000-4000-8000-00000000000a', section: 'snh', name: 'School of Science, Nursing, and Health', abbreviation: 'SNH', url: 'https://www.ramapo.edu/snh/',
      legacy_names: [{ name: 'School of Theoretical and Applied Science', evidence: '/tas/ redirects to /snh/' }], archway_groups: [] },
    { id: '00000000-0000-4000-8000-00000000000b', section: 'sssw', name: 'School of Social Sciences and Social Work', abbreviation: 'SSSW', url: 'https://www.ramapo.edu/sssw/',
      legacy_names: [{ name: 'School of Social Science and Human Services', evidence: '/sshs/ redirects to /sssw/' }], archway_groups: [] },
    { id: '00000000-0000-4000-8000-00000000000c', section: 'ahe', name: 'School of Arts, Humanities, and Education', abbreviation: 'AHE', url: 'https://www.ramapo.edu/ahe/',
      legacy_names: [{ name: 'School of Contemporary Arts', evidence: '/ca/ redirects to /ahe/' }, { name: 'School of Social Science and Human Services', evidence: 'AHE lists its education programs' }],
      archway_groups: ['School of Contemporary Arts', 'Missing Group'] },
  ],
};
const program = (id: string, key: string): CampusIdentity => ({ id, kind: 'program', name: key, aliases: [], links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: [key] }] });
const person = (id: string, key: string): CampusIdentity => ({ id, kind: 'person', name: key, aliases: [], links: [{ collection: 'faculty', source_key: 'faculty', source_record_keys: [key] }] });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the official schools page defines the schools; its capture is the artifact', () => {
  const artifact = campusSchoolsArtifact(reference);
  assert.deepEqual(artifact.schools.map(s => [s.section, s.name, s.abbreviation]), [
    ['snh', 'School of Science, Nursing, and Health', 'SNH'], ['sssw', 'School of Social Sciences and Social Work', 'SSSW'], ['ahe', 'School of Arts, Humanities, and Education', 'AHE'],
  ]);
  assert.deepEqual(artifact.source, { source_key: 'ramapo-schools', title: 'Ramapo Schools', canonical_url: 'https://www.ramapo.edu/academics/schools/', trust_tier: 'official_primary', freshness_sla_hours: 4320, domain: 'schools' });
  assert.equal(artifact.captured_at, reference.captured_at);
  // The committed review lists Ramapo's four current schools; without it there are none.
  assert.equal(campusSchoolsArtifact(schoolsReference).schools.length, 4);
  assert.deepEqual(campusSchoolsArtifact().schools, []);
});

test('programs follow reviewed legacy names with one successor; people follow their current school', () => {
  const entities = [
    program(id(1), 'TAS:Computer Science BS'), program(id(2), 'SSHS:Elementary Education BS'), program(id(3), 'Interdisciplinary:Law and Society'),
    person(id(4), 'ada'), person(id(5), 'retired'), person(id(6), 'librarian'),
    { id: id(7), kind: 'office' as const, name: 'School of Contemporary Arts Office', aliases: ['School of Science, Nursing, and Health'], links: [{ collection: 'contacts' as const, source_key: 'campus-directory', source_record_keys: ['office:x'] }] },
  ];
  const rows = new Map<string, Record<string, unknown>>([
    ['programs:academic-programs:TAS:Computer Science BS', { school: 'School of Theoretical and Applied Science' }],
    ['programs:academic-programs:SSHS:Elementary Education BS', { school: 'School of Social Science and Human Services' }],
    ['programs:academic-programs:Interdisciplinary:Law and Society', { school: 'Interdisciplinary' }],
    ['faculty:faculty:ada', { school: 'School of Science, Nursing, and Health (Adjunct)' }],
    ['faculty:faculty:retired', { school: 'School of Social Sciences and Social Work (Retired)' }],
    ['faculty:faculty:librarian', { school: 'Library Faculty & Staff' }],
  ]);
  const clubs = [{ source_key: 'archway-clubs', source_record_key: 'School of Contemporary Arts', id: '31877c21-cbb6-417d-9f9f-f6a7852d3121' }];
  const ledger: AliasLedger = new Map();
  const { schools, unresolved, ownedClubs } = compileSchoolIdentities(entities, rows, clubs, reference, ledger);
  const [snh, sssw, ahe] = schools;
  assert.deepEqual(snh.aliases, ['SNH', 'School of Theoretical and Applied Science']);
  assert.deepEqual(aliasRecords([snh], ledger).map(record => [record.alias, record.sources]), [
    ['SNH', [{ basis: 'school_abbreviation', source_url: 'https://www.ramapo.edu/snh/' }]],
    ['School of Theoretical and Applied Science', [{ basis: 'school_former_name', note: '/tas/ redirects to /snh/' }]],
  ]);
  // A split former school is a legacy name of both successors, so its lookup asks.
  assert.ok(sssw.aliases.includes('School of Social Science and Human Services') && ahe.aliases.includes('School of Social Science and Human Services'));
  assert.deepEqual(ahe.links[1], { collection: 'clubs', source_key: 'archway-clubs', source_record_keys: ['School of Contemporary Arts'], source_record_ids: ['31877c21-cbb6-417d-9f9f-f6a7852d3121'] });
  assert.deepEqual([...ownedClubs], ['School of Contemporary Arts']);
  assert.deepEqual(entities[0].relationships, [{ type: 'part_of', target_entity_id: snh.id, evidence: [
    { collection: 'programs', source_key: 'academic-programs', source_record_key: 'TAS:Computer Science BS', field: 'school' },
  ] }]);
  assert.deepEqual(entities[3].relationships, [{ type: 'part_of', target_entity_id: snh.id, evidence: [
    { collection: 'faculty', source_key: 'faculty', source_record_key: 'ada', field: 'school' },
  ] }]);
  for (const index of [1, 2, 4, 5]) assert.equal(entities[index].relationships, undefined);
  const reasons = unresolved.map(u => `${u.entity}: ${u.reason}`);
  assert.ok(reasons.some(r => r.startsWith('SSHS:Elementary Education BS') && r.includes('was split')));
  assert.ok(reasons.some(r => r.startsWith('retired') && r.includes('retired')));
  assert.ok(reasons.some(r => r.startsWith('librarian') && r.includes('Library Faculty & Staff')));
  assert.ok(reasons.some(r => r.includes('Missing Group has 0 records')));
  assert.ok(reasons.some(r => r.startsWith('School of Science, Nursing, and Health') && r.includes('office "School of Contemporary Arts Office"')));
  const kind = (text: string) => unresolved.find(u => u.reason.includes(text))?.kind;
  assert.deepEqual(['was split', 'retired;', 'Library Faculty & Staff', 'Missing Group has 0 records', 'a name lookup asks'].map(kind),
    ['missing_connection', 'missing_connection', 'missing_connection', 'no_records', 'note']);
});
