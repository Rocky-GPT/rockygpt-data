/**
 * Counts the pages a nightly how-to read would send to the model: the pages whose own words
 * changed between two archived captures (ingestion/howto-entries.ts reads a page again only when
 * its sections or the instructions change). Ramapo's pages carry no change marker, so this
 * count, not a "not modified" reply, is what a night costs.
 *
 *   tsx scripts/review/measure-task-reads.ts 2026-10-22 2026-11-08 2026-11-10 now [--keep-newest]
 *
 * Each argument is a time; "now" is the newest capture. For each, the newest bundle of every
 * source archived before it is restored to a folder of its own (needs the RAW_ARTIFACT_*
 * settings the publish uses), and each pair of neighbours is compared. It reads the archive
 * only: it fetches no college page and calls no model. With --keep-newest the last capture is
 * also left in data/raw, for a sample read by ingestion/howto-entries.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countReads, howtoPages, HOWTO_RATES, pageReads, type PageRead } from '../../ingestion/howto-entries';
import { restoreNewestBundles } from './show-changed-sections';

/** About four characters of English make a token; the input side of a read at gpt-6-luna's rate. */
const inputDollars = (chars: number) => (chars / 4) * HOWTO_RATES.input / 1_000_000_000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keepNewest = args.includes('--keep-newest');
  const times = args.filter(arg => !arg.startsWith('--'));
  if (times.length < 2) throw new Error('Give at least two times to compare, oldest first, for example: 2026-11-08 2026-11-10 now');
  const snapshots: Array<{ label: string; pages: Map<string, PageRead> }> = [];
  for (const [index, label] of times.entries()) {
    const before = label === 'now' ? undefined : Date.parse(label);
    if (before !== undefined && !Number.isFinite(before)) throw new Error(`"${label}" is not a time.`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reads-'));
    console.log(`\nCaptures archived before ${label}:`);
    await restoreNewestBundles(dir, before, true);
    // A time before the catalog policies were first archived has office pages only.
    if (!fs.existsSync(path.join(dir, 'catalog-policies.raw.json'))) {
      console.log('  no catalog policies archived yet; counted without them');
      fs.writeFileSync(path.join(dir, 'catalog-policies.raw.json'), JSON.stringify({ page: { url: 'https://catalog.ramapo.edu' }, policies: [] }));
    }
    snapshots.push({ label, pages: pageReads(howtoPages(dir)) });
    if (keepNewest && index === times.length - 1) {
      fs.mkdirSync(path.join('data', 'raw'), { recursive: true });
      for (const file of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, file), path.join('data', 'raw', file));
    }
  }
  const newest = snapshots.at(-1)!;
  const allChars = [...newest.pages.values()].reduce((sum, page) => sum + page.chars, 0);
  console.log(`\nA first read of every page (${newest.label}): ${newest.pages.size} pages, ${allChars} characters, `
    + `about ${Math.round(allChars / 4)} input tokens, about $${inputDollars(allChars).toFixed(2)} of input. `
    + 'The replies cost more than the input; a sample read measures them.');
  console.log('\nPages to read again from one capture to the next (same words = not read):');
  for (let index = 1; index < snapshots.length; index++) {
    const from = snapshots[index - 1];
    const to = snapshots[index];
    const count = countReads(from.pages, to.pages);
    console.log(`  ${from.label} -> ${to.label}: ${count.pages} pages; ${count.same} the same, ${count.changed} changed, `
      + `${count.added} new, ${count.gone} gone; to read: ${count.changed + count.added} pages, ${count.charsToRead} characters, `
      + `about $${inputDollars(count.charsToRead).toFixed(3)} of input`);
  }
}

if (process.argv[1]?.endsWith('measure-task-reads.ts')) {
  main().catch(error => { console.error('Fatal:', error instanceof Error ? error.message : error); process.exitCode = 1; });
}
