import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { subjectIdentityId } from './course-subjects';
import { linkProgramDepartments } from './program-departments';

const subject = (code: string, name: string): CampusIdentity => ({ id: subjectIdentityId(code), kind: 'subject', name: `${name} (${code})`, aliases: [code],
  links: [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: [code] }] });
const program = (id: string, key: string): CampusIdentity => ({ id, kind: 'program', name: key, aliases: [],
  links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: [key] }] });
const MUSIC = '00000000-0000-4000-8000-000000000001';
const DATA = '00000000-0000-4000-8000-000000000002';
const NONE = '00000000-0000-4000-8000-000000000003';

test('a program is part of the department its catalog Convening Group names, by exact subject name', () => {
  const entities = [subject('MUSI', 'Music'), subject('CMPS', 'Computer Science'), program(MUSIC, 'catalog:AH-MN-MUSI'), program(DATA, 'catalog:SN-BS-DSCI'), program(NONE, 'catalog:SB-BA-UNDC')];
  const rows = [
    { source_key: 'academic-programs', source_record_key: 'catalog:AH-MN-MUSI', conveningGroups: ['Music (MUSI)'], catalogUrl: 'https://catalog.ramapo.edu/programs/AH-MN-MUSI' },
    // A department no course subject is named like is reported, not matched to a similar subject.
    { source_key: 'academic-programs', source_record_key: 'catalog:SN-BS-DSCI', conveningGroups: ['Data Science (DSCI)'] },
    { source_key: 'academic-programs', source_record_key: 'catalog:SB-BA-UNDC' },
  ];
  const { linked, unresolved } = linkProgramDepartments(entities, rows);
  assert.equal(linked, 1);
  assert.deepEqual(entities.find(e => e.id === MUSIC)?.relationships, [{ type: 'part_of', target_entity_id: subjectIdentityId('MUSI'),
    evidence: [{ collection: 'programs', source_key: 'academic-programs', source_record_key: 'catalog:AH-MN-MUSI', field: 'conveningGroups', source_url: 'https://catalog.ramapo.edu/programs/AH-MN-MUSI' }] }]);
  assert.equal(entities.find(e => e.id === DATA)?.relationships, undefined);
  assert.deepEqual(unresolved.map(u => u.record), ['catalog:SN-BS-DSCI']);
  assert.match(unresolved[0].reason, /"Data Science \(DSCI\)" is not a course subject/);
  // Running again adds nothing twice.
  assert.equal(linkProgramDepartments(entities, rows).linked, 0);
});
