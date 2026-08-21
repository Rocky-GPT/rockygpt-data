import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { packageAsset } from '../../src/paths';

export async function applyDatabaseSchema(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Publication and explicit schema jobs can start together after a deploy.
    // Serialize them at the database session level so a numbered migration is
    // never applied twice by competing processes.
    await client.query(`SELECT pg_advisory_lock(hashtext('rockygpt_v2_schema_migrations'))`);
    const schema = fs.readFileSync(packageAsset('data-v2/schema.sql'), 'utf8');
    await client.query(schema);

    const directory = packageAsset('data-v2/migrations');
    const migrations = fs.existsSync(directory)
      ? fs.readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
      : [];
    for (const version of migrations) {
      const exists = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM rockygpt_v2.schema_migrations WHERE version = $1
         ) AS present`,
        [version]
      );
      if (exists.rows[0]?.present) continue;

      const sql = fs.readFileSync(path.join(directory, version), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO rockygpt_v2.schema_migrations (version) VALUES ($1)`,
          [version]
        );
        await client.query('COMMIT');
        applied.push(version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('rockygpt_v2_schema_migrations'))`)
      .catch(() => undefined);
    client.release();
  }
  return applied;
}
