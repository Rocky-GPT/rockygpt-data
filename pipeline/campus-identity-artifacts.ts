import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { validateCampusIdentities, type CampusIdentities } from '../src/data-v2/campus-identities';
import { catalogConvenersArtifact, compileCampusIdentities, loadIdentitySnapshot, type IdentityInputs } from '../src/data-v2/compile-campus-identities';
import { compareIdentityRegistries, type IdentityContinuityReport } from '../src/data-v2/identity-continuity';

/** Install only against a fully populated inactive candidate in its publisher
 * transaction. ON CONFLICT makes safe staging retries/repeated compilation
 * idempotent. This function never activates a dataset or changes source rows. */
export async function insertCampusIdentityArtifacts(client: Pick<PoolClient, 'query'>, datasetId: string, seed: CampusIdentities, rawPrograms: unknown, inputs: IdentityInputs = {}): Promise<{ count: number; coverage: ReturnType<typeof compileCampusIdentities>['report'] }> {
  const dataset = await client.query('SELECT status FROM rockygpt_v2.dataset_versions WHERE id=$1::uuid FOR UPDATE', [datasetId]);
  if (!['staging', 'validating'].includes(dataset.rows[0]?.status)) {
    throw new Error('Campus identity artifacts may only be installed in a staging or validating dataset.');
  }
  const snapshot = await loadIdentitySnapshot(client, datasetId);
  const result = compileCampusIdentities(seed, snapshot, rawPrograms, inputs);
  for (const [key, payload] of Object.entries({
    'campus-identities': result.registry,
    'campus-identity-coverage': result.report,
    'catalog-conveners': catalogConvenersArtifact(rawPrograms),
    'event-organizers': result.eventOrganizers,
    'catalog-course-identities': result.courseIdentities,
    'program-requirement-groups': result.requirementGroups,
    'campus-buildings': result.campusBuildings,
  })) {
    const content = JSON.stringify(payload);
    await client.query(`INSERT INTO rockygpt_v2.release_artifacts (dataset_version_id,artifact_key,payload,content_hash)
      VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (dataset_version_id,artifact_key)
      DO UPDATE SET payload=EXCLUDED.payload,content_hash=EXCLUDED.content_hash`,
    [datasetId, key, content, crypto.createHash('sha256').update(content).digest('hex')]);
  }
  return { count: 7, coverage: result.report };
}

/** Compare the committed candidate's registry with the active release's before
 * activation. Fails the publish when identities or relationships disappear
 * beyond the tolerated churn; the report goes into the release quality summary. */
export async function verifyIdentityContinuity(client: Pick<PoolClient, 'query'>, datasetId: string, seed: CampusIdentities): Promise<IdentityContinuityReport> {
  const candidateRows = await client.query(
    "SELECT payload FROM rockygpt_v2.release_artifacts WHERE dataset_version_id=$1::uuid AND artifact_key='campus-identities'", [datasetId]);
  if (!candidateRows.rows[0]?.payload) throw new Error('Staging verification failed: the candidate has no campus-identities artifact.');
  const candidate: unknown = candidateRows.rows[0].payload;
  validateCampusIdentities(candidate);
  const activeRows = await client.query(
    `SELECT v.id::text AS id, a.payload FROM rockygpt_v2.dataset_versions v
     LEFT JOIN rockygpt_v2.release_artifacts a ON a.dataset_version_id=v.id AND a.artifact_key='campus-identities'
     WHERE v.status='active'`);
  const active = activeRows.rows[0] as { id: string; payload: unknown } | undefined;
  // A release published before identities existed has no baseline to compare.
  // An old registry that fails today's validator must not block a valid release.
  let previous: CampusIdentities | null = null;
  let baselineNote: string | undefined;
  if (active?.payload) {
    try {
      validateCampusIdentities(active.payload);
      previous = active.payload;
    } catch (error) {
      baselineNote = `The active registry is not comparable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const pastEventIds = new Set<string>();
  if (previous !== null && active) {
    const events = previous.entities.filter(entity => entity.kind === 'event');
    const rowIds = events.flatMap(entity => entity.links.flatMap(link => link.source_record_ids || []));
    if (rowIds.length) {
      const started = await client.query(
        'SELECT id::text AS id FROM rockygpt_v2.campus_events WHERE dataset_version_id=$1::uuid AND id=ANY($2::uuid[]) AND starts_at < now()',
        [active.id, rowIds]);
      const startedIds = new Set(started.rows.map((row: { id: string }) => row.id));
      for (const entity of events) {
        const ids = entity.links.flatMap(link => link.source_record_ids || []);
        if (ids.length && ids.every(id => startedIds.has(id))) pastEventIds.add(entity.id);
      }
    }
  }
  const report = compareIdentityRegistries(previous, candidate, seed, pastEventIds);
  if (baselineNote) report.baseline_note = baselineNote;
  if (report.failures.length) {
    throw new Error(`Staging verification failed: identity continuity: ${report.failures.join('; ')}.`);
  }
  return report;
}
