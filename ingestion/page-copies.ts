/**
 * Tonight's copies of Ramapo's pages, as the nightly page collectors saved them
 * (data/raw/*-sources.raw.json): the office and school sites and the smaller page sources.
 * The hours collector and its spot check read them instead of downloading the same pages again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sourceHtml, type RawSourceCaptureV1 } from './raw-collector';

export interface PageCopy { html: string; fetchedAt: string }

/** One spelling per address: no scheme, host in lower case, no query or fragment, no trailing slash. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

/**
 * The newest good copy of each page, by pageKey. A page a collector reused without downloading it
 * again keeps the time it was last downloaded, so an old copy never passes for tonight's.
 */
export function pageCopies(captures: readonly RawSourceCaptureV1[]): Map<string, PageCopy> {
  const copies = new Map<string, PageCopy>();
  for (const capture of captures) {
    for (const page of capture.pages) {
      if (page.statusCode !== 200 || page.failure) continue;
      // The reviewed contact documents' capture keeps PDFs (pdfGzip) in the same shape: not a page copy.
      if (typeof page.html !== 'string' && typeof page.htmlGzip !== 'string') continue;
      const copy = { html: sourceHtml(page) ?? '', fetchedAt: page.downloadedAt || page.fetchedAt };
      if (!copy.html.trim()) continue;
      for (const url of [page.url, page.requestedUrl].filter((value): value is string => typeof value === 'string' && value !== '')) {
        const key = pageKey(url);
        const known = copies.get(key);
        if (!known || Date.parse(copy.fetchedAt) > Date.parse(known.fetchedAt)) copies.set(key, copy);
      }
    }
  }
  return copies;
}

/** Every page capture in the raw folder (files named *-sources.raw.json in the page capture shape). */
export function readPageCaptures(rawDir = path.join(process.cwd(), 'data', 'raw')): RawSourceCaptureV1[] {
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
