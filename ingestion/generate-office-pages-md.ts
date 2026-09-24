/**
 * generate-office-pages-md.ts
 *
 * One context document per student office site, titled with the office's name, so every
 * passage's heading path names the office it came from. A sidebar block or document list
 * repeated on half the office's pages or more is written once, under "Site-wide sections".
 * Each page is cited to its URL and capture time. Reads
 * data/normalized/office-pages.json, which normalize:raw replays from the captured HTML.
 *
 * Run: npm run generate:office-pages:md
 */

import fs from 'fs';
import path from 'path';
import { core6Markdown } from './generate-core6-md-utils';
import {
  isSkippedPostTypePath, officeFolder, pageKey, pagesCollectedElsewhere, readOfficeSites, readSkippedPages, type OfficeSite,
} from './office-pages';
import { type RawDatasetV1, validateRawDatasetV1 } from './raw-types';

const INPUT = path.join(process.cwd(), 'data', 'normalized', 'office-pages.json');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus', 'offices');

const succeeded = (page: RawDatasetV1['pages'][number]) =>
  page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400;

/**
 * Each office's pages as a dataset of their own, in the office list's order; offices without
 * pages are left out. So are pages whose final URL is excluded: a reviewed skipped page, or a
 * page another collector keeps that a link reached by redirect.
 */
export function officeDatasets(
  dataset: RawDatasetV1,
  sites: readonly OfficeSite[],
  excluded: ReadonlySet<string> = new Set()
): Array<{ site: OfficeSite; dataset: RawDatasetV1 }> {
  return sites.flatMap(site => {
    const own = new Set([site.folder.toLowerCase()]);
    const pages = dataset.pages.filter(page => officeFolder(page.url, own) && !isSkippedPostTypePath(page.url)
      && !excluded.has(pageKey(page.url) ?? ''));
    if (!pages.length) return [];
    const pagesFetched = pages.filter(succeeded).length;
    return [{
      site,
      dataset: {
        ...dataset,
        seedUrls: dataset.seedUrls.filter(url => officeFolder(url, own)),
        stats: {
          pagesFetched,
          pagesFailed: pages.length - pagesFetched,
          externalLinksSeen: new Set(pages.flatMap(page => page.externalLinks)).size,
        },
        pages,
      },
    }];
  });
}

/** The office documents to write, by file name. */
export function officeDocuments(
  dataset: RawDatasetV1,
  sites: readonly OfficeSite[],
  excluded: ReadonlySet<string> = new Set()
): Map<string, { markdown: string; pages: number }> {
  const documents = new Map<string, { markdown: string; pages: number }>();
  for (const { site, dataset: office } of officeDatasets(dataset, sites, excluded)) {
    const document = core6Markdown(office, {
      title: site.name,
      description: `Pages of Ramapo College's ${site.name} site (https://www.ramapo.edu/${site.folder}/), `
        + 'each under its own title with the page it came from.',
      hoistRepeatedSections: true,
    });
    if (document.pages) documents.set(`${site.folder}.md`, document);
  }
  return documents;
}

function main() {
  const dataset = validateRawDatasetV1(JSON.parse(fs.readFileSync(INPUT, 'utf8')));
  if (dataset.dataset !== 'office-pages') throw new Error(`${INPUT} holds ${dataset.dataset}, not office-pages.`);
  const documents = officeDocuments(dataset, readOfficeSites(),
    new Set([...readSkippedPages().keys(), ...pagesCollectedElsewhere()]));
  // Rewrite the folder, so an office that no longer has pages leaves no document behind.
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  let pages = 0;
  for (const [file, document] of documents) {
    fs.writeFileSync(path.join(OUTPUT_DIR, file), document.markdown);
    pages += document.pages;
  }
  const unplaced = dataset.pages.filter(page => succeeded(page)
    && !officeFolder(page.url, new Set(readOfficeSites().map(site => site.folder.toLowerCase()))));
  unplaced.forEach(page => console.warn(`Not in an office folder after redirects, so not written: ${page.url}`));
  console.log(`Wrote ${pages} pages of ${documents.size} office sites to ${path.relative(process.cwd(), OUTPUT_DIR)}.`);
}

if (process.argv[1]?.endsWith('generate-office-pages-md.ts')) main();
