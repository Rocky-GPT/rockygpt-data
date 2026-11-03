import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCampusIdentities, type CampusIdentity } from './campus-identities';
import { linkCourseCrossListings, crossListedCodes } from './course-cross-listings';
import { courseIdentityId, COURSE_SOURCE_KEY } from './course-identities';

const course = (code: string): CampusIdentity => ({ id: courseIdentityId(COURSE_SOURCE_KEY, code), kind: 'course', name: code, aliases: [],
  links: [{ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_keys: [code] }] });

test('a cross-listing sentence names its courses however the catalog writes them', () => {
  assert.deepEqual(crossListedCodes('Regional themes vary by semester. This course is cross-listed with ARHT 311.'), ['ARHT 311']);
  assert.deepEqual(crossListedCodes('Genomic science. This course is cross listed as BIIN335.'), ['BIIN 335']);
  assert.deepEqual(crossListedCodes('Field methods. This course is cross listed with BIOL 220L.'), ['BIOL 220L']);
  // Only the cross-listing sentence counts, not a code elsewhere in the description.
  assert.deepEqual(crossListedCodes('Follows HIST 101. Cross-listed with AMER 316 and HIST 316; see the catalog.'), ['AMER 316', 'HIST 316']);
  assert.deepEqual(crossListedCodes('Students who completed HIST 101 may not enroll.'), []);
  assert.deepEqual(crossListedCodes(undefined), []);
});

test('two courses that name each other are cross-listed once, with both descriptions as evidence', () => {
  const entities = ['AMER 311', 'ARHT 311', 'BIOL 335', 'BIIN 335', 'DATA 670'].map(course);
  const courses = {
    'AMER 311': { description: 'This course is cross-listed with ARHT 311.' },
    'ARHT 311': { description: 'This course is cross-listed with AMER 311.' },
    'BIOL 335': { description: 'This course is cross listed as BIIN335.' },
    'BIIN 335': { description: 'Bioinformatics.' },
    'DATA 670': { description: 'This course is cross listed with MBAD670.' },
  };
  const { linked, unresolved } = linkCourseCrossListings(entities, courses);
  assert.equal(linked, 2);
  const byCode = new Map(entities.map(e => [e.name, e]));
  assert.deepEqual(byCode.get('AMER 311')?.relationships, [{ type: 'cross_listed', target_entity_id: courseIdentityId(COURSE_SOURCE_KEY, 'ARHT 311'), evidence: [
    { collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: 'AMER 311', field: 'description', source_url: 'https://catalog.ramapo.edu/courses/AMER311' },
    { collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: 'ARHT 311', field: 'description', source_url: 'https://catalog.ramapo.edu/courses/ARHT311' },
  ] }]);
  assert.equal(byCode.get('ARHT 311')?.relationships, undefined);
  // The link is kept on the course first in code order, even when only the other one says so.
  assert.deepEqual(byCode.get('BIIN 335')?.relationships?.map(r => [r.type, 'target_entity_id' in r && r.target_entity_id, r.evidence.map(e => e.source_record_key)]),
    [['cross_listed', courseIdentityId(COURSE_SOURCE_KEY, 'BIOL 335'), ['BIOL 335']]]);
  // A code the catalog does not list is reported, not linked.
  assert.deepEqual(unresolved.map(u => [u.record, u.kind]), [['DATA 670', 'missing_connection']]);
  assert.match(unresolved[0].reason, /cross-listed with MBAD 670, which is not a course in this release's catalog/);
  // Running again adds nothing twice.
  assert.equal(linkCourseCrossListings(entities, courses).linked, 0);
  validateCampusIdentities({ schema_version: 1, entities });
});
