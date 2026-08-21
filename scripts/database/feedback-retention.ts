import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const RETENTION_SCHEMA = 'rockygpt_v2';
const EXPIRY_COLUMN = 'expires_at';

/**
 * Tables holding user-derived feedback on a retention clock.
 * Internal literals, never user input.
 */
export const RETENTION_TABLES = ['feedback'] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

const SCHEMA_CHECK_SQL = `
  SELECT
    EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) AS table_exists,
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
    ) AS expires_at_exists
`;

function expiredCountSql(table: RetentionTable): string {
  return `
  SELECT count(*)::integer AS expired_count
  FROM ${RETENTION_SCHEMA}.${table}
  WHERE ${EXPIRY_COLUMN} <= CURRENT_TIMESTAMP
`;
}

function deleteExpiredSql(table: RetentionTable): string {
  return `
  DELETE FROM ${RETENTION_SCHEMA}.${table}
  WHERE ${EXPIRY_COLUMN} <= CURRENT_TIMESTAMP
`;
}

interface QueryResultLike {
  rows: unknown[];
  rowCount: number | null;
}

export type FeedbackRetentionQuery = (sql: string, values?: unknown[]) => Promise<QueryResultLike>;

export type FeedbackRetentionResult =
  | {
      status: 'completed';
      deletedRows: number;
      dryRun: false;
    }
  | {
      status: 'dry-run';
      expiredRows: number;
      dryRun: true;
    }
  | {
      status: 'skipped';
      reason: 'table-missing';
      dryRun: boolean;
    }
  | {
      status: 'blocked';
      reason: 'expires-at-missing';
      dryRun: boolean;
    };

interface FeedbackRetentionOptions {
  dryRun?: boolean;
}

interface SchemaStateRow {
  table_exists?: unknown;
  expires_at_exists?: unknown;
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}

function expiredRowCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Database returned an invalid expired row count.');
  }
  return count;
}

function deletedRowCount(value: number | null): number {
  if (!Number.isSafeInteger(value) || value === null || value < 0) {
    throw new Error('Database did not report a valid deleted row count.');
  }
  return value;
}

/**
 * Applies one table's retention rule without coupling cleanup to user
 * requests. Older databases are inspected before any statement references
 * `expires_at`.
 */
export async function maintainTableRetention(
  query: FeedbackRetentionQuery,
  table: RetentionTable,
  options: FeedbackRetentionOptions = {}
): Promise<FeedbackRetentionResult> {
  const dryRun = options.dryRun ?? false;
  const inspection = await query(SCHEMA_CHECK_SQL, [RETENTION_SCHEMA, table, EXPIRY_COLUMN]);
  const state = inspection.rows[0] as SchemaStateRow | undefined;
  if (!state) throw new Error('Database did not return retention schema inspection state.');

  if (!databaseBoolean(state.table_exists)) {
    return { status: 'skipped', reason: 'table-missing', dryRun };
  }

  if (!databaseBoolean(state.expires_at_exists)) {
    return { status: 'blocked', reason: 'expires-at-missing', dryRun };
  }

  if (dryRun) {
    const countResult = await query(expiredCountSql(table));
    const countRow = countResult.rows[0] as { expired_count?: unknown } | undefined;
    return {
      status: 'dry-run',
      expiredRows: expiredRowCount(countRow?.expired_count),
      dryRun: true,
    };
  }

  const deletion = await query(deleteExpiredSql(table));
  return {
    status: 'completed',
    deletedRows: deletedRowCount(deletion.rowCount),
    dryRun: false,
  };
}

/** Backwards-compatible entry point for the feedback table. */
export async function maintainFeedbackRetention(
  query: FeedbackRetentionQuery,
  options: FeedbackRetentionOptions = {}
): Promise<FeedbackRetentionResult> {
  return maintainTableRetention(query, 'feedback', options);
}

export async function maintainTranscriptRetention(
  _query: FeedbackRetentionQuery,
  options: FeedbackRetentionOptions = {}
): Promise<FeedbackRetentionResult> {
  return { status: 'skipped', reason: 'table-missing', dryRun: options.dryRun ?? false };
}

export function formatRetentionResult(
  result: FeedbackRetentionResult,
  table: RetentionTable
): string {
  const qualified = `${RETENTION_SCHEMA}.${table}`;
  if (result.status === 'completed') {
    return `[retention] ${qualified}: deleted ${result.deletedRows} expired row${result.deletedRows === 1 ? '' : 's'}.`;
  }
  if (result.status === 'dry-run') {
    return `[retention] ${qualified}: dry run — ${result.expiredRows} expired row${result.expiredRows === 1 ? '' : 's'} would be deleted.`;
  }
  if (result.status === 'skipped') {
    return `[retention] ${qualified}: skipped — the table does not exist, so there is nothing to delete.`;
  }
  return `[retention] ${qualified}: blocked — the table exists without expires_at. No rows were deleted. Run \`npm run data:schema\`, then retry.`;
}

export function formatFeedbackRetentionResult(result: FeedbackRetentionResult): string {
  return formatRetentionResult(result, 'feedback');
}

function parseOptions(args: string[]): FeedbackRetentionOptions {
  const unknown = args.filter((argument) => argument !== '--dry-run');
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown.join(', ')}. Supported option: --dry-run.`);
  }
  return { dryRun: args.includes('--dry-run') };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. No cleanup was attempted.');
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: 'rockygpt-retention',
  });

  try {
    let blocked = false;
    for (const table of RETENTION_TABLES) {
      const result = await maintainTableRetention(
        (sql, values) => pool.query(sql, values),
        table,
        options
      );
      const output = formatRetentionResult(result, table);
      if (result.status === 'blocked') {
        blocked = true;
        console.error(output);
      } else {
        console.log(output);
      }
    }
    if (blocked) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    console.error(
      `[retention] Failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
