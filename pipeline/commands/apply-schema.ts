import 'dotenv/config';
import { Pool } from 'pg';
import { applyDatabaseSchema } from '../database/migrations';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const migrations = await applyDatabaseSchema(pool);
    console.log(
      `Applied RockyGPT v2 database schema${migrations.length ? ` and migrations: ${migrations.join(', ')}` : '.'}`
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
