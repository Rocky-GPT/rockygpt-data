/**
 * folder-sites.ts
 *
 * Every page of a reviewed list of Ramapo sites, each its own WordPress site in one folder
 * on www.ramapo.edu. The student office sites (office-pages.ts) and the school, program and
 * center sites (academic-sites.ts) are both collected this way; each source names its list,
 * its skipped post types and the collectors whose pages it leaves alone.
 *
 * WordPress lists a site's published pages and posts in its sitemap (wp-sitemap.xml). A
 * folder without one uses the pages the site-wide sitemap lists for it. Pages that a listed
 * page links to are collected too, since a sitemap can miss a page.
 *
 * Pages another Ramapo site collector already keeps are not collected again, and neither
 * are WordPress's sample post and page, which no Ramapo site wrote. Post types that are not
 * the site's own information are listed but skipped, each with the reason. A list's
 * reviewed skippedPages are not collected either.
 *
 * Requests go one at a time, one a second.
 */

import fs from 'fs';
import path from 'path';
import { core6Markdown } from './generate-core6-md-utils';
import { DEFAULT_USER_AGENT, fetchWithPolicy } from './http-client';
import { collectRawDataset, createRequestPacer, type RawSourceCaptureV1, sourceHtml } from './raw-collector';
import { type RawDatasetV1, validateRawDatasetV1 } from './raw-types';

export interface FolderSite {
  folder: string;
  name: string;
}

/** The pages a Ramapo site collector keeps: its raw file, the list in it and the fields that name each page. */
export interface CollectedPages {
  file: string;
  list: string;
  fields: readonly string[];
}

/** A reviewed cut: the page's section with this heading is left out, and with andLater every section after it too. */
export interface SkippedSection {
  heading: string;
  andLater?: boolean;
}

export interface FolderSiteSource {
  /** The raw dataset name, also the start of its file names in data/raw. */
  dataset: string;
  /** The reviewed list: { sites, skippedPages? }. */
  sitesPath: string;
  /** Post types listed in the sites' sitemaps that are not collected, each with the reason. */
  skippedPostTypes: Readonly<Record<string, string>>;
  /** The other collectors whose pages this source does not collect again. */
  collectedElsewhere: readonly CollectedPages[];
}

const SITE = 'https://www.ramapo.edu';
const SITE_HOST = 'www.ramapo.edu';
const SITE_WIDE_SITEMAP = `${SITE}/sitemap.xml`;
export const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
const REQUEST_INTERVAL_MS = 1_000;
const MAX_UNLISTED_PAGES = 500;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|jpe?g|png|gif|zip|mp3|mp4)$/i;
// Listings WordPress builds from posts (archives, feeds) and its own endpoints, not pages.
const WORDPRESS_LISTING =
  /\/(?:category|tag|author|feed|comments|page|wp-json|wp-content|wp-admin|wp-includes)(?:\/|$)|\/\d{4}(?:\/\d{2}){0,2}\/?$|\/wp-[a-z-]+\.php$/i;
// WordPress creates both when a site is set up; no Ramapo site wrote them.
const WORDPRESS_SAMPLE = /\/(?:hello-world|sample-page)\/?$/i;
// A dated post's permalink, /folder/2019/03/01/slug/, and anything below it, such as its images' pages.
const POST_PERMALINK = /\/\d{4}\/\d{2}\/\d{2}\/[^/]+(?:\/|$)/;
// Post types WordPress serves under a path other than their own name: The Events Calendar's venues and organizers.
const POST_TYPE_PATHS: Readonly<Record<string, string>> = { tribe_venue: 'venue', tribe_organizer: 'organizer' };
const BODY_CLASS = /<body\b[^>]*\bclass\s*=\s*(["'])([^"']*)\1/i;

/**
 * The Ramapo site collectors every folder-site source leaves alone, and the fields that name
 * the pages they keep. A page any of them kept successfully is theirs.
 */
export const RAMAPO_SITE_COLLECTORS: readonly CollectedPages[] = [
  ...['directory', 'housing', 'health', 'counseling', 'safety', 'transportation', 'major-page-links']
    .map(name => ({ file: `${name}.raw.json`, list: 'pages', fields: ['url'] })),
  { file: 'major-pages.raw.json', list: 'pages', fields: ['url', 'finalUrl'] },
  { file: 'faculty.raw.json', list: '', fields: ['profileUrl'] },
  { file: 'hours.raw.json', list: '', fields: ['sourceUrl'] },
];

export function readSites(filePath: string): FolderSite[] {
  const { sites } = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { sites: FolderSite[] };
  return sites;
}

/** A list's reviewed section cuts, by page key. */
export function readSkippedSections(filePath: string): Map<string, SkippedSection[]> {
  const { skippedSections = [] } = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    skippedSections?: Array<SkippedSection & { url: string; reason: string }>;
  };
  const cuts = new Map<string, SkippedSection[]>();
  for (const { url, heading, andLater } of skippedSections) {
    const key = pageKey(url)!;
    cuts.set(key, [...cuts.get(key) ?? [], { heading, ...andLater ? { andLater } : {} }]);
  }
  return cuts;
}

/**
 * A page's sections without the reviewed cuts, or null when a cut's heading is not on the page:
 * the page has changed since the review, so it is left out rather than published uncut.
 */
export function cutSections<T extends { heading: string }>(sections: readonly T[], cuts: readonly SkippedSection[]): T[] | null {
  const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!cuts.every(cut => sections.some(section => same(section.heading, cut.heading)))) return null;
  let cuttingOn = false;
  return sections.filter(section => {
    const cut = cuts.find(candidate => same(section.heading, candidate.heading));
    if (cut?.andLater) cuttingOn = true;
    return !cut && !cuttingOn;
  });
}

/** A list's reviewed pages that are not collected, as page keys, with why. */
export function readSkippedPages(filePath: string): Map<string, string> {
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
 * serves a post type under its own name, as in /peer-facilitators/peers/ and each profile below it,
 * or under the path POST_TYPE_PATHS names. Posts are the exception, served by date (POST_PERMALINK).
 */
export function isSkippedPostTypePath(raw: string, skippedPostTypes: Readonly<Record<string, string>>): boolean {
  try {
    const segment = new URL(raw).pathname.split('/').filter(Boolean)[1]?.toLowerCase();
    if (segment === undefined) return false;
    return Object.keys(skippedPostTypes).some(type => type !== 'post'
      && (segment === type || segment === POST_TYPE_PATHS[type]));
  } catch {
    return false;
  }
}

/**
 * The captured pages WordPress marks as having no content of their own, as page keys: the page it
 * makes for each uploaded image or file (body class "attachment"), and a page behind a password,
 * which shows only its password form.
 */
export function wordpressShellPages(capture: Pick<RawSourceCaptureV1, 'pages'>): Set<string> {
  const keys = new Set<string>();
  for (const page of capture.pages) {
    const key = pageKey(page.url);
    const html = key ? sourceHtml(page) : '';
    const classes = html.match(BODY_CLASS)?.[2].split(/\s+/) ?? [];
    if (key && (classes.includes('attachment') || /\bpost-password-form\b/.test(html))) keys.add(key);
  }
  return keys;
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

/** The listed folder a www.ramapo.edu URL is in, or null. */
export function siteFolder(raw: string, folders: ReadonlySet<string>): string | null {
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

// Dated posts are skipped wherever they are listed.
function isSiteContent(url: URL, skippedPostTypes: Readonly<Record<string, string>>): boolean {
  return !DOCUMENT.test(url.pathname) && !WORDPRESS_SAMPLE.test(url.pathname) && !POST_PERMALINK.test(url.pathname)
    && !isSkippedPostTypePath(url.toString(), skippedPostTypes);
}

/**
 * The pages to collect from what the sitemaps list: pages in a listed folder, as https URLs
 * without fragments, once each, less pages collected elsewhere.
 */
export function sitePageUrls(
  listed: readonly string[],
  folders: ReadonlySet<string>,
  collectedElsewhere: ReadonlySet<string>,
  skippedPostTypes: Readonly<Record<string, string>>
): string[] {
  const pages = new Map<string, string>();
  for (const raw of listed) {
    if (!siteFolder(raw, folders)) continue;
    const url = new URL(raw);
    url.protocol = 'https:';
    url.hash = '';
    const key = pageKey(url.toString());
    if (!key || collectedElsewhere.has(key) || pages.has(key) || !isSiteContent(url, skippedPostTypes)) continue;
    pages.set(key, url.toString());
  }
  return [...pages.values()].sort();
}

/**
 * Whether a page a listed page links to should be collected as well: a page in a listed folder
 * that the sitemaps did not list, not a WordPress listing, and not kept by another collector.
 */
export function isUnlistedSitePage(
  url: URL,
  folders: ReadonlySet<string>,
  known: ReadonlySet<string>,
  skippedPostTypes: Readonly<Record<string, string>>,
  skippedPrefixes: ReadonlySet<string> = new Set()
): boolean {
  if (url.search || !siteFolder(url.toString(), folders) || !isSiteContent(url, skippedPostTypes)) return false;
  if (WORDPRESS_LISTING.test(url.pathname)) return false;
  const prefix = skippedPathPrefix(url.toString());
  const listing = `${url.pathname.replace(/\/+$/, '')}/`.toLowerCase();
  if ((prefix && skippedPrefixes.has(prefix)) || skippedPrefixes.has(listing)) return false;
  const key = pageKey(url.toString());
  return key !== null && !known.has(key);
}

/** The pages the given collectors kept successfully, as page keys. */
export function pagesCollectedElsewhere(collectors: readonly CollectedPages[], rawDir = RAW_DIR): Set<string> {
  const keys = new Set<string>();
  for (const { file, list, fields } of collectors) {
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

/**
 * A sitemap's XML from the answer to its request, or null when there is none: a 404, or a page that
 * is not a sitemap. Any other failure stops the collection, so a passing server error cannot quietly
 * change what is collected.
 */
export function sitemapXml(url: string, response: { ok: boolean; status: number; text(): string }): string | null {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The sitemap ${url} answered ${response.status}.`);
  const text = response.text();
  return /<(?:urlset|sitemapindex)[\s>]/.test(text) ? text : null;
}

async function fetchSitemap(url: string): Promise<string | null> {
  return sitemapXml(url, await fetchWithPolicy(url, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/xml,text/xml' },
  }, { attempts: 2 }));
}

/** Every URL the sites' sitemaps list, the skipped ones apart, with where each site's list came from. */
async function listedSitePages(
  sites: readonly FolderSite[],
  skippedPostTypes: Readonly<Record<string, string>>
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
        const skip = Object.hasOwn(skippedPostTypes, type);
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
    const own = listed.filter(url => siteFolder(url, new Set([site.folder])));
    report.push(`${site.folder}: ${own.length} listed (${sitemaps.length ? `WordPress sitemap: ${types.join(', ')}` : 'site-wide sitemap'})`);
    urls.push(...own);
  }
  return { urls, skipped, report };
}

/** Collects every page of a source's sites into data/raw/<dataset>.raw.json. With --list, only prints the pages. */
export async function collectFolderSites(source: FolderSiteSource, argv: readonly string[] = process.argv): Promise<void> {
  const outputPath = path.join(RAW_DIR, `${source.dataset}.raw.json`);
  const sites = readSites(source.sitesPath);
  const folders = new Set(sites.map(site => site.folder.toLowerCase()));
  const elsewhere = pagesCollectedElsewhere(source.collectedElsewhere);
  const reviewedSkips = readSkippedPages(source.sitesPath);
  const { urls, skipped, report } = await listedSitePages(sites, source.skippedPostTypes);
  report.forEach(line => console.log(line));
  const seedUrls = sitePageUrls(urls, folders, new Set([...elsewhere, ...reviewedSkips.keys()]), source.skippedPostTypes);
  if (!seedUrls.length) throw new Error(`The ${source.dataset} sitemaps list no pages to collect.`);
  console.log(`${seedUrls.length} pages to collect; ${skipped.length} listed pages skipped by post type; `
    + `${elsewhere.size} pages are kept by other collectors.`);
  if (argv.includes('--list')) {
    seedUrls.forEach(url => console.log(url));
    return;
  }
  const known = new Set([...elsewhere, ...reviewedSkips.keys(), ...[...seedUrls, ...skipped].map(url => pageKey(url)!)]);
  const skippedPrefixes = new Set(skipped.map(skippedPathPrefix).filter((prefix): prefix is string => prefix !== null)
    .filter(prefix => !POST_PERMALINK.test(`${prefix}x/`)));
  const dataset = await collectRawDataset({
    dataset: source.dataset,
    retainSourceHtml: true,
    compressSourceHtml: true,
    seedUrls,
    outputPath,
    allowedHost: SITE_HOST,
    requestIntervalMs: REQUEST_INTERVAL_MS,
    detailConcurrency: 1,
    detailUrlFilter: url => {
      if (!isUnlistedSitePage(url, folders, known, source.skippedPostTypes, skippedPrefixes)) return false;
      known.add(pageKey(url.toString())!);
      return true;
    },
    maxDetailPages: MAX_UNLISTED_PAGES,
    minimumPages: seedUrls.length,
    minimumSeedSuccessRate: 0.9,
    minimumPreviousPageRatio: 0.8,
  });
  console.log(`Saved ${dataset.pages.length} ${source.dataset} pages to ${outputPath} ` +
    `(${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`);
}

const succeeded = (page: RawDatasetV1['pages'][number]) =>
  page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400;

/**
 * Each site's pages as a dataset of their own, in the list's order; sites without pages are
 * left out. So are pages whose final URL is excluded: a reviewed skipped page, or a page
 * another collector keeps that a link reached by redirect. A page with reviewed section cuts
 * loses those sections.
 */
export function siteDatasets(
  dataset: RawDatasetV1,
  sites: readonly FolderSite[],
  skippedPostTypes: Readonly<Record<string, string>>,
  excluded: ReadonlySet<string> = new Set(),
  skippedSections: ReadonlyMap<string, readonly SkippedSection[]> = new Map()
): Array<{ site: FolderSite; dataset: RawDatasetV1 }> {
  return sites.flatMap(site => {
    const own = new Set([site.folder.toLowerCase()]);
    const pages = dataset.pages.filter(page => siteFolder(page.url, own)
      && !isSkippedPostTypePath(page.url, skippedPostTypes) && !excluded.has(pageKey(page.url) ?? ''))
      .flatMap(page => {
        const cuts = skippedSections.get(pageKey(page.url) ?? '');
        if (!cuts) return [page];
        const sections = cutSections(page.sections, cuts);
        if (sections) return [{ ...page, sections }];
        console.warn(`A reviewed section cut no longer matches ${page.url}, so the page is left out.`);
        return [];
      });
    if (!pages.length) return [];
    const pagesFetched = pages.filter(succeeded).length;
    return [{
      site,
      dataset: {
        ...dataset,
        seedUrls: dataset.seedUrls.filter(url => siteFolder(url, own)),
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

/**
 * One context document per site, titled with the site's name, so every passage's heading path
 * names the site it came from. A sidebar block or document list repeated on half the site's
 * pages or more is written once, under "Site-wide sections". Each page is cited to its URL and
 * capture time. The documents to write, by file name.
 */
export function siteDocuments(
  dataset: RawDatasetV1,
  sites: readonly FolderSite[],
  skippedPostTypes: Readonly<Record<string, string>>,
  excluded: ReadonlySet<string> = new Set(),
  skippedSections: ReadonlyMap<string, readonly SkippedSection[]> = new Map()
): Map<string, { markdown: string; pages: number }> {
  const documents = new Map<string, { markdown: string; pages: number }>();
  for (const { site, dataset: siteDataset } of siteDatasets(dataset, sites, skippedPostTypes, excluded, skippedSections)) {
    const document = core6Markdown(siteDataset, {
      title: site.name,
      description: `Pages of Ramapo College's ${site.name} site (https://www.ramapo.edu/${site.folder}/), `
        + 'each under its own title with the page it came from.',
      hoistRepeatedSections: true,
    });
    if (document.pages) documents.set(`${site.folder}.md`, document);
  }
  return documents;
}

/**
 * Writes a source's documents from data/normalized/<dataset>.json, which normalize:raw replays
 * from the captured HTML, into outputDir, replacing what was there. Image, file and
 * password-protected pages are left out, found by their captured HTML in
 * data/raw/<dataset>-sources.raw.json.
 */
export function writeSiteDocuments(source: FolderSiteSource, outputDir: string): void {
  const input = path.join(process.cwd(), 'data', 'normalized', `${source.dataset}.json`);
  const dataset = validateRawDatasetV1(JSON.parse(fs.readFileSync(input, 'utf8')));
  if (dataset.dataset !== source.dataset) throw new Error(`${input} holds ${dataset.dataset}, not ${source.dataset}.`);
  const sites = readSites(source.sitesPath);
  const capture = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${source.dataset}-sources.raw.json`), 'utf8')) as RawSourceCaptureV1;
  const shells = wordpressShellPages(capture);
  const documents = siteDocuments(dataset, sites, source.skippedPostTypes, new Set([
    ...readSkippedPages(source.sitesPath).keys(), ...pagesCollectedElsewhere(source.collectedElsewhere), ...shells,
  ]), readSkippedSections(source.sitesPath));
  // Rewrite the folder, so a site that no longer has pages leaves no document behind.
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  let pages = 0;
  for (const [file, document] of documents) {
    fs.writeFileSync(path.join(outputDir, file), document.markdown);
    pages += document.pages;
  }
  const folders = new Set(sites.map(site => site.folder.toLowerCase()));
  const unplaced = dataset.pages.filter(page => succeeded(page) && !siteFolder(page.url, folders));
  unplaced.forEach(page => console.warn(`Not in a listed folder after redirects, so not written: ${page.url}`));
  console.log(`Wrote ${pages} pages of ${documents.size} sites to ${path.relative(process.cwd(), outputDir)}; `
    + `left out ${shells.size} image, file and password-protected pages.`);
}
