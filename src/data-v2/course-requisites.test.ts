import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCampusIdentities, type CampusIdentity } from './campus-identities';
import { courseIdentityId, COURSE_SOURCE_KEY } from './course-identities';
import { linkCourseRequisites, requisiteCodes, requisiteLink } from './course-requisites';

const course = (code: string): CampusIdentity => ({ id: courseIdentityId(COURSE_SOURCE_KEY, code), kind: 'course', name: code, aliases: [],
  links: [{ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_keys: [code] }] });
const codes = (...values: string[]) => [{ codes: values.map(code => ({ code, name: '' })), logic: values.length > 1 ? 'or' : 'and' }];
const links = (entity: CampusIdentity | undefined) => (entity?.relationships ?? []).map(r => `${r.type} ${'target_entity_id' in r ? r.target_entity_id : ''}`);

test('a requisite section is a prerequisite or a corequisite, misspelled or not', () => {
  assert.equal(requisiteLink({ section: 'Prerequisite', rule: {} }), 'requires');
  assert.equal(requisiteLink({ section: 'Prerequiste', rule: {} }), 'requires');
  assert.equal(requisiteLink({ section: 'Corequsite', rule: {} }), 'taken_with');
  // An untitled section is read by its rule's name.
  assert.equal(requisiteLink({ section: 'Untitled Requirement', rule: { name: 'Prerequisite Courses' } }), 'requires');
  assert.equal(requisiteLink({ section: 'Untitled Requirement', rule: { name: 'Select 1 Course' } }), null);
});

test('every course a rule names, nested rules included, once each', () => {
  const rule = { name: 'Prerequisite Courses', condition: 'allOf', subRules: [
    { name: 'Prerequisite Course', condition: 'minimumGrade', items: codes('ACCT 321') },
    { name: 'Prerequisite Course', condition: 'completedAllOf', items: codes('CRWT 102', 'CRWT 102S') },
    { name: 'Select 1 Course', condition: 'completedAtLeastXOf', constraints: { value: { condition: 'courseSets' } } },
  ], items: codes('ACCT 321') };
  assert.deepEqual(requisiteCodes(rule), ['ACCT 321', 'CRWT 102', 'CRWT 102S']);
  assert.deepEqual(requisiteCodes(undefined), []);
});

test('a course requires the courses its prerequisites name and is taken with its corequisites', () => {
  const entities = ['ACCT 221', 'ACCT 222', 'CRWT 102', 'CRWT 102S', 'BIOL 213', 'BIOL 213L'].map(course);
  const courses = {
    'ACCT 222': { code: 'ACCT 222', requisites: [{ section: 'Prerequisite', rule: { name: 'Prerequisite Courses', condition: 'completedAllOf',
      items: [...codes('ACCT 221'), ...codes('CRWT 102', 'CRWT 102S'), ...codes('ACCT 199')] } }] },
    'BIOL 213': { code: 'BIOL 213', requisites: [{ section: 'Corequisite', rule: { name: 'Corequisite Course', condition: 'enrolledIn', items: codes('BIOL 213L', 'BIOL 213') } }] },
    'ACCT 221': { code: 'ACCT 221', requisites: [] },
    'NOPE 100': { code: 'NOPE 100', requisites: [{ section: 'Prerequisite', rule: { items: codes('ACCT 221') } }] },
  };
  const { linked, unresolved } = linkCourseRequisites(entities, courses);
  assert.equal(linked, 4);
  const byCode = new Map(entities.map(e => [e.name, e]));
  assert.deepEqual(links(byCode.get('ACCT 222')), ['ACCT 221', 'CRWT 102', 'CRWT 102S'].map(code => `requires ${courseIdentityId(COURSE_SOURCE_KEY, code)}`));
  // A course never links itself; a corequisite is its own kind of link.
  assert.deepEqual(links(byCode.get('BIOL 213')), [`taken_with ${courseIdentityId(COURSE_SOURCE_KEY, 'BIOL 213L')}`]);
  assert.deepEqual(byCode.get('ACCT 222')?.relationships?.[0].evidence, [{ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: 'ACCT 222', field: 'requisites', source_url: 'https://catalog.ramapo.edu/courses/ACCT222' }]);
  // A code the catalog does not list is reported, not linked.
  assert.deepEqual(unresolved.map(u => [u.record, u.kind]), [['ACCT 222', 'missing_connection']]);
  assert.match(unresolved[0].reason, /^ACCT 199 is named in this course's prerequisites but is not a course/);
  // Running again adds nothing twice.
  assert.equal(linkCourseRequisites(entities, courses).linked, 0);
  validateCampusIdentities({ schema_version: 1, entities });
});
