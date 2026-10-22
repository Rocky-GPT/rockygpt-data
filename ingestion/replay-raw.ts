/**
 * Reparse a folder-site capture from its retained HTML with today's parser, without network
 * access, and write it back as the collected dataset: the same pages, statuses and fetch times
 * (checked), new sections. Provenance keeps its fetch time and source; only its content hash
 * changes. Use it after a parser change ("an FAQ question is a heading") instead of re-crawling.
 *
 *   DOTENV_CONFIG_PATH=/dev/null npx tsx ingestion/replay-raw.ts office-pages [academic-sites ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { replayRawSourceCapture, type RawSourceCaptureV1 } from './raw-collector';
import { validateRawDatasetV1 } from './raw-types';

export function replayRaw(name: string, rawDir = path.join(process.cwd(), 'data', 'raw')): number {
  const read = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
  const original = validateRawDatasetV1(read(`${name}.raw.json`));
  const replayed = validateRawDatasetV1(replayRawSourceCapture(read(`${name}-sources.raw.json`) as RawSourceCaptureV1));
  const identities = (pages: typeof original.pages) => pages.map(page =>
    JSON.stringify([page.url, page.sourceType, page.statusCode, page.fetchedAt])).sort();
  if (replayed.dataset !== name || JSON.stringify(identities(original.pages)) !== JSON.stringify(identities(replayed.pages))) {
    throw new Error(`${name}: the retained capture does not hold the collected pages and fetch times`);
  }
  const dataset = { ...original, pages: replayed.pages };
  writeJsonFile(path.join(rawDir, `${name}.raw.json`), dataset);
  const provenance = read(`${name}.provenance.json`) as { fetchedAt?: string; sourceUrl?: string; recordCount?: number };
  writeRawProvenance(name, { fetchedAt: provenance.fetchedAt, sourceUrl: provenance.sourceUrl,
    recordCount: provenance.recordCount, payload: JSON.parse(fs.readFileSync(path.join(rawDir, `${name}.raw.json`), 'utf8')) }, rawDir);
  return replayed.pages.length;
}

if (process.argv[1]?.endsWith('replay-raw.ts')) {
  const names = process.argv.slice(2);
  if (!names.length) { console.error('Name the datasets to replay, e.g. office-pages.'); process.exit(1); }
  for (const name of names) console.log(`${name}: replayed ${replayRaw(name)} pages from the retained HTML.`);
}
