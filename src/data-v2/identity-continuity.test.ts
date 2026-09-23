import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentities, CampusIdentity, CampusIdentityRelationship } from './campus-identities';
import { allowedLoss, compareIdentityRegistries } from './identity-continuity';
import { subjectIdentityId } from './course-subjects';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function entity(n: number, kind: CampusIdentity['kind'], relationships?: CampusIdentity['relationships']): CampusIdentity {
  return {
    id: uuid(n), kind, name: `${kind} ${n}`, aliases: [],
    links: [{ collection: 'contacts', source_key: 'directory', source_record_keys: [`key-${n}`] }],
    ...(relationships ? { relationships } : {}),
  };
}
const registry = (entities: CampusIdentity[]): CampusIdentities => ({ schema_version: 1, entities });
const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index);
const offices = range(1, 13).map(n => entity(n, 'office'));
const people = range(100, 231).map(n => entity(n, 'person'));
const seed = registry([...offices, ...people]);

test('the first release with identities has no baseline and cannot fail', () => {
  const report = compareIdentityRegistries(null, seed, seed);
  assert.equal(report.baseline, 'none');
  assert.deepEqual(report.failures, []);
});

test('ordinary churn is reported without blocking, and mass loss fails', () => {
  assert.equal(allowedLoss(4), 2);
  assert.equal(allowedLoss(231), 23);
  const one = compareIdentityRegistries(seed, registry(seed.entities.slice(1)), seed);
  assert.deepEqual(one.lost_by_kind, { office: 1 });
  assert.deepEqual(one.lost, [{ id: uuid(1), kind: 'office', name: 'office 1' }]);
  assert.deepEqual(one.failures, []);
  const three = compareIdentityRegistries(seed, registry(seed.entities.slice(3)), seed);
  assert.deepEqual(three.failures, ['3 of 13 office identities disappeared (at most 2 allowed)']);
  const tolerated = compareIdentityRegistries(seed, registry([...offices, ...people.slice(23)]), seed);
  assert.deepEqual(tolerated.failures, []);
  const broken = compareIdentityRegistries(seed, registry([...offices, ...people.slice(24)]), seed);
  assert.deepEqual(broken.failures, ['24 of 231 person identities disappeared (at most 23 allowed)']);
});

test('a persistent ID must keep its kind', () => {
  const changed = registry(seed.entities.map(item => item.id === uuid(1) ? { ...item, kind: 'facility' } : item));
  assert.deepEqual(compareIdentityRegistries(seed, changed, seed).failures,
    [`identity ${uuid(1)} changed kind from office to facility`]);
});

test('an Archway group moving between club and organization is not a kind failure', () => {
  const group = entity(700, 'club');
  const report = compareIdentityRegistries(registry([group]), registry([{ ...group, kind: 'organization' }]), seed);
  assert.deepEqual(report.kind_changes, [{ id: uuid(700), from: 'club', to: 'organization' }]);
  assert.deepEqual(report.failures, []);
});

test('past event occurrences and deliberate seed retirements are expected losses', () => {
  const events = range(500, 100).map(n => entity(n, 'event'));
  const previous = registry([...offices, ...events]);
  const past = new Set(events.slice(0, 60).map(item => item.id));
  const expired = compareIdentityRegistries(previous, registry([...offices, ...events.slice(60)]), seed, past);
  assert.equal(expired.expected_losses.past_event_occurrences, 60);
  assert.deepEqual(expired.failures, []);
  const cancelled = compareIdentityRegistries(previous, registry([...offices, ...events.slice(11)]), seed);
  assert.deepEqual(cancelled.failures, ['11 of 100 event identities disappeared (at most 10 allowed)']);
  const retiredSeed = registry(seed.entities.slice(5));
  const retired = compareIdentityRegistries(seed, retiredSeed, retiredSeed);
  assert.equal(retired.expected_losses.retired_in_seed, 5);
  assert.deepEqual(retired.lost, []);
  assert.deepEqual(retired.failures, []);
});

test('relationship loss is judged only where both endpoints survive', () => {
  const evidence = (id: string) => [{ collection: 'programs' as const, source_key: 'catalog', source_record_key: `program-${id}`, field: 'customFields.rJQmj', source_record_id: id }];
  const programs = (rowId: (n: number) => string, withConvener: (n: number) => boolean) =>
    range(1000, 20).map(n => entity(n, 'program', withConvener(n)
      ? [{ type: 'convener', target_entity_id: uuid(100 + (n % 20)), evidence: evidence(rowId(n)) }]
      : undefined));
  const previous = registry([...people, ...programs(n => uuid(9000 + n), () => true)]);
  // Regenerated evidence row IDs do not make a relationship new.
  const regenerated = compareIdentityRegistries(previous, registry([...people, ...programs(n => uuid(8000 + n), () => true)]), seed);
  assert.deepEqual(regenerated.lost_relationships_by_type, {});
  const three = compareIdentityRegistries(previous, registry([...people, ...programs(n => uuid(9000 + n), n => n >= 1003)]), seed);
  assert.deepEqual(three.failures, ['3 of 20 convener relationships disappeared (at most 2 allowed)']);
  // Losing the target person is an identity change, not a lost relationship.
  const withoutTargets = compareIdentityRegistries(previous, registry([...people.slice(20), ...programs(n => uuid(9000 + n), () => false)]), seed);
  assert.deepEqual(withoutTargets.lost_relationships_by_type, {});
});

test('the reported loss list is bounded', () => {
  const events = range(500, 150).map(n => entity(n, 'event'));
  const report = compareIdentityRegistries(registry(events), registry([]), seed);
  assert.equal(report.lost.length, 100);
  assert.equal(report.lost_truncated, true);
  assert.equal(report.lost_by_kind.event, 150);
});

const subject = (code: string, courseNumbers = [101, 102, 103]): CampusIdentity => ({
  id: subjectIdentityId(code), kind: 'subject', name: code, aliases: [],
  links: [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: [code] }],
  relationships: courseNumbers.map(number => ({ type: 'includes_course',
    target_record: { collection: 'courses', source_key: 'academic-programs', source_record_key: `${code} ${number}` },
    evidence: [{ collection: 'courses', source_key: 'academic-programs', source_record_key: `${code} ${number}`, field: 'code' }],
  })),
});
const inactiveCapture = (codes: string[]) => ({ scrapedAt: '2026-09-23T19:44:12.134Z', courses: codes.map(code => ({ code, status: 'Inactive' })) });

test('explicit unique inactive courses explain only absent subject-course relationships and retain source proof', () => {
  const original = subject('TEST');
  const current = { ...original, relationships: [] };
  const catalog = inactiveCapture(['TEST101', 'TEST102', 'TEST103']);
  const report = compareIdentityRegistries(registry([original]), registry([current]), registry([]), new Set(), { catalog, candidateCourses: {} });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.lost_relationships_by_type, {});
  assert.deepEqual(report.expected_relationship_losses_by_type, { includes_course: 3 });
  assert.deepEqual(report.inactive_catalog_evidence?.courses.map(course => [course.course_key, course.raw_pointer, course.status]), [
    ['TEST 101', '/courses/0', 'Inactive'], ['TEST 102', '/courses/1', 'Inactive'], ['TEST 103', '/courses/2', 'Inactive'],
  ]);
  assert.equal(report.inactive_catalog_evidence?.collected_at, catalog.scrapedAt);
});

test('active, absent, duplicate, undated and still-published courses remain blocking losses', () => {
  const original = subject('TEST');
  const prior = registry([original]); const current = registry([{ ...original, relationships: [] }]);
  const catalog = inactiveCapture(['TEST101', 'TEST102', 'TEST103']);
  const cases = [
    { catalog: { ...catalog, courses: [] }, candidateCourses: {} },
    { catalog: { ...catalog, courses: catalog.courses.map(row => ({ ...row, status: 'Active' })) }, candidateCourses: {} },
    { catalog: { ...catalog, courses: catalog.courses.flatMap(row => [row, row]) }, candidateCourses: {} },
    { catalog: { ...catalog, courses: catalog.courses.flatMap(row => [row, { ...row, status: 'Active' }]) }, candidateCourses: {} },
    { catalog: { ...catalog, scrapedAt: 'not dated' }, candidateCourses: {} },
    { catalog },
    { catalog, candidateCourses: { 'TEST 101': {}, 'TEST 102': {}, 'TEST 103': {} } },
  ];
  for (const evidence of cases) {
    const report = compareIdentityRegistries(prior, current, registry([]), new Set(), evidence);
    assert.deepEqual(report.failures, ['3 of 3 includes_course relationships disappeared (at most 2 allowed)']);
    assert.deepEqual(report.expected_relationship_losses_by_type, {});
  }
});

test('a derived subject is expected missing only when all its prior courses are explicitly inactive and no current courses remain', () => {
  const subjects = ['AAA', 'BBB', 'CCC'].map(code => subject(code, [101]));
  const prior = registry(subjects); const current = registry([]);
  const catalog = inactiveCapture(['AAA101', 'BBB101', 'CCC101']);
  const report = compareIdentityRegistries(prior, current, current, new Set(), { catalog, candidateCourses: {} });
  assert.deepEqual(report.failures, []);
  assert.equal(report.expected_losses.inactive_catalog_subjects, 3);
  assert.equal(report.inactive_catalog_evidence?.subjects.length, 3);
  for (const evidence of [
    { catalog: { ...catalog, courses: [] }, candidateCourses: {} },
    { catalog: { ...catalog, courses: [...catalog.courses, ...['AAA', 'BBB', 'CCC'].map(code => ({ code: `${code}999`, status: 'Active' }))] }, candidateCourses: {} },
    { catalog, candidateCourses: { 'AAA 999': {}, 'BBB 999': {}, 'CCC 999': {} } },
  ]) {
    const rejected = compareIdentityRegistries(prior, current, current, new Set(), evidence);
    assert.equal(rejected.expected_losses.inactive_catalog_subjects, 0);
    assert.deepEqual(rejected.failures, ['3 of 3 subject identities disappeared (at most 2 allowed)']);
  }
  const mixed = registry(subjects.map(s => ({ ...s, relationships: [...s.relationships!, { ...s.relationships![0], target_record: { collection: 'courses', source_key: 'academic-programs', source_record_key: `${s.name} 999` } } as CampusIdentityRelationship] })));
  assert.equal(compareIdentityRegistries(mixed, current, current, new Set(), { catalog, candidateCourses: {} }).expected_losses.inactive_catalog_subjects, 0);
});
