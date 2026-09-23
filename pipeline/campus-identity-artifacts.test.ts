import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { insertCampusIdentityArtifacts, verifyIdentityContinuity } from './campus-identity-artifacts';
import type { CampusIdentities } from '../src/data-v2/campus-identities';
import { subjectIdentityId } from '../src/data-v2/course-subjects';

test('continuity uses actual candidate courses when accepting source-inactive exclusions', async () => {
  const seed: CampusIdentities = { schema_version: 1, entities: [] };
  const original: CampusIdentities['entities'][number] = { id: subjectIdentityId('TEST'), kind: 'subject', name: 'TEST', aliases: [],
    links: [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: ['TEST'] }],
    relationships: [101, 102, 103].map(number => ({ type: 'includes_course',
      target_record: { collection: 'courses', source_key: 'academic-programs', source_record_key: `TEST ${number}` },
      evidence: [{ collection: 'courses', source_key: 'academic-programs', source_record_key: `TEST ${number}`, field: 'code' }],
    })),
  };
  const prior = { schema_version: 1, entities: [original] };
  const candidate = { schema_version: 1, entities: [{ ...original, relationships: [] }] };
  const catalog = { scrapedAt: '2026-09-23T19:44:12.134Z', courses: [101, 102, 103].map(number => ({ code: `TEST${number}`, status: 'Inactive' })) };
  const client = (courses: unknown) => ({ query: async (sql: string) => {
    if (sql.includes("WHERE v.status='active'")) return { rows: [{ id: 'prior', payload: prior }] };
    if (sql.includes("artifact_key='campus-identities'")) return { rows: [{ payload: candidate }] };
    if (sql.includes("artifact_key='courses'")) return { rows: courses === undefined ? [] : [{ payload: courses }] };
    if (sql.includes("artifact_key='catalog-conveners'")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } }) as unknown as Pick<PoolClient, 'query'>;
  const report = await verifyIdentityContinuity(client({}), 'candidate', seed, { catalog });
  assert.equal(report.expected_relationship_losses_by_type.includes_course, 3);
  await assert.rejects(verifyIdentityContinuity(client(undefined), 'candidate', seed, { catalog }), /3 of 3 includes_course/);
  await assert.rejects(verifyIdentityContinuity(client({ 'TEST 101': {}, 'TEST 102': {}, 'TEST 103': {} }), 'candidate', seed, { catalog }), /3 of 3 includes_course/);
});

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
    await client.query(`CREATE TABLE rockygpt_v2.clubs(dataset_version_id uuid,source_id uuid,source_record_key text,id uuid,name text,category text,website_url text);
      CREATE TABLE rockygpt_v2.campus_events(dataset_version_id uuid,source_id uuid,source_record_key text,id uuid,title text,starts_at timestamptz,organizer text,event_url text);`);
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
      try { const result = await insertCampusIdentityArtifacts(client, dataset, seed, { programs: [] }, { eventDetails: { pages: [{
        url: 'https://archway.ramapo.edu/test/rsvp_boot?id=992', statusCode: 200, fetchedAt: '2026-09-22T19:00:00Z',
        archwayOrganizers: [{ groupId: '991', groupUrl: 'https://archway.ramapo.edu/test/', name: 'Test Club' }],
      }] } }); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    };
    await publish();
    const first = await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key');
    await publish();
    assert.deepEqual((await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key')).rows, first.rows);
    assert.equal(first.rows.length, 9);
    await client.query("INSERT INTO rockygpt_v2.campus_hours VALUES($1,$2,'Reviewed Office:Tuesday:new-exception','Reviewed Office',NULL,'Tuesday')", [dataset, source]);
    await publish();
    const refreshed = await client.query("SELECT payload FROM rockygpt_v2.release_artifacts WHERE artifact_key='campus-identities'");
    assert.equal(refreshed.rows[0].payload.entities[0].id, seed.entities[0].id);
    assert.deepEqual(refreshed.rows[0].payload.entities[0].links[0].source_record_keys, ['Reviewed Office:Monday', 'Reviewed Office:Tuesday:new-exception']);
    assert.equal(Number((await client.query('SELECT count(*) AS n FROM rockygpt_v2.release_artifacts')).rows[0].n), 9);
    const clubSource = 'e176c025-897a-4b96-a2f8-d93c095123e1';
    const eventSource = 'e176c025-897a-4b96-a2f8-d93c095123e2';
    await client.query("INSERT INTO rockygpt_v2.sources VALUES($1,'archway-clubs'),($2,'archway-events')", [clubSource, eventSource]);
    await client.query("INSERT INTO rockygpt_v2.clubs VALUES($1,$2,'Test Club','31877c21-cbb6-417d-9f9f-f6a7852d3121','Test Club','Student Organization','https://archway.ramapo.edu/test/')", [dataset, clubSource]);
    await client.query("INSERT INTO rockygpt_v2.release_artifacts VALUES($1,'clubs',$2::jsonb,'fixture')", [dataset, JSON.stringify([{ name: 'Test Club', clubId: '991', websiteUrl: 'https://archway.ramapo.edu/test/' }])]);
    await client.query(`INSERT INTO rockygpt_v2.campus_events VALUES
      ($1,$2,'Sep 21:Meeting','31877c21-cbb6-417d-9f9f-f6a7852d3122','Meeting','2026-09-21T18:00:00Z','Test Club','https://archway.ramapo.edu/rsvp_boot?id=992'),
      ($1,$2,'Sep 21:Meeting','31877c21-cbb6-417d-9f9f-f6a7852d3123','Meeting','2026-09-21T19:00:00Z','Test Club','https://archway.ramapo.edu/rsvp_boot?id=993')`, [dataset, eventSource]);
    await publish();
    const expanded = (await client.query("SELECT payload FROM rockygpt_v2.release_artifacts WHERE artifact_key='campus-identities'")).rows[0].payload;
    assert.equal(expanded.entities.length, 4);
    const originalEvent = expanded.entities.find((e: { kind: string; links: { source_record_ids?: string[] }[] }) => e.kind === 'event' && e.links[0].source_record_ids?.includes('31877c21-cbb6-417d-9f9f-f6a7852d3122'));
    assert.ok(originalEvent);
    assert.equal(originalEvent.relationships[0].type, 'organized_by');
    const storedOrganizers = (await client.query("SELECT payload FROM rockygpt_v2.release_artifacts WHERE artifact_key='event-organizers'")).rows[0].payload;
    assert.equal(storedOrganizers.events.length, 1);
    assert.equal(storedOrganizers.events[0].organizer_group_id, '991');
    assert.equal(storedOrganizers.events[0].source_record_id, '31877c21-cbb6-417d-9f9f-f6a7852d3122');
    assert.equal(storedOrganizers.events[0].collected_at, '2026-09-22T19:00:00Z');
    await client.query("UPDATE rockygpt_v2.campus_events SET id='31877c21-cbb6-417d-9f9f-f6a7852d3124',title='Renamed Meeting',source_record_key='Oct 1:Renamed Meeting',starts_at='2026-10-01T18:00:00Z' WHERE event_url='https://archway.ramapo.edu/rsvp_boot?id=992'");
    await publish();
    const latest = (await client.query("SELECT payload FROM rockygpt_v2.release_artifacts WHERE artifact_key='campus-identities'")).rows[0].payload;
    const renamed = latest.entities.find((e: { id: string }) => e.id === originalEvent.id);
    assert.equal(renamed.name, 'Renamed Meeting (2026-10-01)');
    assert.deepEqual(renamed.links[0].source_record_ids, ['31877c21-cbb6-417d-9f9f-f6a7852d3124']);
    const repeated = await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key');
    await publish();
    assert.deepEqual((await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key')).rows, repeated.rows);
    assert.equal(repeated.rows.length, 10); // Nine identity artifacts plus original clubs.
    await client.query("UPDATE rockygpt_v2.dataset_versions SET status='active' WHERE id=$1", [dataset]);
    const before = await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key');
    await assert.rejects(publish, /only be installed in a staging or validating dataset/);
    assert.deepEqual((await client.query('SELECT artifact_key,content_hash FROM rockygpt_v2.release_artifacts ORDER BY artifact_key')).rows, before.rows);
  } finally { client.release(); await pool.end(); }
});
