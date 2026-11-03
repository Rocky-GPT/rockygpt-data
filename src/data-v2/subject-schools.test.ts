import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import type { ReviewedSchools } from './campus-schools';
import { subjectIdentityId } from './course-subjects';
import { linkSubjectSchools } from './subject-schools';
import schoolsReference from '../reference/campus-schools.json';

const AHE = 'a0af6d36-ac17-4d2f-9a95-ccb68cd98772';
const SNH = 'c5e91f2f-d073-4bfa-8f8b-819457982c99';
const reference = schoolsReference as ReviewedSchools;
const subject = (code: string): CampusIdentity => ({ id: subjectIdentityId(code), kind: 'subject', name: code, aliases: [],
  links: [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: [code] }] });
const school = (id: string, name: string): CampusIdentity => ({ id, kind: 'school', name, aliases: [], links: [{ collection: 'schools', source_key: 'ramapo-schools', source_record_keys: [name] }] });

test('a subject is part of the one school its catalog courses are filed under', () => {
  const entities = [school(AHE, 'AHE'), school(SNH, 'SNH'), ...['HIST', 'CMPS', 'INTD', 'MIXD', 'ENGL'].map(subject)];
  const courses = {
    'HIST 101': { school: 'Vallario Sch of Arts, Hum, Edu' }, 'HIST 102': { school: 'Vallario Sch of Arts, Hum, Edu' }, 'HIST 103': { school: null },
    'CMPS 147': { school: 'Science, Nursing and Health' },
    'INTD 101': { school: 'Undergraduate Studies and Honors' },
    'MIXD 100': { school: 'Science, Nursing and Health' }, 'MIXD 200': { school: 'Vallario Sch of Arts, Hum, Edu' },
    'ENGL 100': { school: null },
  };
  const { linked, unresolved } = linkSubjectSchools(entities, courses, reference);
  assert.equal(linked, 2);
  const placed = (code: string) => entities.find(e => e.name === code)?.relationships?.map(r => 'target_entity_id' in r ? `${r.type} ${r.target_entity_id}` : '') ?? [];
  assert.deepEqual(placed('HIST'), [`part_of ${AHE}`]);
  assert.deepEqual(placed('CMPS'), [`part_of ${SNH}`]);
  // The course records that say so are the evidence; a course with no college says nothing.
  assert.deepEqual(entities.find(e => e.name === 'HIST')?.relationships?.[0].evidence.map(e => `${e.source_record_key}:${e.field}`), ['HIST 101:school', 'HIST 102:school']);
  // A college that is not a school, or courses split between two schools, place nothing; no college says nothing.
  assert.deepEqual([placed('INTD'), placed('MIXD'), placed('ENGL')], [[], [], []]);
  assert.deepEqual(unresolved.map(u => u.record), ['INTD', 'MIXD']);
  assert.match(unresolved[0].reason, /"Undergraduate Studies and Honors", which is not one of the schools/);
  assert.match(unresolved[1].reason, /which name 2 schools/);
  // Without the reviewed schools nothing is placed.
  assert.equal(linkSubjectSchools([subject('HIST')], courses).linked, 0);
});
