/**
 * office-pages.ts
 *
 * Every page of Ramapo's student office sites: Financial Aid, Student Accounts, the
 * Registrar, the Testing Center, Title IX and the others src/reference/office-sites.json
 * names by their folders on www.ramapo.edu.
 *
 * Each office is its own WordPress site in one folder, and WordPress lists the site's
 * published pages and posts in its sitemap (wp-sitemap.xml). A folder without one uses
 * the pages the site-wide sitemap lists for it. Office pages that a listed page links to
 * are collected too, since a sitemap can miss a page.
 *
 * Pages another Ramapo site collector already keeps are not collected again, and neither
 * are WordPress's sample post and page, which no office wrote. Post types that are not
 * office information are listed but skipped: SKIPPED_POST_TYPES says why for each. The
 * office list's reviewed skippedPages are not collected either.
 *
 * Requests go one at a time, one a second.
 *
 * Run: npm run fetch:office-pages (after the other Ramapo site collectors)
 */

import fs from 'fs';
import path from 'path';
import { DEFAULT_USER_AGENT, fetchWithPolicy } from './http-client';
import { collectRawDataset, createRequestPacer } from './raw-collector';

export interface OfficeSite {
  folder: string;
  name: string;
}

const SITE = 'https://www.ramapo.edu';
const SITE_HOST = 'www.ramapo.edu';
const SITE_WIDE_SITEMAP = `${SITE}/sitemap.xml`;
const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
const OUTPUT_PATH = path.join(RAW_DIR, 'office-pages.raw.json');
const OFFICE_SITES_PATH = path.join(process.cwd(), 'src', 'reference', 'office-sites.json');
const REQUEST_INTERVAL_MS = 1_000;
const MAX_UNLISTED_PAGES = 500;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|jpe?g|png|gif|zip|mp3|mp4)$/i;
// Listings WordPress builds from posts (archives, feeds) and its own endpoints, not pages.
const WORDPRESS_LISTING =
  /\/(?:category|tag|author|feed|comments|page|wp-json|wp-content|wp-admin|wp-includes)(?:\/|$)|\/\d{4}(?:\/\d{2}){0,2}\/?$|\/wp-[a-z-]+\.php$/i;
// WordPress creates both when a site is set up; no office wrote them.
const WORDPRESS_SAMPLE = /\/(?:hello-world|sample-page)\/?$/i;
// A dated post's permalink: /folder/2019/03/01/slug/.
const POST_PERMALINK = /\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/;

/** Post types the office sites publish that are not office information, and why. */
export const SKIPPED_POST_TYPES: Readonly<Record<string, string>> = {
  post: 'dated news posts: the newest is from 2025 and most are CSI weekend event lists from 2013 to 2019',
  recipient: 'a page about one student who received a scholarship',
  peers: 'a profile of one student peer facilitator',
  'success-story': "one student's own study abroad story",
  tribe_venue: "the event calendar's venue listings",
  tribe_organizer: "the event calendar's organizer listings",
};

/**
 * Other Ramapo site collectors and the fields that name the pages they keep. A page any
 * of them kept successfully is theirs; this source does not collect it again.
 */
const COLLECTED_ELSEWHERE: ReadonlyArray<{ file: string; list: string; fields: readonly string[] }> = [
  ...['directory', 'housing', 'health', 'counseling', 'safety', 'transportation', 'major-page-links']
    .map(name => ({ file: `${name}.raw.json`, list: 'pages', fields: ['url'] })),
  { file: 'major-pages.raw.json', list: 'pages', fields: ['url', 'finalUrl'] },
  { file: 'faculty.raw.json', list: '', fields: ['profileUrl'] },
  { file: 'hours.raw.json', list: '', fields: ['sourceUrl'] },
];

export function readOfficeSites(filePath = OFFICE_SITES_PATH): OfficeSite[] {
  const { sites } = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { sites: OfficeSite[] };
  return sites;
}

/** The reviewed office pages that are not collected, as page keys, with why. */
export function readSkippedPages(filePath = OFFICE_SITES_PATH): Map<string, string> {
  const { skippedPages = [] } = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    skippedPages?: Array<{ url: string; reason: string }>;
  };
  return new Map(skippedPages.map(page => [pageKey(page.url)!, page.reason]));
}

/** The loc values of a sitemap or sitemap index, entity-decoded. */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(match => match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'));
}

/** The post-type sitemaps of a WordPress sitemap index: pages, posts and custom types, not taxonomies or users. */
export function contentSitemaps(indexXml: string): string[] {
  return sitemapLocs(indexXml).filter(url => /\/wp-sitemap-posts-[a-z0-9_-]+-\d+\.xml$/i.test(url));
}

/**
 * Whether a URL is a page of a skipped post type, or its listing, by the type's path: WordPress
 * serves a post type under its own name, as in /peer-facilitators/peers/ and each profile below it.
 * Posts are the exception, served by date (POST_PERMALINK).
 */
export function isSkippedPostTypePath(raw: string): boolean {
  try {
    const type = new URL(raw).pathname.split('/').filter(Boolean)[1]?.toLowerCase();
    return type !== undefined && type !== 'post' && Object.hasOwn(SKIPPED_POST_TYPES, type);
  } catch {
    return false;
  }
}

/** The post type a WordPress post-type sitemap lists: wp-sitemap-posts-page-1.xml lists pages. */
export function sitemapPostType(sitemapUrl: string): string | null {
  return sitemapUrl.match(/\/wp-sitemap-posts-([a-z0-9_-]+)-\d+\.xml$/i)?.[1] ?? null;
}

/** The path a skipped page's siblings share, such as /scholarships/recipient/, to skip unlisted ones too. */
export function skippedPathPrefix(raw: string): string | null {
  try {
    const segments = new URL(raw).pathname.split('/').filter(Boolean);
    return segments.length >= 3 ? `/${segments.slice(0, -1).join('/')}/`.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** How two URLs for the same page compare: https, any host case, no fragment or trailing slash. */
export function pageKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.hostname}${pathname}${url.search}`.toLowerCase();
  } catch {
    return null;
  }
}

/** The office folder a www.ramapo.edu URL is in, or null. */
export function officeFolder(raw: string, folders: ReadonlySet<string>): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname.toLowerCase() !== SITE_HOST) return null;
  const folder = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  return folder && folders.has(folder) ? folder : null;
}

// Dated posts are skipped wherever they are listed (see SKIPPED_POST_TYPES.post).
function isOfficeContent(url: URL): boolean {
  return !DOCUMENT.test(url.pathname) && !WORDPRESS_SAMPLE.test(url.pathname) && !POST_PERMALINK.test(url.pathname)
    && !isSkippedPostTypePath(url.toString());
}

/**
 * The office pages to collect from what the sitemaps list: pages in an office folder,
 * as https URLs without fragments, once each, less pages collected elsewhere.
 */
export function officePageUrls(
  listed: readonly string[],
  folders: ReadonlySet<string>,
  collectedElsewhere: ReadonlySet<string>
): string[] {
  const pages = new Map<string, string>();
  for (const raw of listed) {
    if (!officeFolder(raw, folders)) continue;
    const url = new URL(raw);
    url.protocol = 'https:';
    url.hash = '';
    const key = pageKey(url.toString());
    if (!key || collectedElsewhere.has(key) || pages.has(key) || !isOfficeContent(url)) continue;
    pages.set(key, url.toString());
  }
  return [...pages.values()].sort();
}

/**
 * Whether a page an office page links to should be collected as well: an office page the
 * sitemaps did not list, not a WordPress listing, and not kept by another collector.
 */
export function isUnlistedOfficePage(
  url: URL,
  folders: ReadonlySet<string>,
  known: ReadonlySet<string>,
  skippedPrefixes: ReadonlySet<string> = new Set()
): boolean {
  if (url.search || !officeFolder(url.toString(), folders) || !isOfficeContent(url)) return false;
  if (WORDPRESS_LISTING.test(url.pathname)) return false;
  const prefix = skippedPathPrefix(url.toString());
  const listing = `${url.pathname.replace(/\/+$/, '')}/`.toLowerCase();
  if ((prefix && skippedPrefixes.has(prefix)) || skippedPrefixes.has(listing)) return false;
  const key = pageKey(url.toString());
  return key !== null && !known.has(key);
}

/** The pages other Ramapo site collectors kept successfully, as page keys. */
export function pagesCollectedElsewhere(rawDir = RAW_DIR): Set<string> {
  const keys = new Set<string>();
  for (const { file, list, fields } of COLLECTED_ELSEWHERE) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    } catch {
      console.warn(`${file} is not available; its pages are not excluded.`);
      continue;
    }
    const records = (list ? (parsed as Record<string, unknown>)[list] : parsed) as unknown;
    if (!Array.isArray(records)) continue;
    for (const record of records as Array<Record<string, unknown>>) {
      const status = record.statusCode ?? record.status;
      if (typeof status === 'number' && (status < 200 || status >= 400)) continue;
      for (const field of fields) {
        const value = record[field];
        const key = typeof value === 'string' ? pageKey(value) : null;
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

async function fetchSitemap(url: string): Promise<string | null> {
  const response = await fetchWithPolicy(url, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/xml,text/xml' },
  }, { attempts: 2 });
  if (!response.ok) return null;
  const text = response.text();
  return /<(?:urlset|sitemapindex)[\s>]/.test(text) ? text : null;
}

/** Every URL the office sites' sitemaps list, the skipped ones apart, with where each office's list came from. */
async function listedOfficePages(
  sites: readonly OfficeSite[]
): Promise<{ urls: string[]; skipped: string[]; report: string[] }> {
  const pace = createRequestPacer(REQUEST_INTERVAL_MS);
  const read = async (url: string) => {
    await pace();
    return fetchSitemap(url);
  };
  let siteWide: string[] | undefined;
  const urls: string[] = [];
  const skipped: string[] = [];
  const report: string[] = [];
  for (const site of sites) {
    const index = await read(`${SITE}/${site.folder}/wp-sitemap.xml`);
    const sitemaps = index ? contentSitemaps(index) : [];
    let listed: string[] = [];
    const types: string[] = [];
    if (sitemaps.length) {
      for (const sitemap of sitemaps) {
        const xml = await read(sitemap);
        if (!xml) throw new Error(`${site.folder}: its sitemap ${sitemap} could not be read.`);
        const locs = sitemapLocs(xml);
        const type = sitemapPostType(sitemap) ?? '';
        const skip = Object.hasOwn(SKIPPED_POST_TYPES, type);
        types.push(`${type} ${locs.length}${skip ? ' skipped' : ''}`);
        (skip ? skipped : listed).push(...locs);
      }
    } else {
      if (!siteWide) {
        const xml = await read(SITE_WIDE_SITEMAP);
        if (!xml) throw new Error(`The site-wide sitemap ${SITE_WIDE_SITEMAP} could not be read.`);
        siteWide = sitemapLocs(xml);
      }
      listed = siteWide;
    }
    const own = listed.filter(url => officeFolder(url, new Set([site.folder])));
    report.push(`${site.folder}: ${own.length} listed (${sitemaps.length ? `WordPress sitemap: ${types.join(', ')}` : 'site-wide sitemap'})`);
    urls.push(...own);
  }
  return { urls, skipped, report };
}

async function main() {
  const sites = readOfficeSites();
  const folders = new Set(sites.map(site => site.folder.toLowerCase()));
  const elsewhere = pagesCollectedElsewhere();
  const reviewedSkips = readSkippedPages();
  const { urls, skipped, report } = await listedOfficePages(sites);
  report.forEach(line => console.log(line));
  const seedUrls = officePageUrls(urls, folders, new Set([...elsewhere, ...reviewedSkips.keys()]));
  if (!seedUrls.length) throw new Error('The office sitemaps list no pages to collect.');
  console.log(`${seedUrls.length} office pages to collect; ${skipped.length} listed pages skipped by post type; `
    + `${elsewhere.size} pages are kept by other collectors.`);
  if (process.argv.includes('--list')) {
    seedUrls.forEach(url => console.log(url));
    return;
  }
  const known = new Set([...elsewhere, ...reviewedSkips.keys(), ...[...seedUrls, ...skipped].map(url => pageKey(url)!)]);
  const skippedPrefixes = new Set(skipped.map(skippedPathPrefix).filter((prefix): prefix is string => prefix !== null)
    .filter(prefix => !POST_PERMALINK.test(`${prefix}x/`)));
  const dataset = await collectRawDataset({
    dataset: 'office-pages',
    retainSourceHtml: true,
    compressSourceHtml: true,
    seedUrls,
    outputPath: OUTPUT_PATH,
    allowedHost: SITE_HOST,
    requestIntervalMs: REQUEST_INTERVAL_MS,
    detailConcurrency: 1,
    detailUrlFilter: url => {
      if (!isUnlistedOfficePage(url, folders, known, skippedPrefixes)) return false;
      known.add(pageKey(url.toString())!);
      return true;
    },
    maxDetailPages: MAX_UNLISTED_PAGES,
    minimumPages: seedUrls.length,
    minimumSeedSuccessRate: 0.9,
    minimumPreviousPageRatio: 0.8,
  });
  console.log(`Saved ${dataset.pages.length} office pages to ${OUTPUT_PATH} ` +
    `(${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`);
}

if (process.argv[1]?.endsWith('office-pages.ts')) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
