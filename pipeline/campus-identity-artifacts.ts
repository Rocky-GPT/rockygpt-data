import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CampusIdentities } from '../src/data-v2/campus-identities';
import { catalogConvenersArtifact, compileCampusIdentities, loadIdentitySnapshot } from '../src/data-v2/compile-campus-identities';

/** Install only against a fully populated inactive candidate in its publisher
 * transaction. ON CONFLICT makes safe staging retries/repeated compilation
 * idempotent. This function never activates a dataset or changes source rows. */
export async function insertCampusIdentityArtifacts(client: Pick<PoolClient, 'query'>, datasetId: string, seed: CampusIdentities, rawPrograms: unknown): Promise<{ count: number; coverage: ReturnType<typeof compileCampusIdentities>['report'] }> {
  const dataset = await client.query('SELECT status FROM rockygpt_v2.dataset_versions WHERE id=$1::uuid FOR UPDATE', [datasetId]);
  if (!['staging', 'validating'].includes(dataset.rows[0]?.status)) {
    throw new Error('Campus identity artifacts may only be installed in a staging or validating dataset.');
  }
  const snapshot = await loadIdentitySnapshot(client, datasetId);
  const result = compileCampusIdentities(seed, snapshot, rawPrograms);
  for (const [key, payload] of Object.entries({
    'campus-identities': result.registry,
    'campus-identity-coverage': result.report,
    'catalog-conveners': catalogConvenersArtifact(rawPrograms),
  })) {
    const content = JSON.stringify(payload);
    await client.query(`INSERT INTO rockygpt_v2.release_artifacts (dataset_version_id,artifact_key,payload,content_hash)
      VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (dataset_version_id,artifact_key)
      DO UPDATE SET payload=EXCLUDED.payload,content_hash=EXCLUDED.content_hash`,
    [datasetId, key, content, crypto.createHash('sha256').update(content).digest('hex')]);
  }
  return { count: 3, coverage: result.report };
}
