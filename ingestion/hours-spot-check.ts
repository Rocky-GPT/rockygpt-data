/**
 * Nightly spot check of the hours pages, with no extra request to Ramapo's sites.
 *
 * Hours are read weekly (campus-hours.ts), so a page whose wording changed could go up to a week
 * before its reader fails and keeps the last good read (audit 2026-11-17, "a nightly spot check
 * of the hours pages"). Most hours pages are also office or school pages, which the nightly job
 * already collects (office-pages, academic-sites and the other page sources). This runs each
 * hours reader on tonight's copy of its page and names every page that no longer reads, so a
 * person can fix the reader before the weekly read keeps old hours.
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
import { sourceHtml, type RawSourceCaptureV1 } from './raw-collector';

export const SPOT_CHECK_REPORT = path.join('data', 'review', 'hours-spot-check.md');

/** Every ramapo.edu page the hours collector reads (the athletics page is on another site). */
export function hoursPageUrls(): string[] {
  return [...new Set([LIBRARY_HOURS_URL, GENERAL_CAMPUS_HOURS_URL, BERRIE_SEASON_URL,
    ...OFFICE_HOURS_PAGES.map((office) => office.url)])];
}

/** One spelling per address: no scheme, host in lower case, no query or fragment, no trailing slash. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

export interface SpotCheckResult {
  checked: number;
  failed: Array<{ url: string; error: string; copyFrom: string }>;
  /** Hours pages tonight's captures hold no readable copy of. */
  unseen: string[];
}

export function spotCheck(captures: readonly RawSourceCaptureV1[], urls: readonly string[]): SpotCheckResult {
  const copies = new Map<string, { html: string; fetchedAt: string }>();
  for (const capture of captures) {
    for (const page of capture.pages) {
      if (page.statusCode !== 200 || page.failure) continue;
      const copy = { html: sourceHtml(page), fetchedAt: page.downloadedAt || page.fetchedAt };
      if (!copy.html.trim()) continue;
      for (const url of [page.url, page.requestedUrl]) {
        const key = pageKey(url);
        const known = copies.get(key);
        if (!known || Date.parse(copy.fetchedAt) > Date.parse(known.fetchedAt)) copies.set(key, copy);
      }
    }
  }
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

function readCaptures(rawDir: string): RawSourceCaptureV1[] {
  if (!fs.existsSync(rawDir)) return [];
  const captures: RawSourceCaptureV1[] = [];
  for (const file of fs.readdirSync(rawDir).filter((name) => name.endsWith('-sources.raw.json')).sort()) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')) as Partial<RawSourceCaptureV1>;
      if (value.schemaVersion === 1 && Array.isArray(value.pages)) captures.push(value as RawSourceCaptureV1);
    } catch {
      // Not a page capture (the hours collector keeps its own pages in another shape).
    }
  }
  return captures;
}

function main(): void {
  const result = spotCheck(readCaptures(path.join(process.cwd(), 'data', 'raw')), hoursPageUrls());
  const report = spotCheckReport(result);
  fs.mkdirSync(path.dirname(SPOT_CHECK_REPORT), { recursive: true });
  fs.writeFileSync(SPOT_CHECK_REPORT, report);
  console.log(report);
  if (result.failed.length) {
    console.log(`::warning::${result.failed.length} hours page(s) no longer read; see ${SPOT_CHECK_REPORT}.`);
  }
}

if (process.argv[1]?.endsWith('hours-spot-check.ts')) main();
