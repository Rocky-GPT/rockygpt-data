import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCampusIdentities, type CampusIdentity } from './campus-identities';
import { attributeCode, COURSE_SEARCH_URL, courseAttributeId, linkCourseAttributes } from './course-attributes';
import { courseIdentityId, COURSE_SOURCE_KEY } from './course-identities';
import { aliasRecords, type AliasLedger } from './identity-aliases';

const course = (code: string): CampusIdentity => ({ id: courseIdentityId(COURSE_SOURCE_KEY, code), kind: 'course', name: code, aliases: [],
  links: [{ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_keys: [code] }] });
const writing: CampusIdentity = { id: '00000000-0000-4000-8000-000000000041', kind: 'subject', name: 'Writing (WRIT)', aliases: ['WRIT'],
  links: [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: ['WRIT'] }] };
const dnp: CampusIdentity = { id: '00000000-0000-4000-8000-000000000042', kind: 'program', name: 'Nursing Practice DNP', aliases: ['Nursing Practice'],
  links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: ['SG-DNP-NUPR'] }] };
const targets = (entity: CampusIdentity | undefined) => (entity?.relationships ?? []).filter(r => r.type === 'in_category')
  .map(r => 'target_entity_id' in r ? r.target_entity_id : null);

test('an attribute code is the code in the parentheses that end the printed text', () => {
  assert.equal(attributeCode('WRITING INTENSIVE (WRIT)'), 'WRIT');
  assert.equal(attributeCode('GE18 Syst,Sust&Soc/SocSys&Soct (GESS)'), 'GESS');
  assert.equal(attributeCode('Honors Course'), null);
  assert.equal(attributeCode('Honors (hnrs)'), null);
  assert.equal(attributeCode('Global (GEGA) Course'), null);
  // The ID is Python's uuid5(NAMESPACE_URL, json.dumps(["rockygpt", "course_attribute", "academic-programs", code])): do not change it.
  assert.equal(courseAttributeId('WRIT'), '27d5c771-435b-547f-afe5-6e8b27bb3037');
});

test('each course is in the attributes its record prints, one node per code, named as printed', () => {
  const entities = ['ANTH 201', 'BIOL 499', 'CMPS 147', 'HIST 210', 'MBAD 600', 'NURS 800'].map(course);
  const courses = {
    'ANTH 201': { attributes: ['Gen Ed 18-Global Awareness (GEGA)', 'WRITING INTENSIVE (WRIT)'] },
    'BIOL 499': { attributes: ['Capstone Course (CPST)', 'WRITING  INTENSIVE (WRIT) '] },
    'CMPS 147': { attributes: [] },
    'HIST 210': { attributes: ['Gen Ed 18-Global Awareness (GEGA)', 'Honors Course'] },
    'MBAD 600': { attributes: ['MBA COURSE FOR GRAD FEE ASSESS (MBA)'] },
    'NURS 800': { attributes: ['DNP Program (DNP)'] },
    'MSAC 510': { attributes: ['MSAC COURSE FOR GRAD FEE ASMNT (MSAC)'] },
    'PSYC 101': { attributes: ['Fieldwork (FLDW)'] }, // No course node: nothing is made or linked.
  };
  const ledger: AliasLedger = new Map();
  const result = linkCourseAttributes([writing, dnp, ...entities], courses, '2026-11-03T00:00:00Z', ledger);
  assert.deepEqual(result.entities.map(e => [e.id, e.kind, e.name, e.aliases]), [
    [courseAttributeId('CPST'), 'course_attribute', 'Capstone Course (CPST)', ['CPST']],
    // A lookup by DNP or WRIT finds the program or the subject too, so neither is an alias here.
    [courseAttributeId('DNP'), 'course_attribute', 'DNP Program (DNP)', []],
    [courseAttributeId('GEGA'), 'course_attribute', 'Gen Ed 18-Global Awareness (GEGA)', ['GEGA']],
    [courseAttributeId('WRIT'), 'course_attribute', 'WRITING INTENSIVE (WRIT)', []]]);
  assert.deepEqual(result.entities[2].links, [{ collection: 'course_attributes', source_key: COURSE_SOURCE_KEY, source_record_keys: ['GEGA'] }]);
  const byCode = new Map(entities.map(e => [e.name, e]));
  assert.deepEqual(targets(byCode.get('ANTH 201')), [courseAttributeId('GEGA'), courseAttributeId('WRIT')]);
  assert.deepEqual(targets(byCode.get('BIOL 499')), [courseAttributeId('CPST'), courseAttributeId('WRIT')]);
  assert.deepEqual(byCode.get('ANTH 201')?.relationships?.[0], { type: 'in_category', target_entity_id: courseAttributeId('GEGA'), evidence: [
    { collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: 'ANTH 201', field: 'attributes', source_url: 'https://catalog.ramapo.edu/courses/ANTH201' }] });
  // A billing flag is never linked; neither is an attribute printed without a code.
  assert.equal(byCode.get('MBAD 600')?.relationships, undefined);
  assert.deepEqual(targets(byCode.get('HIST 210')), [courseAttributeId('GEGA')]);
  assert.equal(byCode.get('CMPS 147')?.relationships, undefined);
  assert.deepEqual(targets(byCode.get('NURS 800')), [courseAttributeId('DNP')]);
  assert.equal(result.linked, 6);
  assert.deepEqual(result.records, { source_key: COURSE_SOURCE_KEY, collected_at: '2026-11-03T00:00:00Z', rows: [
    { source_record_key: 'CPST', name: 'Capstone Course (CPST)', course_count: 1, source_url: COURSE_SEARCH_URL },
    { source_record_key: 'DNP', name: 'DNP Program (DNP)', course_count: 1, source_url: COURSE_SEARCH_URL },
    { source_record_key: 'GEGA', name: 'Gen Ed 18-Global Awareness (GEGA)', course_count: 2, source_url: COURSE_SEARCH_URL },
    { source_record_key: 'WRIT', name: 'WRITING INTENSIVE (WRIT)', course_count: 2, source_url: COURSE_SEARCH_URL }] });
  assert.deepEqual(result.unresolved.map(u => [u.entity, u.collection, u.record, u.kind]), [
    ['DNP Program (DNP)', 'course_attributes', 'DNP', 'note'],
    ['WRITING INTENSIVE (WRIT)', 'course_attributes', 'WRIT', 'note'],
    ['MBA COURSE FOR GRAD FEE ASSESS (MBA)', 'course_attributes', 'MBA', 'note'],
    ['Honors Course', 'courses', undefined, 'missing_connection']]);
  assert.equal(result.unresolved[0].reason, 'DNP is already in the name or an alias of the program "Nursing Practice DNP", so it is not made an alias of this attribute; the attribute answers to its printed name only.');
  assert.match(result.unresolved[1].reason, /^WRIT is already in the name or an alias of the subject "Writing \(WRIT\)", so it is not made an alias/);
  assert.equal(result.unresolved[2].reason, 'An internal billing flag (graduate fee assessment) the catalog prints on 1 course; it is not linked.');
  assert.match(result.unresolved[3].reason, /on 1 course \(HIST 210\) without a code in parentheses; no code is guessed/);
  // Each alias is noted with the rule that put it there.
  assert.deepEqual(aliasRecords(result.entities, ledger).map(r => [r.alias, r.sources]), [['CPST', [{ basis: 'abbreviation' }]], ['GEGA', [{ basis: 'abbreviation' }]]]);
  validateCampusIdentities({ schema_version: 1, entities: [writing, dnp, ...entities, ...result.entities] });
  // Running again adds no link twice.
  assert.equal(linkCourseAttributes([writing, dnp, ...entities], courses).linked, 0);
});

test('a code printed two ways is one node, named the way most of its courses print it', () => {
  const entities = ['ACCT 490', 'FINC 490', 'MGMT 490'].map(course);
  const result = linkCourseAttributes(entities, {
    'ACCT 490': { attributes: ['ASB Writing Core (BWAC)'] },
    'FINC 490': { attributes: ['ASB Writing Core (BWAC)'] },
    'MGMT 490': { attributes: ['ASB WRITING CORE (BWAC)'] },
  });
  assert.deepEqual(result.entities.map(e => [e.name, e.aliases]), [['ASB Writing Core (BWAC)', ['BWAC']]]);
  assert.deepEqual(entities.map(targets), [[courseAttributeId('BWAC')], [courseAttributeId('BWAC')], [courseAttributeId('BWAC')]]);
  assert.equal(result.records.rows[0].course_count, 3);
  assert.deepEqual(result.unresolved.map(u => [u.record, u.kind]), [['BWAC', 'note']]);
  assert.match(result.unresolved[0].reason, /prints this code 2 ways \("ASB Writing Core \(BWAC\)" on 2 courses, "ASB WRITING CORE \(BWAC\)" on 1 course\)/);
});
