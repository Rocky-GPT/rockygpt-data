import 'dotenv/config';
import { Pool } from 'pg';

interface RetentionSummary {
  failedDatasetsDeleted: number;
  retiredDatasetsDeleted: number;
  sourceSnapshotsDeleted: number;
  ingestionRunsDeleted: number;
  ledgerOperationsDeleted: number;
  ledgerTurnsDeleted: number;
  /** pg_database_size after cleanup; the free Neon plan stops writes at 0.5 GB. */
  databaseBytes: number;
  dryRun: boolean;
}

/**
 * Retired dataset versions kept for rollback. A release is about 105 MB (28,500 document chunks,
 * office sections, artifacts and a 10 MB meaning index), so on the free 0.5 GB database the
 * active release and one backup are all that fit with room to grow: on 2026-11-02 the active
 * release, three retired ones and a failed one filled 569 of 674 MB.
 */
export const RETIRED_VERSIONS_KEPT = 1;

/** A publish takes under an hour; a version still staging or validating a day later was abandoned. */
const ABANDONED_AFTER = '1 day';

/**
 * Settled Brain spending-ledger rows older than this are history only: the monthly cap reads the
 * current month's settled rows and every unsettled one, which are never deleted here.
 */
const LEDGER_KEPT = '60 days';
const LEDGER_BATCH = 5000;

async function tableExists(pool: Pool, table: string, schema = 'rockygpt_v2'): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`${schema}.${table}`]
  );
  return result.rows[0]?.present === true;
}

/** Deletes the rows `where` selects, a batch per statement so each stays inside the timeout. */
async function deleteInBatches(
  pool: Pool,
  table: string,
  where: string,
  dryRun: boolean
): Promise<number> {
  if (dryRun) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM ${table} WHERE ${where}`
    );
    return Number(result.rows[0]?.count || 0);
  }
  let deleted = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${LEDGER_BATCH})`
    );
    deleted += result.rowCount || 0;
    if ((result.rowCount || 0) < LEDGER_BATCH) return deleted;
  }
}

export async function runDataRetention(
  pool: Pool,
  dryRun = false
): Promise<RetentionSummary> {
  let failedDatasetsDeleted = 0;
  let retiredDatasetsDeleted = 0;
  if (await tableExists(pool, 'dataset_versions')) {
    // A failed publish is never used again but holds a full copy of the release, so it goes
    // at once; a staging or validating one goes once it is clearly abandoned.
    const failed = await pool.query<{ id: string }>(
      `SELECT id FROM rockygpt_v2.dataset_versions
       WHERE status = 'failed'
          OR (status IN ('staging', 'validating') AND created_at < now() - interval '${ABANDONED_AFTER}')`
    );
    if (dryRun) {
      failedDatasetsDeleted = failed.rows.length;
    } else {
      for (const { id } of failed.rows) {
        const deleted = await pool.query(
          `DELETE FROM rockygpt_v2.dataset_versions
           WHERE id = $1::uuid
             AND (status = 'failed'
                  OR (status IN ('staging', 'validating') AND created_at < now() - interval '${ABANDONED_AFTER}'))`,
          [id]
        );
        failedDatasetsDeleted += deleted.rowCount || 0;
      }
    }

    // Keep the newest retired version for rollback, and nothing older.
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

  // The Brain's spending ledger shares this database and gains a row per model call; October
  // 2026 alone added 45 MB. Only settled rows past the window go; reserved and uncertain rows
  // still count against the cap and stay.
  let ledgerOperationsDeleted = 0;
  if (await tableExists(pool, 'operations', 'brain_ops')) {
    ledgerOperationsDeleted = await deleteInBatches(
      pool,
      'brain_ops.operations',
      `state = 'settled' AND created_at < now() - interval '${LEDGER_KEPT}'`,
      dryRun
    );
  }
  let ledgerTurnsDeleted = 0;
  if (await tableExists(pool, 'turns', 'brain_ops')) {
    ledgerTurnsDeleted = await deleteInBatches(
      pool,
      'brain_ops.turns',
      `created_at < now() - interval '${LEDGER_KEPT}'`,
      dryRun
    );
  }

  const size = await pool.query<{ bytes: string }>(
    `SELECT pg_database_size(current_database())::text AS bytes`
  );

  return {
    failedDatasetsDeleted,
    retiredDatasetsDeleted,
    sourceSnapshotsDeleted,
    ingestionRunsDeleted,
    ledgerOperationsDeleted,
    ledgerTurnsDeleted,
    databaseBytes: Number(size.rows[0]?.bytes || 0),
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
