import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentities, CampusIdentity } from './campus-identities';
import { allowedLoss, compareIdentityRegistries } from './identity-continuity';

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
