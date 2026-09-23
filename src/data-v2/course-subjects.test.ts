import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCampusIdentities } from './campus-identities';
import { compileCampusIdentities } from './compile-campus-identities';
import { compileSubjectIdentities, courseSubjectCode, courseSubjectsArtifact, courseSubjectsInput, subjectIdentityId } from './course-subjects';
import { aliasRecords, type AliasLedger } from './identity-aliases';
import { compareIdentityRegistries } from './identity-continuity';
import subjectsReference from '../reference/course-subjects.json';
import subjectsSource from '../reference/course-subjects.source.json';

const courses = { 'CMPS 147': { code: 'CMPS 147' }, 'CMPS 148': { code: 'CMPS 148' }, 'LITR 201': { code: 'LITR 201' }, 'SCIN 100T': { code: 'SCIN 100T' } };
const input = {
  source_url: 'https://app.coursedog.com/api/v1/ramapo_banner_ethos/departments', captured_at: '2026-08-27T14:22:13.103Z',
  subjects: [
    { code: 'CMPS', name: 'Computer Science', aliases: ['CS', 'Comp Sci', 'CS'] },
    { code: 'SCIN', name: 'Interdisciplinary Studies', aliases: [] },
    { code: 'CYBR', name: 'Cybersecurity', aliases: [] },
    { code: 'LITR', name: '', aliases: ['Literature', 'Lit'] },
  ],
};

test('a subject is the code in front of a course, named only by the catalog department list', () => {
  assert.equal(courseSubjectCode('CMPS 147'), 'CMPS');
  assert.equal(courseSubjectCode('PATHCA 101'), 'PATHCA');
  assert.equal(courseSubjectCode('147'), null);
  const { artifact, unresolved } = courseSubjectsArtifact(courses, input);
  assert.deepEqual(artifact.subjects, [
    { code: 'CMPS', name: 'Computer Science', display_name: 'Computer Science (CMPS)', search_terms: ['CS', 'Comp Sci'], course_count: 2 },
    // No department names LITR: it keeps its code; the curated short forms are search terms only.
    { code: 'LITR', name: null, display_name: 'LITR', search_terms: ['Literature', 'Lit'], course_count: 1 },
    { code: 'SCIN', name: 'Interdisciplinary Studies', display_name: 'Interdisciplinary Studies (SCIN)', search_terms: [], course_count: 1 },
  ]);
  assert.equal(artifact.captured_at, input.captured_at);
  assert.equal(artifact.source.source_key, 'course-subjects');
  assert.deepEqual(unresolved.map(u => u.record), ['LITR', 'CYBR']);
  assert.match(unresolved[0].reason, /^The catalog department list publishes no name/);
  assert.match(unresolved[1].reason, /^No course in this release's catalog carries this subject code/);
  // Without the reviewed subject list there are no subjects.
  assert.deepEqual(courseSubjectsArtifact(courses).artifact.subjects, []);
});

test('a subject answers to its code only and includes each course by the course\'s own code', () => {
  const ledger: AliasLedger = new Map();
  const [cmps, litr] = compileSubjectIdentities(courseSubjectsArtifact(courses, input).artifact, courses, ledger);
  assert.equal(cmps.id, subjectIdentityId('CMPS'));
  assert.deepEqual([cmps.kind, cmps.name, cmps.aliases], ['subject', 'Computer Science (CMPS)', ['CMPS']]);
  assert.deepEqual(litr.aliases, []);
  assert.deepEqual(cmps.links, [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: ['CMPS'] }]);
  assert.deepEqual(cmps.relationships, ['CMPS 147', 'CMPS 148'].map(key => ({
    type: 'includes_course', target_record: { collection: 'courses', source_key: 'academic-programs', source_record_key: key },
    evidence: [{ collection: 'courses', source_key: 'academic-programs', source_record_key: key, field: 'code' }],
  })));
  assert.deepEqual(aliasRecords([cmps], ledger)[0].sources, [{ basis: 'subject_code' }]);
  // A renamed department keeps its subject's identity.
  const renamed = { ...input, subjects: [{ ...input.subjects[0], name: 'Computing' }] };
  assert.equal(compileSubjectIdentities(courseSubjectsArtifact(courses, renamed).artifact, courses)[0].id, cmps.id);
});

test('compiled subjects validate, keep their catalog name out of lookup and survive continuity checks', () => {
  const snapshot = { campus_contacts: [], campus_hours: [], dining_hours: [], menu_items: [], programs: [], artifacts: { courses } };
  const result = compileCampusIdentities({ schema_version: 1, entities: [] }, snapshot, undefined, { courseSubjects: input });
  validateCampusIdentities(result.registry);
  const cmps = result.registry.entities.find(e => e.name === 'Computer Science (CMPS)');
  // The abbreviation rule does not turn "Computer Science (CMPS)" into a "Computer Science" alias.
  assert.deepEqual(cmps?.aliases, ['CMPS']);
  assert.equal(result.report.relationships.includes_course, 4);
  assert.equal(result.report.identities_by_kind.subject, 3);
  assert.equal(result.courseSubjects.subjects.length, 3);
  const report = compareIdentityRegistries(result.registry, result.registry, { schema_version: 1, entities: [] }, new Set());
  assert.deepEqual(report.failures, []);
});

test('the committed subject list and its capture record are what the compiler reads', () => {
  const committed = courseSubjectsInput(subjectsSource, subjectsReference);
  assert.equal(committed.captured_at, '2026-08-27T14:22:13.103Z');
  assert.ok(committed.subjects.some(subject => subject.code === 'CMPS' && subject.aliases.includes('CS')));
  assert.throws(() => courseSubjectsInput({ source_url: 'x' }, subjectsReference), /capture record/);
  assert.throws(() => courseSubjectsInput(subjectsSource, [{ code: 'CMPS' }]), /capture record/);
});
