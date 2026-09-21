/** Normalize only the active release in place, preserving IDs, contact methods and provenance. */
import 'dotenv/config';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { normalizeContactFields, reviewContacts, splitPublishedFacultyDepartment } from '../src/directory/contact-normalizer';
import type { ContactFieldInput, NormalizedContactFields } from '../src/directory/contact-normalizer';

interface Row extends ContactFieldInput {
  id: string;
  dataset_version_id: string;
  source_record_key: string;
  phones?: { number?: string; extension?: string; type?: string }[];
  email?: string;
  preferred_contact?: string;
  search_text?: string;
  phone?: string;
  raw_phone?: string;
  contact_note?: string;
  aliases?: string[];
  normalization_metadata?: Record<string, unknown>;
}

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
    if (releases.rows.length !== 1) throw new Error('Expected exactly one active release.');
    const dataset = releases.rows[0];
    const result = await client.query<Row>(`SELECT * FROM rockygpt_v2.campus_contacts WHERE dataset_version_id=$1 ORDER BY id${apply ? ' FOR UPDATE' : ''}`, [dataset.id]);
    if (!result.rows.length) throw new Error('Active release has no contacts.');
    const normalized = result.rows.map(row => {
      const type = row.type ?? (row.source_record_key.startsWith('office:') ? 'office'
        : /^(faculty|other):/.test(row.source_record_key) ? 'person' : undefined);
      const split = !row.normalization_metadata?.version && row.source_record_key.startsWith('faculty:')
        ? splitPublishedFacultyDepartment(row.department ?? '') : {};
      const fields = normalizeContactFields({ ...row, type, ...split });
      return {
        ...fields, id: row.id, phones: row.phones, email: row.email,
        ...(row.preferred_contact ? { preferred_contact: row.preferred_contact } : {}),
      };
    });
    const reviews = reviewContacts(normalized);
    const reportRows = normalized.map(row => ({
      record: Object.fromEntries(Object.entries(row).filter(([, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length))),
      review_flags: reviews[row.id],
    }));
    const metadata = (row: Row) => ({
      ...row.normalization_metadata,
      version: 1,
      raw_fields: row.normalization_metadata?.raw_fields ?? {
        name: row.name, title: row.title, department: row.department, office: row.office,
      },
      review_flags: reviews[row.id],
    });
    let changed = 0;
    for (let i = 0; i < normalized.length; i++) {
      const row = result.rows[i];
      const fields = normalized[i];
      const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      if (['name', 'title', 'type', 'department', 'status', 'offices'].some(key =>
        !same(key === 'offices' ? row.offices ?? [] : row[key as keyof Row],
          key === 'offices' ? fields.offices ?? [] : fields[key as keyof NormalizedContactFields]))) changed++;
    }
    if (apply) {
      fs.writeFileSync(path.resolve(backup!), JSON.stringify({ dataset, contacts: result.rows }, null, 2), { mode: 0o600, flag: 'wx' });
      const version = '018_contact_record_fields.sql';
      const applied = await client.query('SELECT 1 FROM rockygpt_v2.schema_migrations WHERE version=$1', [version]);
      if (!applied.rowCount) {
        await client.query(fs.readFileSync(path.join(__dirname, '../src/data-v2/migrations', version), 'utf8'));
        await client.query('INSERT INTO rockygpt_v2.schema_migrations(version) VALUES ($1)', [version]);
      }
      for (let i = 0; i < normalized.length; i++) {
        const row = result.rows[i];
        const fields = normalized[i];
        const searchText = row.search_text || [row.name, row.title, row.department, row.office].filter(Boolean).join(' ');
        const contentHash = createHash('sha256').update(JSON.stringify({
          name: fields.name, type: fields.type, title: fields.title, status: fields.status, offices: fields.offices,
          department: fields.department ?? null, phone: row.phone ?? null, email: row.email ?? null,
          office: fields.offices?.join(' / ') ?? null, phones: JSON.stringify(row.phones ?? []),
          preferred_contact: row.preferred_contact ?? null, contact_note: row.contact_note ?? null,
          raw_phone: row.raw_phone ?? null, aliases: row.aliases ?? [], search_text: searchText,
        })).digest('hex');
        const updated = await client.query(`UPDATE rockygpt_v2.campus_contacts
          SET name=$1, type=$2, title=$3, department=$4, status=$5, offices=$6::jsonb,
              office=$7, normalization_metadata=$8::jsonb, search_text=$9, content_hash=$12
          WHERE id=$10 AND dataset_version_id=$11`, [
          fields.name, fields.type ?? null, fields.title ?? null, fields.department ?? null,
          fields.status ?? null, JSON.stringify(fields.offices ?? []), fields.offices?.join(' / ') ?? null,
          JSON.stringify(metadata(row)), searchText,
          row.id, dataset.id, contentHash,
        ]);
        if (updated.rowCount !== 1) throw new Error('Contact identity changed during backfill.');
      }
      const after = await client.query<Row>('SELECT * FROM rockygpt_v2.campus_contacts WHERE dataset_version_id=$1 ORDER BY id', [dataset.id]);
      if (after.rows.length !== result.rows.length) throw new Error('Contact count changed.');
      for (let i = 0; i < after.rows.length; i++) {
        const row = after.rows[i];
        const original = result.rows[i];
        for (const field of ['id', 'source_record_key', 'phones', 'email', 'preferred_contact'] as const) {
          if (JSON.stringify(row[field]) !== JSON.stringify(original[field])) throw new Error(`Preservation check failed: ${field}`);
        }
        const twice = normalizeContactFields(row);
        if (JSON.stringify(twice) !== JSON.stringify(normalizeContactFields(normalized[i]))) throw new Error('Normalization is not idempotent.');
      }
    }
    if (report) fs.writeFileSync(path.resolve(report), JSON.stringify({ dataset, contacts: reportRows }, null, 2), { mode: 0o600 });
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    const count = (fn: (r: typeof normalized[number]) => boolean) => normalized.filter(fn).length;
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', dataset: dataset.version,
      contacts: normalized.length, changed, people: count(r => r.type === 'person'), offices: count(r => r.type === 'office'),
      retired: count(r => r.status === 'retired'), multiple_offices: count(r => (r.offices?.length ?? 0) > 1),
      flagged_records: Object.values(reviews).filter(flags => flags.length).length,
      review_counts: Object.values(reviews).flat().reduce<Record<string, number>>((counts, flag) => {
        counts[flag.reason] = (counts[flag.reason] ?? 0) + 1; return counts;
      }, {}),
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Contact backfill failed.'); process.exitCode = 1; });
