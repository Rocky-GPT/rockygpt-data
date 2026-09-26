import 'dotenv/config';
import { Pool } from 'pg';

interface RetentionSummary {
  failedDatasetsDeleted: number;
  retiredDatasetsDeleted: number;
  sourceSnapshotsDeleted: number;
  ingestionRunsDeleted: number;
  dryRun: boolean;
}

/** Retired dataset versions kept for rollback; with daily publishes, about 3 days. */
export const RETIRED_VERSIONS_KEPT = 3;

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`rockygpt_v2.${table}`]
  );
  return result.rows[0]?.present === true;
}

export async function runDataRetention(
  pool: Pool,
  dryRun = false
): Promise<RetentionSummary> {
  let failedDatasetsDeleted = 0;
  let retiredDatasetsDeleted = 0;
  if (await tableExists(pool, 'dataset_versions')) {
    const failedSql = dryRun
      ? `SELECT count(*)::integer AS count
         FROM rockygpt_v2.dataset_versions
         WHERE status IN ('failed', 'staging', 'validating')
           AND created_at < now() - interval '7 days'`
      : `DELETE FROM rockygpt_v2.dataset_versions
         WHERE status IN ('failed', 'staging', 'validating')
           AND created_at < now() - interval '7 days'`;
    const failed = await pool.query<{ count?: number }>(failedSql);
    failedDatasetsDeleted = dryRun
      ? Number(failed.rows[0]?.count || 0)
      : Number(failed.rowCount || 0);

    // Keep the newest retired versions for rollback, and nothing older. A
    // release is several times the size it was before identities and office
    // pages, and the free database's 0.5 GB cannot hold a month of them.
    const removable = await pool.query<{ id: string }>(
      `SELECT id FROM (
         SELECT id, row_number() OVER (ORDER BY created_at DESC) AS rollback_rank
         FROM rockygpt_v2.dataset_versions
         WHERE status = 'retired'
       ) ranked
       WHERE rollback_rank > $1`,
      [RETIRED_VERSIONS_KEPT]
    );
    if (dryRun) {
      retiredDatasetsDeleted = removable.rows.length;
    } else {
      // One version per statement keeps each cascade inside the statement timeout.
      for (const { id } of removable.rows) {
        const deleted = await pool.query(
          `DELETE FROM rockygpt_v2.dataset_versions WHERE id = $1::uuid AND status = 'retired'`,
          [id]
        );
        retiredDatasetsDeleted += deleted.rowCount || 0;
      }
    }
  }

  let sourceSnapshotsDeleted = 0;
  if (
    await tableExists(pool, 'source_snapshots') &&
    await tableExists(pool, 'release_sources')
  ) {
    const sql = dryRun
      ? `SELECT count(*)::integer AS count
         FROM rockygpt_v2.source_snapshots s
         WHERE s.created_at < now() - interval '90 days'
           AND NOT EXISTS (
             SELECT 1 FROM rockygpt_v2.release_sources r WHERE r.snapshot_id = s.id
           )`
      : `DELETE FROM rockygpt_v2.source_snapshots s
         WHERE s.created_at < now() - interval '90 days'
           AND NOT EXISTS (
             SELECT 1 FROM rockygpt_v2.release_sources r WHERE r.snapshot_id = s.id
           )`;
    const result = await pool.query<{ count?: number }>(sql);
    sourceSnapshotsDeleted = dryRun
      ? Number(result.rows[0]?.count || 0)
      : Number(result.rowCount || 0);
  }

  let ingestionRunsDeleted = 0;
  if (
    await tableExists(pool, 'ingestion_runs') &&
    await tableExists(pool, 'source_snapshots')
  ) {
    const sql = dryRun
      ? `SELECT count(*)::integer AS count
         FROM rockygpt_v2.ingestion_runs r
         WHERE r.created_at < now() - interval '90 days'
           AND NOT EXISTS (
             SELECT 1 FROM rockygpt_v2.source_snapshots s WHERE s.ingestion_run_id = r.id
           )`
      : `DELETE FROM rockygpt_v2.ingestion_runs r
         WHERE r.created_at < now() - interval '90 days'
           AND NOT EXISTS (
             SELECT 1 FROM rockygpt_v2.source_snapshots s WHERE s.ingestion_run_id = r.id
           )`;
    const result = await pool.query<{ count?: number }>(sql);
    ingestionRunsDeleted = dryRun
      ? Number(result.rows[0]?.count || 0)
      : Number(result.rowCount || 0);
  }

  return {
    failedDatasetsDeleted,
    retiredDatasetsDeleted,
    sourceSnapshotsDeleted,
    ingestionRunsDeleted,
    dryRun,
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    statement_timeout: 60_000,
    application_name: 'rockygpt-data-retention',
  });
  try {
    const summary = await runDataRetention(pool, dryRun);
    console.log(`[data-retention] ${dryRun ? 'Dry run' : 'Completed'}: ${JSON.stringify(summary)}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('data-retention.ts')) {
  void main().catch((error: unknown) => {
    console.error(`[data-retention] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
