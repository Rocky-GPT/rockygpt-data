import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';
import { getRuntimePool } from '../../src/db/runtime-pool';
import { FileRepositoryV2 } from '../../src/data-v2/repositories/file-repository';
import { seasonalPublicationRows } from '../../src/data-v2/dining-seasons';

type JsonRecord = Record<string, unknown>;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

async function syncDiningToActiveDataset() {
  const pool = getRuntimePool();
  if (!pool) {
    throw new Error('Database pool not available');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const activeRes = await client.query<{ id: string; version: string }>(
      `SELECT id, version FROM rockygpt_v2.dataset_versions WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1`
    );
    if (!activeRes.rows.length) {
      throw new Error('No active dataset version found');
    }
    const activeDatasetId = activeRes.rows[0].id;
    console.log(`Syncing dining and menu to active dataset: ${activeRes.rows[0].version} (${activeDatasetId})`);

    const sourceRes = await client.query<{ id: string }>(
      `SELECT id FROM rockygpt_v2.sources WHERE source_key = 'dining' LIMIT 1`
    );
    const sourceId = sourceRes.rows[0]?.id || null;

    // 1. Update release_artifacts: dining-hours, dining-hours-context, menu, menu-week, menu-context
    const filesToSync: Record<string, string> = {
      'dining-hours': 'data/normalized/dining-hours.json',
      'dining-hours-context': 'data/context/dining/hours.md',
      menu: 'data/normalized/menu.json',
      'menu-week': 'data/normalized/menu-week.json',
      'menu-context': 'data/context/dining/menu.md',
    };

    for (const [key, relPath] of Object.entries(filesToSync)) {
      const fullPath = path.join(process.cwd(), relPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const payload = relPath.endsWith('.json') ? JSON.parse(content) : { content };
      await client.query(
        `INSERT INTO rockygpt_v2.release_artifacts (dataset_version_id, artifact_key, payload, content_hash)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (dataset_version_id, artifact_key)
         DO UPDATE SET payload = EXCLUDED.payload, content_hash = EXCLUDED.content_hash`,
        [activeDatasetId, key, JSON.stringify(payload), sha256(content)]
      );
      console.log(`Updated release_artifacts for ${key}`);
    }

    // 2. Re-populate dining_hours relational table
    await client.query(
      `DELETE FROM rockygpt_v2.dining_hours WHERE dataset_version_id = $1`,
      [activeDatasetId]
    );

    const fileRepository = new FileRepositoryV2();
    let diningCount = 0;
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      const diningHours = await fileRepository.findDiningHours('', day);
      for (const hours of diningHours) {
        const recordKey = `${hours.name}:${day}`;
        await client.query(
          `INSERT INTO rockygpt_v2.dining_hours
           (dataset_version_id, source_id, source_record_key, name, day, schedule, collected_at, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)`,
          [activeDatasetId, sourceId, recordKey, hours.name, day, hours.schedule, sha256(`${recordKey}:${hours.schedule}`)]
        );
        diningCount++;
      }
    }

    const diningHoursRaw = fs.readFileSync(path.join(process.cwd(), 'data/normalized/dining-hours.json'), 'utf8');
    const diningRaw = JSON.parse(diningHoursRaw) as JsonRecord;
    const diningRegions = (((diningRaw.composition as JsonRecord)?.subject as JsonRecord)?.regions || []) as JsonRecord[];
    for (const region of diningRegions) {
      for (const fragment of (region.fragments as JsonRecord[]) || []) {
        const main = (((fragment.content as JsonRecord)?.main || {}) as JsonRecord);
        const name = typeof main.name === 'string' ? main.name : '';
        if (!name) continue;
        for (const row of seasonalPublicationRows((main.openingHours || {}) as JsonRecord)) {
          const recordKey = `${name}:${row.day}:${row.validFrom}:${row.validUntil}`;
          await client.query(
            `INSERT INTO rockygpt_v2.dining_hours
             (dataset_version_id, source_id, source_record_key, name, day, schedule, collected_at,
              valid_from, valid_until, content_hash)
             VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,$9)`,
            [activeDatasetId, sourceId, recordKey, name, row.day, row.schedule, row.validFrom, row.validUntil, sha256(`${recordKey}:${row.schedule}`)]
          );
          diningCount++;
        }
      }
    }
    console.log(`Inserted ${diningCount} rows into rockygpt_v2.dining_hours`);

    // 3. Re-populate menu_items relational table
    await client.query(
      `DELETE FROM rockygpt_v2.menu_items WHERE dataset_version_id = $1`,
      [activeDatasetId]
    );

    const weekFile = path.join(process.cwd(), 'data/normalized/menu-week.json');
    const menuWeek = fs.existsSync(weekFile)
      ? JSON.parse(fs.readFileSync(weekFile, 'utf8'))
      : { dates: [] };

    const datesToPublish = (menuWeek.dates && menuWeek.dates.length > 0)
      ? menuWeek.dates
      : [{ date: new Date().toISOString().slice(0, 10), sections: JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/normalized/menu.json'), 'utf8')) }];

    let menuCount = 0;
    for (const dateEntry of datesToPublish) {
      const dateStr = dateEntry.date;
      for (const meal of dateEntry.sections || []) {
        for (const station of meal.groups || []) {
          for (const item of station.items || []) {
            const name = cleanText(item.formalName);
            if (!name) continue;
            const recordKey = `${dateStr}:${meal.name}:${station.name}:${name}`;
            const allergens = Array.isArray(item.allergens)
              ? item.allergens.flatMap((entry: { name?: unknown }) => cleanText(entry?.name) || [])
              : [];
            await client.query(
              `INSERT INTO rockygpt_v2.menu_items
               (dataset_version_id, source_id, source_record_key, meal, station, name, calories,
                vegan, vegetarian, allergens, collected_at, valid_from, valid_until, content_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW(),$11,$11,$12)`,
              [activeDatasetId, sourceId, recordKey, meal.name, station.name, name,
                cleanText(item.calories) || null, item.isVegan === true, item.isVegetarian === true,
                JSON.stringify(allergens), dateStr, sha256(recordKey)]
            );
            menuCount++;
          }
        }
      }
    }
    console.log(`Inserted ${menuCount} rows into rockygpt_v2.menu_items with valid_from dates`);

    await client.query('COMMIT');
    console.log('Successfully synced dining and menu into database!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error syncing dining and menu:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

syncDiningToActiveDataset();
