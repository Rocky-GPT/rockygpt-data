/**
 * major-page-links.ts
 *
 * The Ramapo pages that the college's program pages link to, collected one link away
 * from those pages: department and center pages, 4+1 and graduate program sites, clubs,
 * career services, study abroad and news.
 *
 * The program pages themselves (fetch:major-pages), the catalog (captured from its API)
 * and the application portal are not collected again here. Pages on other sites are not
 * collected: they are not campus sources. Neither are the Success Stories site's pages,
 * each about one named student or alum, which RockyGPT does not publish.
 *
 * Run: npm run fetch:major-page-links (after fetch:major-pages)
 */

import fs from 'fs';
import path from 'path';
import { pageKey } from './folder-sites';
import { collectRawDataset } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';
import { publicPath } from '../src/paths';

const MAJOR_PAGES = publicPath('data', 'major-pages.json');
const OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'major-page-links.raw.json');
const COLLECTED_ELSEWHERE = new Set(['catalog.ramapo.edu', 'apply.ramapo.edu']);
const PROGRAM_PAGES = /^\/majors-minors(\/|$)/;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|csv|txt)$/i;
const SUCCESS_STORIES = /^\/success-stories(\/|$)/;

/** Whether a URL is on the Success Stories site, whose pages are each about one named student or alum. */
export function isSuccessStory(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase() === 'www.ramapo.edu' && SUCCESS_STORIES.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * The captured pages to publish: not a success story, and not a faculty profile the faculty
 * source keeps, which old program links can reach by redirect (/ca/faculty/... to /ahe/faculty/...).
 */
export function publishedLinkedPages(dataset: RawDatasetV1, facultyProfiles: ReadonlySet<string>): RawDatasetV1 {
  const published = (url: string) => !isSuccessStory(url) && !facultyProfiles.has(pageKey(url) ?? '');
  const pages = dataset.pages.filter(page => published(page.url));
  const pagesFetched = pages.filter(page => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400).length;
  return {
    ...dataset,
    seedUrls: dataset.seedUrls.filter(published),
    stats: {
      pagesFetched,
      pagesFailed: pages.length - pagesFetched,
      externalLinksSeen: new Set(pages.flatMap(page => page.externalLinks)).size,
    },
    pages,
  };
}

/** The distinct Ramapo pages program pages link to, as https URLs without fragments. */
export function linkedPageUrls(pages: ReadonlyArray<{ links?: ReadonlyArray<{ url: string }> }>): string[] {
  const urls = new Set<string>();
  for (const link of pages.flatMap(page => page.links ?? [])) {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (host !== 'ramapo.edu' && !host.endsWith('.ramapo.edu')) continue;
    if (COLLECTED_ELSEWHERE.has(host) || DOCUMENT.test(url.pathname)) continue;
    if (host === 'www.ramapo.edu' && (PROGRAM_PAGES.test(url.pathname) || SUCCESS_STORIES.test(url.pathname))) continue;
    url.protocol = 'https:';
    url.hash = '';
    urls.add(url.toString());
  }
  return [...urls].sort();
}

async function main() {
  const { pages } = JSON.parse(fs.readFileSync(MAJOR_PAGES, 'utf8')) as {
    pages: Array<{ links?: Array<{ url: string }> }>;
  };
  const seedUrls = linkedPageUrls(pages);
  if (!seedUrls.length) throw new Error('The program pages link no Ramapo pages; run fetch:major-pages first.');
  const dataset = await collectRawDataset({
    dataset: 'major-page-links',
    retainSourceHtml: true,
    seedUrls,
    outputPath: OUTPUT_PATH,
    allowedHosts: [...new Set(seedUrls.map(url => new URL(url).host))],
    // One link away from the program pages; the pages these link to are not followed.
    maxDetailPages: 0,
    minimumPages: seedUrls.length,
    minimumSeedSuccessRate: 0.8,
    minimumPreviousPageRatio: 0.8,
    // Captures from before success stories were left out count only the pages still collected.
    comparablePreviousPage: page => !isSuccessStory(page.url),
  });
  console.log(`Saved ${dataset.pages.length} pages linked from program pages to ${OUTPUT_PATH} ` +
    `(${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`);
}

if (process.argv[1]?.endsWith('major-page-links.ts')) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
