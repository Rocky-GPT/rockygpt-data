/**
 * Nightly spot check of the hours pages, with no extra request to Ramapo's sites.
 *
 * Hours are read from every hours page weekly, and on other nights only from the pages whose
 * nightly copy changed (campus-hours.ts, HOURS_READ_ENV). This runs each hours reader on tonight's
 * copy of every page, changed or not, and names every page that no longer reads, so a person can
 * fix the reader before the weekly read has to keep that page's old hours.
 *
 *     npx tsx ingestion/hours-spot-check.ts     # writes data/review/hours-spot-check.md
 *
 * It never fails the run: it only reports.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BERRIE_SEASON_URL, GENERAL_CAMPUS_HOURS_URL, LIBRARY_HOURS_URL, OFFICE_HOURS_PAGES, readHoursCapture,
} from './campus-hours';
import { type RawSourceCaptureV1 } from './raw-collector';
import { pageCopies, pageKey, readPageCaptures } from './page-copies';

export { pageKey } from './page-copies';

export const SPOT_CHECK_REPORT = path.join('data', 'review', 'hours-spot-check.md');

/** Every ramapo.edu page the hours collector reads (the athletics page is on another site). */
export function hoursPageUrls(): string[] {
  return [...new Set([LIBRARY_HOURS_URL, GENERAL_CAMPUS_HOURS_URL, BERRIE_SEASON_URL,
    ...OFFICE_HOURS_PAGES.map((office) => office.url)])];
}

export interface SpotCheckResult {
  checked: number;
  failed: Array<{ url: string; error: string; copyFrom: string }>;
  /** Hours pages tonight's captures hold no readable copy of. */
  unseen: string[];
}

export function spotCheck(captures: readonly RawSourceCaptureV1[], urls: readonly string[]): SpotCheckResult {
  const copies = pageCopies(captures);
  const result: SpotCheckResult = { checked: 0, failed: [], unseen: [] };
  for (const url of urls) {
    const copy = copies.get(pageKey(url));
    if (!copy) {
      result.unseen.push(url);
      continue;
    }
    result.checked += 1;
    try {
      readHoursCapture({ sourceUrl: url, collectedAt: copy.fetchedAt, html: copy.html });
    } catch (error) {
      result.failed.push({ url, error: error instanceof Error ? error.message : String(error), copyFrom: copy.fetchedAt });
    }
  }
  return result;
}

export function spotCheckReport(result: SpotCheckResult): string {
  const lines = [
    `Hours spot check: ${result.checked} hours page(s) read from tonight's page copies, `
      + `${result.failed.length} no longer read, ${result.unseen.length} not among tonight's pages.`,
  ];
  if (result.failed.length) {
    lines.push('', 'These pages no longer read with their reader in `ingestion/campus-hours.ts`. The weekly hours '
      + 'read will keep each one\'s last good hours until its reader is fixed:', '',
    ...result.failed.map((page) => `- ${page.url} (copy of ${page.copyFrom.slice(0, 10)}): ${page.error}`));
  }
  if (result.unseen.length) {
    lines.push('', 'Not checked tonight (no nightly copy of the page; the weekly hours read still reads them):', '',
      ...result.unseen.map((url) => `- ${url}`));
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const result = spotCheck(readPageCaptures(), hoursPageUrls());
  const report = spotCheckReport(result);
  fs.mkdirSync(path.dirname(SPOT_CHECK_REPORT), { recursive: true });
  fs.writeFileSync(SPOT_CHECK_REPORT, report);
  console.log(report);
  if (result.failed.length) {
    console.log(`::warning::${result.failed.length} hours page(s) no longer read; see ${SPOT_CHECK_REPORT}.`);
  }
}

if (process.argv[1]?.endsWith('hours-spot-check.ts')) main();
