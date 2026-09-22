import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { verifyIdentityContinuity } from './campus-identity-artifacts';
import type { CampusIdentities, CampusIdentity } from '../src/data-v2/campus-identities';

const connection = process.env.IDENTITY_CONTINUITY_TEST_DATABASE_URL;
const office = (n: number, kind: CampusIdentity['kind'] = 'office'): CampusIdentity => ({
  id: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`, kind, name: `Office ${n}`, aliases: [],
  links: [{ collection: 'contacts', source_key: 'directory', source_record_keys: [`office-${n}`] }],
});
const occurrence = (n: number, rowId: string): CampusIdentity => ({
  id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`, kind: 'event', name: `Event ${n}`, aliases: [],
  links: [{ collection: 'events', source_key: 'archway-events', source_record_keys: [`event-${n}`], source_record_ids: [rowId] }],
});
const registry = (entities: CampusIdentity[]): CampusIdentities => ({ schema_version: 1, entities });

test('PostgreSQL continuity reads the active baseline, expires started events and blocks kind changes', { skip: !connection }, async () => {
  const url = new URL(connection!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/rockygpt_identity_continuity_test/);
  const pool = new Pool({ connectionString: connection, max: 1 });
  const client = await pool.connect();
  try {
    // Dedicated newly-created test database; no existing schema/data is removed.
    await client.query(`CREATE SCHEMA rockygpt_v2;
      CREATE TABLE rockygpt_v2.dataset_versions(id uuid PRIMARY KEY,status text NOT NULL);
      CREATE TABLE rockygpt_v2.release_artifacts(dataset_version_id uuid,artifact_key text,payload jsonb,content_hash text,UNIQUE(dataset_version_id,artifact_key));
      CREATE TABLE rockygpt_v2.campus_events(dataset_version_id uuid,id uuid,starts_at timestamptz);`);
    const active = 'a0000000-0000-4000-8000-000000000001';
    const candidate = 'a0000000-0000-4000-8000-000000000002';
    const pastRow = 'b0000000-0000-4000-8000-000000000001';
    const futureRow = 'b0000000-0000-4000-8000-000000000002';
    const offices = [1, 2, 3, 4].map(n => office(n));
    const seed = registry(offices);
    const store = (dataset: string, payload: unknown) => client.query(
      `INSERT INTO rockygpt_v2.release_artifacts VALUES($1,'campus-identities',$2::jsonb,'fixture')
       ON CONFLICT (dataset_version_id,artifact_key) DO UPDATE SET payload=EXCLUDED.payload`, [dataset, JSON.stringify(payload)]);
    await client.query("INSERT INTO rockygpt_v2.dataset_versions VALUES($1,'staging')", [candidate]);
    await store(candidate, registry(offices));

    const first = await verifyIdentityContinuity(client, candidate, seed);
    assert.equal(first.baseline, 'none');

    await client.query("INSERT INTO rockygpt_v2.dataset_versions VALUES($1,'active')", [active]);
    await client.query(`INSERT INTO rockygpt_v2.campus_events VALUES($1,$2,now() - interval '1 day'),($1,$3,now() + interval '1 day')`, [active, pastRow, futureRow]);
    await store(active, registry([...offices, occurrence(1, pastRow), occurrence(2, futureRow)]));
    const report = await verifyIdentityContinuity(client, candidate, seed);
    assert.equal(report.baseline, 'active_release');
    assert.equal(report.expected_losses.past_event_occurrences, 1);
    assert.deepEqual(report.lost_by_kind, { event: 1 });
    assert.deepEqual(report.failures, []);

    await store(candidate, registry([office(1, 'facility'), ...offices.slice(1)]));
    await assert.rejects(verifyIdentityContinuity(client, candidate, seed), /identity continuity: identity .* changed kind from office to facility/);

    await store(candidate, registry(offices));
    await store(active, { schema_version: 1, entities: [{ id: 'not-a-uuid' }] });
    const incomparable = await verifyIdentityContinuity(client, candidate, seed);
    assert.equal(incomparable.baseline, 'none');
    assert.match(incomparable.baseline_note ?? '', /^The active registry is not comparable/);
  } finally { client.release(); await pool.end(); }
});
