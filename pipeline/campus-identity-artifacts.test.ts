import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { insertCampusIdentityArtifacts } from './campus-identity-artifacts';
import type { CampusIdentities } from '../src/data-v2/campus-identities';

const connection = process.env.IDENTITY_TEST_DATABASE_URL;
test('PostgreSQL staged publishing is repeatable, refreshes links and refuses active mutation', { skip: !connection }, async () => {
  const url = new URL(connection!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/rockygpt_profiles_dev_publish_test/);
  const pool = new Pool({ connectionString: connection, max: 1 });
  const client = await pool.connect();
  try {
    // Dedicated newly-created test database; no existing schema/data is removed.
    await client.query(`CREATE SCHEMA rockygpt_v2;
      CREATE TABLE rockygpt_v2.dataset_versions(id uuid PRIMARY KEY,status text NOT NULL);
      CREATE TABLE rockygpt_v2.sources(id uuid PRIMARY KEY,source_key text NOT NULL);
      CREATE TABLE rockygpt_v2.release_artifacts(dataset_version_id uuid,artifact_key text,payload jsonb,content_hash text,UNIQUE(dataset_version_id,artifact_key));`);
    for (const table of ['campus_contacts', 'campus_hours', 'dining_hours', 'menu_items', 'programs']) {
      await client.query(`CREATE TABLE rockygpt_v2.${table}(dataset_version_id uuid,source_id uuid,source_record_key text,name text,email text,day text);`);
    }
    const dataset = 'c73aec42-b34c-4f43-9e06-4b565b3163d3';
    const source = '5e9a20f1-d3b9-44e8-a8b6-ae9f60503d97';
    await client.query("INSERT INTO rockygpt_v2.dataset_versions VALUES($1,'staging')", [dataset]);
    await client.query("INSERT INTO rockygpt_v2.sources VALUES($1,'campus-hours')", [source]);
    await client.query("INSERT INTO rockygpt_v2.campus_hours VALUES($1,$2,'Reviewed Office:Monday','Reviewed Office',NULL,'Monday')", [dataset, source]);
    const seed: CampusIdentities = { schema_version: 1, entities: [{
      id: '9f4a8a53-67a1-4ce4-b4da-5d19630f135b', kind: 'office', name: 'Reviewed Office', aliases: [], links: [{ collection: 'campus_hours', source_key: 'campus-hours', source_record_keys: [], selector: { field: 'name', values: ['Reviewed Office'], evidence: 'Reviewed office schedule subject' } }],
    }] };
    const publish = async () => {
      await client.query('BEGIN');
      try { const result = await insertCampusIdentityArtifacts(client, dataset, seed, { programs: [] }); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    };
    await publish();
    const first = await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key');
    await publish();
    assert.deepEqual((await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key')).rows, first.rows);
    assert.equal(first.rows.length, 3);
    await client.query("INSERT INTO rockygpt_v2.campus_hours VALUES($1,$2,'Reviewed Office:Tuesday:new-exception','Reviewed Office',NULL,'Tuesday')", [dataset, source]);
    await publish();
    const refreshed = await client.query("SELECT payload FROM rockygpt_v2.release_artifacts WHERE artifact_key='campus-identities'");
    assert.equal(refreshed.rows[0].payload.entities[0].id, seed.entities[0].id);
    assert.deepEqual(refreshed.rows[0].payload.entities[0].links[0].source_record_keys, ['Reviewed Office:Monday', 'Reviewed Office:Tuesday:new-exception']);
    assert.equal(Number((await client.query('SELECT count(*) AS n FROM rockygpt_v2.release_artifacts')).rows[0].n), 3);
    await client.query("UPDATE rockygpt_v2.dataset_versions SET status='active' WHERE id=$1", [dataset]);
    const before = await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key');
    await assert.rejects(publish, /only be installed in a staging or validating dataset/);
    assert.deepEqual((await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key')).rows, before.rows);
  } finally { client.release(); await pool.end(); }
});
