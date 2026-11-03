import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCampusIdentities, type CampusIdentity } from './campus-identities';
import { subjectIdentityId } from './course-subjects';
import { linkSubjectDepartments } from './subject-departments';

/** A subject node as course-subjects.ts makes it: "Language (LANG)" for a listed department, the bare code otherwise. */
const subject = (code: string, name?: string): CampusIdentity => ({ id: subjectIdentityId(code), kind: 'subject', name: name ? `${name} (${code})` : code,
  aliases: name ? [code] : [], links: [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: [code] }] });
const LANG = 'Language (LANG)';
const THFL = 'Theater and Film (THFL)';

test('a subject named by its code is part of the department that convenes all of its courses', () => {
  const entities = [subject('LANG', 'Language'), subject('THFL', 'Theater and Film'), subject('PATH', 'Pathways'), subject('FREN', 'French'), subject('GEOL', 'Geology'),
    subject('KORE', 'Korean'), ...['ARAB', 'THEA', 'PATHCA', 'SRSH', 'ENGL'].map(code => subject(code))];
  const courses = {
    'ARAB 102': { conveningGroups: [LANG] }, 'ARAB 101': { conveningGroups: [LANG] }, 'ARAB 200': { conveningGroups: [] },
    // Its own department's courses keep a department where it is: never part of itself.
    'LANG 101': { conveningGroups: [LANG] },
    'THEA 101': { conveningGroups: [THFL] }, 'THEA 102': { conveningGroups: [THFL] },
    // A subject that is a catalog department of its own is never placed in a second one.
    'FREN 101': { conveningGroups: ['French (FREN)'] }, 'FREN 102': { conveningGroups: [LANG] },
    'GEOL 101': { conveningGroups: ['Geology (GEOL)'] }, 'GEOL 102': { conveningGroups: ['Environmental Science (ENSC)'] },
    'KORE 101': { conveningGroups: [LANG] },
    // Courses split between two groups, or a group no subject is named like, place nothing.
    'PATHCA 101': { conveningGroups: ['Pathways (PATH)'] }, 'PATHCA 102': { conveningGroups: ['Contemporary Arts (CNTP)'] },
    'SRSH 101': { conveningGroups: ['Interdisciplinary Studies (SCIN)'] },
    // A course with no group says nothing.
    'ENGL 101': { conveningGroups: [] }, 'ENGL 102': {},
  };
  const { linked, unresolved } = linkSubjectDepartments(entities, courses);
  assert.equal(linked, 2);
  const placed = (name: string) => entities.find(e => e.name === name)?.relationships?.map(r => 'target_entity_id' in r ? `${r.type} ${r.target_entity_id}` : '') ?? [];
  assert.deepEqual(placed('ARAB'), [`part_of ${subjectIdentityId('LANG')}`]);
  assert.deepEqual(placed('THEA'), [`part_of ${subjectIdentityId('THFL')}`]);
  // The course records that name the group are the evidence, in code order.
  assert.deepEqual(entities.find(e => e.name === 'ARAB')?.relationships?.[0].evidence, ['ARAB 101', 'ARAB 102'].map(key => ({
    collection: 'courses', source_key: 'academic-programs', source_record_key: key, field: 'conveningGroups', source_url: `https://catalog.ramapo.edu/courses/${key.replace(' ', '')}` })));
  for (const name of [LANG, THFL, 'French (FREN)', 'Geology (GEOL)', 'Korean (KORE)', 'Pathways (PATH)', 'PATHCA', 'SRSH', 'ENGL']) assert.deepEqual(placed(name), [], name);
  assert.deepEqual(unresolved.map(u => [u.record, u.kind]), [['FREN', 'note'], ['GEOL', 'note'], ['KORE', 'note'], ['PATHCA', 'missing_connection'], ['SRSH', 'missing_connection']]);
  assert.match(unresolved[1].reason, /name "Environmental Science \(ENSC\)" \(1\), "Geology \(GEOL\)" \(1\), but it is itself the catalog department Geology \(GEOL\); it is not placed in a second department/);
  assert.match(unresolved[3].reason, /name 2 convening groups/);
  assert.match(unresolved[4].reason, /"Interdisciplinary Studies \(SCIN\)", which is not a subject in this release/);
  validateCampusIdentities({ schema_version: 1, entities });
  // Running again adds nothing, and a subject already in a department gets no second one.
  assert.equal(linkSubjectDepartments(entities, courses).linked, 0);
  assert.equal(linkSubjectDepartments(entities, { ...courses, 'ARAB 101': { conveningGroups: [THFL] }, 'ARAB 102': { conveningGroups: [THFL] } }).linked, 0);
  assert.equal(entities.find(e => e.name === 'ARAB')?.relationships?.length, 1);
});

test('a subject convened by two subjects of the same name is not placed, and evidence stops at 32 courses', () => {
  const twins = [subject('AAAA', 'Twin'), { ...subject('BBBB', 'Twin'), name: 'Twin (AAAA)' }, subject('XXXX')];
  const unresolved = linkSubjectDepartments(twins, { 'XXXX 1': { conveningGroups: ['Twin (AAAA)'] } }).unresolved;
  assert.match(unresolved[0].reason, /names 2 subjects/);
  const many = [subject('LANG', 'Language'), subject('ARAB')];
  const courses = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`ARAB ${100 + index}`, { conveningGroups: [LANG] }]));
  linkSubjectDepartments(many, courses);
  const evidence = many[1].relationships?.[0].evidence ?? [];
  assert.equal(evidence.length, 32);
  assert.deepEqual([evidence[0].source_record_key, evidence[31].source_record_key], ['ARAB 100', 'ARAB 131']);
});
