/** Add structured intervals to the active release without changing source schedules or IDs. */
import 'dotenv/config';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { Pool } from 'pg';
import { normalizeOpeningHours } from '../src/data-v2/opening-hours';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const backup = option('--backup');
  const report = option('--report');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (apply && !backup) throw new Error('--apply requires --backup <new-file.json>.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('rockygpt_v2_schema_migrations'))");
    const releases = await client.query(`SELECT id, version FROM rockygpt_v2.dataset_versions WHERE status='active'${apply ? ' FOR UPDATE' : ''}`);
    if (releases.rows.length !== 1) throw new Error('Expected one active release.');
    const dataset = releases.rows[0];
    const { rows } = await client.query(`SELECT * FROM rockygpt_v2.campus_hours WHERE dataset_version_id=$1 ORDER BY id${apply ? ' FOR UPDATE' : ''}`, [dataset.id]);
    if (!rows.length) throw new Error('No campus-hours records in the active release.');
    if (new Set(rows.map(r => JSON.stringify([r.name, r.day]))).size !== rows.length) throw new Error('Duplicate facility/day entries require review.');
    const normalized = rows.map(row => ({ id: row.id, name: row.name, day: row.day, hours: normalizeOpeningHours(row.schedule) }));
    const changed = normalized.filter((row, index) => !isDeepStrictEqual(row.hours, rows[index].hours ?? null)).length;
    if (apply) {
      fs.writeFileSync(path.resolve(backup!), JSON.stringify({ dataset, records: rows }, null, 2), { mode: 0o600, flag: 'wx' });
      const version = '019_campus_opening_intervals.sql';
      const existing = await client.query('SELECT 1 FROM rockygpt_v2.schema_migrations WHERE version=$1', [version]);
      if (!existing.rowCount) {
        await client.query(fs.readFileSync(path.join(__dirname, '../src/data-v2/migrations', version), 'utf8'));
        await client.query('INSERT INTO rockygpt_v2.schema_migrations(version) VALUES ($1)', [version]);
      }
      const updated = await client.query(`UPDATE rockygpt_v2.campus_hours h SET hours=n.hours
        FROM jsonb_to_recordset($1::jsonb) AS n(id uuid, hours jsonb)
        WHERE h.id=n.id AND h.dataset_version_id=$2`, [JSON.stringify(normalized), dataset.id]);
      if (updated.rowCount !== rows.length) throw new Error('Not all campus-hours rows were updated.');
      const after = await client.query('SELECT * FROM rockygpt_v2.campus_hours WHERE dataset_version_id=$1 ORDER BY id', [dataset.id]);
      if (after.rows.length !== rows.length) throw new Error('Record count changed.');
      after.rows.forEach((row, index) => {
        for (const key of Object.keys(rows[index]).filter(key => key !== 'hours')) {
          if (JSON.stringify(row[key]) !== JSON.stringify(rows[index][key])) throw new Error(`Source field changed: ${key}`);
        }
        if (!isDeepStrictEqual(row.hours, normalized[index].hours)) throw new Error('Stored intervals do not match the normalization plan.');
      });
    }
    if (report) fs.writeFileSync(path.resolve(report), JSON.stringify({ dataset, records: normalized,
      unknown: normalized.filter(r => r.hours === null).map(r => ({ id: r.id, name: r.name, day: r.day })),
    }, null, 2), { mode: 0o600 });
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', dataset: dataset.version,
      records: normalized.length, facilities: new Set(rows.map(r => r.name)).size, changed,
      closed: normalized.filter(r => r.hours?.length === 0).length,
      split: normalized.filter(r => (r.hours?.length ?? 0) > 1).length,
      next_day_close: normalized.filter(r => r.hours?.some(h => h.close_day_offset === 1)).length,
      unknown: normalized.filter(r => r.hours === null).length,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Campus-hours backfill failed.'); process.exitCode = 1; });
