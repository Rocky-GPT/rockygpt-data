import 'dotenv/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const PUBLIC_TABLES = [
  'dataset_versions',
  'sources',
  'ingestion_runs',
  'source_snapshots',
  'releases',
  'release_sources',
  'source_runs',
  'critical_facts',
  'campus_contacts',
  'campus_hours',
  'dining_hours',
  'menu_items',
  'shuttle_routes',
  'shuttle_trips',
  'academic_dates',
  'campus_events',
  'clubs',
  'programs',
  'documents',
  'document_chunks',
  'release_artifacts',
] as const;

const EXPECTED_SOURCE_ROLE = 'rockygpt_staging_sync';
const BATCH_SIZE = 100;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function assertSafeSource(source: PoolClient): Promise<void> {
  const identity = await source.query<{ current_user: string }>('SELECT current_user');
  if (identity.rows[0]?.current_user !== EXPECTED_SOURCE_ROLE) {
    throw new Error(`SOURCE_DATABASE_URL must authenticate as ${EXPECTED_SOURCE_ROLE}.`);
  }

  const permissions = await source.query<{ table_name: string; can_select: boolean }>(
    `SELECT table_name,
            has_table_privilege(current_user, format('rockygpt_v2.%I', table_name), 'SELECT') AS can_select
       FROM unnest($1::text[]) AS table_name`,
    [PUBLIC_TABLES]
  );
  const denied = permissions.rows.filter((row) => !row.can_select).map((row) => row.table_name);
  if (denied.length > 0) {
    throw new Error(`The staging sync role cannot read required public tables: ${denied.join(', ')}.`);
  }

  const privateAccess = await source.query<{ can_select: boolean }>(
    `SELECT has_table_privilege(current_user, 'rockygpt_v2.feedback', 'SELECT') AS can_select`
  );
  if (privateAccess.rows[0]?.can_select) {
    throw new Error('The staging sync role must not have SELECT access to rockygpt_v2.feedback.');
  }
}

async function insertBatch(
  destination: PoolClient,
  table: string,
  columns: string[],
  rows: QueryResultRow[]
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(row[column]);
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const columnList = columns.map(quoteIdentifier).join(', ');
  await destination.query(
    `INSERT INTO rockygpt_v2.${quoteIdentifier(table)} (${columnList}) VALUES ${tuples.join(', ')}`,
    values
  );
}

async function copyTable(source: PoolClient, destination: PoolClient, table: string): Promise<number> {
  const columnResult = await destination.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'rockygpt_v2'
        AND table_name = $1
        AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table]
  );
  const columns = columnResult.rows.map((row) => row.column_name);
  if (columns.length === 0) throw new Error(`Destination table rockygpt_v2.${table} is missing.`);

  const columnList = columns.map(quoteIdentifier).join(', ');
  let offset = 0;
  for (;;) {
    const result = await source.query(
      `SELECT ${columnList}
         FROM rockygpt_v2.${quoteIdentifier(table)}
        ORDER BY ${columnList}
        LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    );
    if (result.rows.length === 0) break;
    await insertBatch(destination, table, columns, result.rows);
    offset += result.rows.length;
    if (result.rows.length < BATCH_SIZE) break;
  }
  return offset;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const destinationUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL is required.');
  if (!destinationUrl) throw new Error('DATABASE_URL is required.');
  if (process.env.ALLOW_STAGING_DATABASE_RESET !== '1') {
    throw new Error('Set ALLOW_STAGING_DATABASE_RESET=1 to confirm the staging-only replacement.');
  }
  if (sourceUrl === destinationUrl) throw new Error('Source and destination databases must be different.');

  const sourcePool = new Pool({ connectionString: sourceUrl, max: 1 });
  const destinationPool = new Pool({ connectionString: destinationUrl, max: 1 });
  const source = await sourcePool.connect();
  const destination = await destinationPool.connect();

  try {
    await assertSafeSource(source);
    await destination.query('BEGIN');
    const tables = PUBLIC_TABLES.map((table) => `rockygpt_v2.${quoteIdentifier(table)}`).join(', ');
    await destination.query(`TRUNCATE ${tables}`);

    let total = 0;
    for (const table of PUBLIC_TABLES) {
      const count = await copyTable(source, destination, table);
      total += count;
      console.log(`Copied ${count} rows into rockygpt_v2.${table}.`);
    }
    await destination.query('COMMIT');
    console.log(`Staging public-data sync complete (${total} rows).`);
  } catch (error) {
    await destination.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    source.release();
    destination.release();
    await Promise.all([sourcePool.end(), destinationPool.end()]);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
