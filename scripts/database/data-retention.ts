import 'dotenv/config';
import { Pool } from 'pg';
import { maintainFeedbackRetention } from './feedback-retention';

interface RetentionSummary {
  feedbackDeleted: number;
  failedDatasetsDeleted: number;
  retiredDatasetsDeleted: number;
  sourceSnapshotsDeleted: number;
  ingestionRunsDeleted: number;
  dryRun: boolean;
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`rockygpt_v2.${table}`]
  );
  return result.rows[0]?.present === true;
}

async function tableHasColumn(
  pool: Pool,
  table: string,
  column: string
): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'rockygpt_v2' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column]
  );
  return result.rows[0]?.present === true;
}

export async function runDataRetention(
  pool: Pool,
  dryRun = false
): Promise<RetentionSummary> {
  const feedback = await maintainFeedbackRetention(
    (sql, values) => pool.query(sql, values),
    { dryRun }
  );

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

    // Always preserve the ten newest retired versions. Older rollback
    // payloads are removed only after they are also at least 30 days old.
    const retiredSql = dryRun
      ? `WITH ranked AS (
           SELECT id, created_at,
                  row_number() OVER (ORDER BY created_at DESC) AS rollback_rank
           FROM rockygpt_v2.dataset_versions
           WHERE status = 'retired'
         ), removable AS (
           SELECT id FROM ranked
           WHERE rollback_rank > 10 AND created_at < now() - interval '30 days'
         ) SELECT count(*)::integer AS count FROM removable`
      : `WITH ranked AS (
           SELECT id, created_at,
                  row_number() OVER (ORDER BY created_at DESC) AS rollback_rank
           FROM rockygpt_v2.dataset_versions
           WHERE status = 'retired'
         ), removable AS (
           SELECT id FROM ranked
           WHERE rollback_rank > 10 AND created_at < now() - interval '30 days'
         ) DELETE FROM rockygpt_v2.dataset_versions
           WHERE id IN (SELECT id FROM removable)`;
    const retired = await pool.query<{ count?: number }>(retiredSql);
    retiredDatasetsDeleted = dryRun
      ? Number(retired.rows[0]?.count || 0)
      : Number(retired.rowCount || 0);
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
    feedbackDeleted:
      feedback.status === 'completed'
        ? feedback.deletedRows
        : feedback.status === 'dry-run'
          ? feedback.expiredRows
          : 0,
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
