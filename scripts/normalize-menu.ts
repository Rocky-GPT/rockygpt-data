/** Normalize the active menu from its own dated snapshot, preserving IDs and timestamps. */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { dietaryLabels } from '../src/data-v2/dietary-labels';
import { filterMenuMarkdown, isMenuArtifact, menuCalories } from '../src/data-v2/menu-normalization';
import { validateMenuData } from '../ingestion/schema';

type Row = Record<string, unknown>;
const sourceText = (value: string) => value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const backup = args[args.indexOf('--backup') + 1];
  if (apply && !args.includes('--backup')) throw new Error('--apply requires --backup <new-file.json>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('rockygpt_v2_schema_migrations'))");
    const { rows: releases } = await client.query("SELECT id, version FROM rockygpt_v2.dataset_versions WHERE status='active'");
    if (releases.length !== 1) throw new Error('Expected one active release');
    const dataset = releases[0];
    const { rows } = await client.query('SELECT * FROM rockygpt_v2.menu_items ORDER BY id');
    const { rows: artifacts } = await client.query("SELECT * FROM rockygpt_v2.release_artifacts WHERE dataset_version_id=$1 AND artifact_key IN ('menu','menu-week','menu-context')", [dataset.id]);
    const { rows: documents } = await client.query(`SELECT d.* FROM rockygpt_v2.documents d JOIN rockygpt_v2.sources s ON s.id=d.source_id WHERE d.dataset_version_id=$1 AND s.source_key='dining' AND d.title='Birch Tree Inn Menu'`, [dataset.id]);
    const { rows: chunks } = await client.query('SELECT * FROM rockygpt_v2.document_chunks WHERE document_id=ANY($1::uuid[])', [documents.map(d => d.id)]);
    const week = artifacts.find(a => a.artifact_key === 'menu-week')?.payload;
    if (!week?.dates) throw new Error('Active menu-week snapshot is required');
    const source = new Map<string, Row>();
    for (const day of week.dates) for (const meal of day.sections) for (const station of meal.groups) for (const item of station.items) {
      const key = `${day.date}:${meal.name}:${station.name}:${sourceText(item.formalName)}`;
      if (source.has(key)) throw new Error(`Ambiguous occurrence: ${key}`);
      source.set(key, item);
    }
    const active = rows.filter(r => r.dataset_version_id === dataset.id);
    for (const row of rows) {
      if (row.calories != null && String(row.calories).trim() && menuCalories(row.calories) === undefined) throw new Error(`Invalid calories on ${row.id}`);
    }
    for (const row of active) if (!source.has(row.source_record_key) && !isMenuArtifact(row.name)) throw new Error(`No exact source occurrence for ${row.id}`);
    const report = { dataset: dataset.version, records: active.length,
      student_records: active.filter(r => !isMenuArtifact(r.name)).length,
      filtered_artifacts: active.filter(r => isMenuArtifact(r.name)).length,
      source_dietary_flags: active.filter(r => typeof source.get(r.source_record_key)?.isVegan === 'boolean').length,
      missing_allergens: active.filter(r => !Array.isArray(source.get(r.source_record_key)?.allergens)).length,
      applied: apply };
    if (apply) {
      fs.writeFileSync(backup, JSON.stringify({ dataset, menu_items: rows, artifacts, documents, chunks }, null, 2), { flag: 'wx', mode: 0o600 });
      const version = '020_menu_nutrition.sql';
      const done = await client.query('SELECT 1 FROM rockygpt_v2.schema_migrations WHERE version=$1', [version]);
      if (!done.rowCount) {
        await client.query(fs.readFileSync(path.join(__dirname, '../src/data-v2/migrations/020_menu_nutrition.sql'), 'utf8'));
        await client.query('INSERT INTO rockygpt_v2.schema_migrations(version) VALUES ($1)', [version]);
      }
      for (const row of active) {
        const item = source.get(row.source_record_key);
        if (!item) continue; // Previously filtered non-food source message.
        const labels = dietaryLabels(item);
        const normalized = { calories: menuCalories(item.calories) ?? null, vegan: labels.vegan,
          vegetarian: labels.vegetarian, label_coverage: labels.coverage,
          portion_size: typeof item.portionSize === 'string' ? item.portionSize : null };
        await client.query(`UPDATE rockygpt_v2.menu_items SET calories=$1,vegan=$2,vegetarian=$3,label_coverage=$4::jsonb,portion_size=$5,content_hash=$6 WHERE id=$7`,
          [normalized.calories, normalized.vegan, normalized.vegetarian, JSON.stringify(normalized.label_coverage), normalized.portion_size, hash({ source_record_key: row.source_record_key, ...normalized, allergens: row.allergens }), row.id]);
      }
      for (const artifact of artifacts) {
        let payload = artifact.payload;
        if (artifact.artifact_key === 'menu') payload = payload.length ? validateMenuData(payload) : [];
        if (artifact.artifact_key === 'menu-week') payload = { ...payload, dates: payload.dates.map((d: { date: string; sections: unknown[] }) => ({ ...d, sections: d.sections.length ? validateMenuData(d.sections) : [] })) };
        if (artifact.artifact_key === 'menu-context' && typeof payload.content === 'string') {
          payload = { ...payload, content: filterMenuMarkdown(payload.content) };
        }
        await client.query('UPDATE rockygpt_v2.release_artifacts SET payload=$1::jsonb,content_hash=$2 WHERE dataset_version_id=$3 AND artifact_key=$4', [JSON.stringify(payload), hash(payload), dataset.id, artifact.artifact_key]);
      }
    }
    if (apply) {
      for (const doc of documents) {
        await client.query('UPDATE rockygpt_v2.documents SET content=$1 WHERE id=$2', [filterMenuMarkdown(doc.content), doc.id]);
      }
      for (const chunk of chunks) {
        const content = filterMenuMarkdown(chunk.content);
        await client.query('UPDATE rockygpt_v2.document_chunks SET content=$1,content_hash=$2 WHERE id=$3', [content, createHash('sha256').update(content).digest('hex'), chunk.id]);
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
