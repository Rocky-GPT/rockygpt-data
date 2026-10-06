import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentities } from '../src/data-v2/campus-identities';
import type { IdentityCoverageReport } from '../src/data-v2/compile-campus-identities';
import type { ReviewedAlias } from '../src/data-v2/identity-aliases';
import { localDevelopmentTarget, overlayReviewedAliases } from './development-reviewed-aliases';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const link = (key: string) => [{ collection: 'contacts' as const, source_key: 'campus-directory', source_record_keys: [key] }];
const registry = (): CampusIdentities => ({
  schema_version: 1,
  entities: [
    { id: id(1), kind: 'office', name: 'Health Services', aliases: [], links: link('health') },
    { id: id(2), kind: 'office', name: 'Library', aliases: ['Potter Library'], links: link('library') },
  ],
});
const report = (): IdentityCoverageReport => ({
  identity_count: 2, identities_by_kind: { office: 2 }, linked_records: {}, relationships: {}, unresolved: [],
  alias_sources: [{ entity_id: id(2), entity: 'Library', kind: 'office', alias: 'Potter Library', sources: [{ basis: 'department' }] }],
});
const review = (n: number, entity: string, alias: string): ReviewedAlias => ({
  entity_id: id(n), entity, alias, reviewed_at: '2026-10-06', source_url: 'https://www.ramapo.edu/health/', note: 'Approved.',
});

test('a reviewed alias is added with its source and nothing else changes', () => {
  const before = registry();
  const overlay = overlayReviewedAliases(before, report(), [review(1, 'Health Services', 'Health Center')]);
  assert.deepEqual(overlay.added, ['Health Services: Health Center']);
  assert.deepEqual(overlay.registry.entities.map(e => e.aliases), [['Health Center'], ['Potter Library']]);
  assert.deepEqual(overlay.registry.entities.map(e => [e.id, e.kind, e.name, e.links]), before.entities.map(e => [e.id, e.kind, e.name, e.links]));
  const sources = overlay.report.alias_sources.find(record => record.alias === 'Health Center');
  assert.equal(sources?.sources[0].basis, 'human_reviewed');
  assert.equal(sources?.sources[0].source_url, 'https://www.ramapo.edu/health/');
  assert.equal(overlay.report.alias_sources.some(record => record.alias === 'Potter Library' && record.sources[0].basis === 'department'), true);
  assert.deepEqual(overlay.report.human_reviewed_aliases?.map(a => a.alias), ['Health Center']);
  assert.equal(before.entities[0].aliases.length, 0, 'the input is not changed');
});

test('applying the same reviews twice adds nothing the second time', () => {
  const reviews = [review(1, 'Health Services', 'Health Center')];
  const first = overlayReviewedAliases(registry(), report(), reviews);
  const second = overlayReviewedAliases(first.registry, first.report, reviews);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.registry, first.registry);
  assert.equal(second.report.human_reviewed_aliases?.length, 1);
  assert.equal(second.report.alias_sources.find(r => r.alias === 'Health Center')?.sources.length, 1);
});

test('a review for an identity that is not in the release is reported, not applied', () => {
  const overlay = overlayReviewedAliases(registry(), report(), [review(9, 'Health Services', 'Health Center'), review(2, 'Wrong Name', 'Reading Room')]);
  assert.deepEqual(overlay.added, []);
  assert.equal(overlay.unresolved.length, 2);
  assert.equal(overlay.report.unresolved.length, 2);
  assert.deepEqual(overlay.registry, registry());
});

test('sources read back from jsonb in another key order are not recorded twice', () => {
  const stored = report();
  stored.alias_sources.push({ entity_id: id(1), entity: 'Health Services', kind: 'office', alias: 'Health Center',
    // jsonb returns keys shortest first, not in the order the compiler wrote them.
    sources: [{ note: 'Approved.', basis: 'human_reviewed', reviewed_at: '2026-10-06', source_url: 'https://www.ramapo.edu/health/' }] });
  const withAlias = registry();
  withAlias.entities[0].aliases = ['Health Center'];
  const overlay = overlayReviewedAliases(withAlias, stored, [review(1, 'Health Services', 'Health Center')]);
  assert.equal(overlay.report.alias_sources.find(record => record.alias === 'Health Center')?.sources.length, 1);
  assert.deepEqual(overlay.added, []);
});

test('an alias that does not fit the identity is reported and the rest still apply', () => {
  const full = registry();
  full.entities[0].aliases = Array.from({ length: 32 }, (_, n) => `Name ${n}`);
  const stored = report();
  for (const alias of full.entities[0].aliases) stored.alias_sources.push({ entity_id: id(1), entity: 'Health Services', kind: 'office', alias, sources: [{ basis: 'identity_map' }] });
  const overlay = overlayReviewedAliases(full, stored, [review(1, 'Health Services', 'Health Center'), review(2, 'Library', 'Reading Room')]);
  assert.deepEqual(overlay.added, ['Library: Reading Room']);
  assert.equal(overlay.unresolved.length, 1);
});

test('only a local database copy named rockygpt_profiles_dev_* is accepted', () => {
  const ok = localDevelopmentTarget('postgresql://postgres@127.0.0.1:55434/rockygpt_profiles_dev_offices_20261006_aliases');
  assert.deepEqual(ok, { host: '127.0.0.1', port: 55434, user: 'postgres', database: 'rockygpt_profiles_dev_offices_20261006_aliases' });
  assert.equal(localDevelopmentTarget('postgres://u:pw@LOCALHOST/rockygpt_profiles_dev_x').host, 'localhost');
  assert.equal(localDevelopmentTarget('postgresql://postgres@[::1]:55434/rockygpt_profiles_dev_x').host, '::1');
  for (const bad of [
    'postgresql://postgres@127.0.0.1:55434/rockygpt_profiles_dev_x?host=db.example.com',
    'postgresql://postgres@127.0.0.1:55434/rockygpt_profiles_dev_x?options=-c%20search_path%3Dx',
    'postgresql://postgres@127.0.0.1.evil.com/rockygpt_profiles_dev_x',
    'postgresql://postgres@db.example.com:5432/rockygpt_profiles_dev_x',
    'postgresql://postgres@127.0.0.1:55434/rockygpt_v2',
    'postgresql://postgres@127.0.0.1:55434/production_dev',
    'postgresql://postgres@127.0.0.1:55434/rockygpt_profiles_dev_x/../other',
    'mysql://root@127.0.0.1/rockygpt_profiles_dev_x',
    'not a url',
  ]) assert.throws(() => localDevelopmentTarget(bad), bad);
});
