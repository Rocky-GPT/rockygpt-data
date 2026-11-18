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
 * An Events Calendar event page stays up after its event and reads as coming up, so it leaves
 * publication the day after its event ends on campus (pastEventPages), with no list line to add.
 *
 * Requests go one at a time, one a second.
 *
 * The sitemaps are read every night, but only the lists that hold pages this source keeps. A
 * site's sitemap index and its lists of skipped post types only say what exists and what to skip,
 * and they rarely change, so they are read once a week, on each site's own night, and kept in
 * data/raw/<dataset>-sitemaps.json between runs (with every kept page's edit time, which the
 * smaller Ramapo site collectors read too). About 400 sitemap requests a night became about 180
 * (11-18).
 */

import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import { CAMPUS_TIME_ZONE } from '../src/data-v2/event-time';
import { core6Markdown, core6Pages, type WrittenPage } from './generate-core6-md-utils';
import { DEFAULT_USER_AGENT, fetchWithPolicy } from './http-client';
import { collectRawDataset, createRequestPacer, ownNight, type RawSourceCaptureV1, sourceHtml } from './raw-collector';
import { OFFICE_HOURS_PAGES } from './campus-hours';
import { noteSiteDownloads } from './site-guard';
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
  /** Pages this collector reads one detail from, not their text, so a site source keeps them. */
  except?: readonly string[];
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
// Pages a listed page links to that no sitemap lists (a site's policy pages): 500 left the
// Provost's policy pages uncollected (October 19, 2026).
const MAX_UNLISTED_PAGES = 1500;
/** Nights between downloads of a page no sitemap gives an edit time for: weekly, as before the nightly date check. */
export const UNDATED_REUSE_DAYS = 7;
/** Nights between asks of a page that answered "not found" or was not a page: monthly (11-18). */
export const DEAD_REUSE_DAYS = 28;
/** Nights between reads of a site's sitemap index and its skipped post types' lists. */
export const SITEMAP_INDEX_DAYS = 7;
/** WordPress puts at most this many entries in one list; a full list may have gained a second one. */
const SITEMAP_MAX_ENTRIES = 2000;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|jpe?g|png|gif|zip|mp3|mp4)$/i;
// Listings WordPress builds from posts (archives, feeds) and its own endpoints, not pages.
const WORDPRESS_LISTING =
  /\/(?:category|tag|author|feed|comments|page|wp-json|wp-content|wp-admin|wp-includes)(?:\/|$)|\/\d{4}(?:\/\d{2}){0,2}\/?$|\/wp-[a-z-]+\.php$/i;
// WordPress creates both when a site is set up; no Ramapo site wrote them.
const WORDPRESS_SAMPLE = /\/(?:hello-world|sample-page)\/?$/i;
// A dated post's permalink, /folder/2019/03/01/slug/, and anything below it, such as its images' pages.
const POST_PERMALINK = /\/\d{4}\/\d{2}\/\d{2}\/[^/]+(?:\/|$)/;
// Post types WordPress serves under a path other than their own name: The Events Calendar's venues, organizers and series.
const POST_TYPE_PATHS: Readonly<Record<string, string>> = {
  tribe_venue: 'venue', tribe_organizer: 'organizer', tribe_event_series: 'series',
};
const BODY_CLASS = /<body\b[^>]*\bclass\s*=\s*(["'])([^"']*)\1/i;
// The Events Calendar keeps an event's full date in its date elements' title: title="2026-12-04".
const EVENT_END_DATE = 'abbr.tribe-events-end-date[title], abbr.tribe-events-end-datetime[title]';
const EVENT_START_DATE = 'abbr.tribe-events-start-date[title], abbr.tribe-events-start-datetime[title]';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * The Ramapo site collectors every folder-site source leaves alone, and the fields that name
 * the pages they keep. A page any of them kept successfully is theirs.
 */
export const RAMAPO_SITE_COLLECTORS: readonly CollectedPages[] = [
  ...['directory', 'housing', 'health', 'counseling', 'safety', 'transportation', 'major-page-links']
    .map(name => ({ file: `${name}.raw.json`, list: 'pages', fields: ['url'] })),
  { file: 'major-pages.raw.json', list: 'pages', fields: ['url', 'finalUrl'] },
  { file: 'faculty.raw.json', list: '', fields: ['profileUrl'] },
  // The hours collector reads only the schedule line from office home pages; their text,
  // staff lists included, stays in the office sites' documents.
  { file: 'hours.raw.json', list: '', fields: ['sourceUrl'], except: OFFICE_HOURS_PAGES.map(page => page.url) },
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

/**
 * When a WordPress sitemap says each page was last edited, by page key; a page listed twice keeps
 * the later time, and an entry without a readable time is left out. Only a site's own WordPress
 * sitemaps carry real edit times: the site-wide sitemap's are the day a crawler made it.
 */
export function sitemapEditTimes(xml: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const [entry] of xml.matchAll(/<url>[\s\S]*?<\/url>/g)) {
    const [loc] = sitemapLocs(entry);
    const lastmod = entry.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1];
    const key = loc ? pageKey(loc) : null;
    if (!key || !lastmod || !Number.isFinite(Date.parse(lastmod))) continue;
    const before = times.get(key);
    if (!before || Date.parse(lastmod) > Date.parse(before)) times.set(key, lastmod);
  }
  return times;
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

/** A time's date on campus, as YYYY-MM-DD: a UTC date is already tomorrow after 8 p.m. (7 p.m. in winter). */
export function campusDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

/** An Events Calendar event's last day, as YYYY-MM-DD: its end date, or its start date when it has none. */
export function eventLastDay(html: string): string | null {
  const $ = load(html);
  const title = $(EVENT_END_DATE).first().attr('title') ?? $(EVENT_START_DATE).first().attr('title');
  return title?.match(ISO_DATE)?.[0] ?? null;
}

/**
 * The captured Events Calendar event pages (body class "single-tribe_events") whose event ended
 * before today, a campus date, as page keys. An event still on today stays, and so does an event
 * page without a date.
 */
export function pastEventPages(capture: Pick<RawSourceCaptureV1, 'pages'>, today: string): Set<string> {
  const keys = new Set<string>();
  for (const page of capture.pages) {
    const key = pageKey(page.url);
    const html = key ? sourceHtml(page) : '';
    const classes = html.match(BODY_CLASS)?.[2].split(/\s+/) ?? [];
    if (!key || !classes.includes('single-tribe_events')) continue;
    const lastDay = eventLastDay(html);
    if (lastDay && lastDay < today) keys.add(key);
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
  for (const { file, list, fields, except = [] } of collectors) {
    const shared = new Set(except.map(pageKey));
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
        if (key && !shared.has(key)) keys.add(key);
      }
    }
  }
  return keys;
}

/**
 * A sitemap's XML from the answer to its request, or null when there is none: a 404 or a 410 (the
 * college has taken the site down), or a page that is not a sitemap. Any other failure stops the
 * collection, so a passing server error cannot quietly change what is collected.
 */
export function sitemapXml(url: string, response: { ok: boolean; status: number; text(): string }): string | null {
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`The sitemap ${url} answered ${response.status}.`);
  const text = response.text();
  return /<(?:urlset|sitemapindex)[\s>]/.test(text) ? text : null;
}

async function fetchSitemap(url: string): Promise<string | null> {
  return sitemapXml(url, await fetchWithPolicy(url, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/xml,text/xml' },
  }, { attempts: 2 }));
}

/** One list of a site's WordPress sitemap index, as kept between runs. */
export interface KeptSitemap {
  url: string;
  type: string;
  /** A skipped post type's list: its pages, kept so the list need not be read every night. */
  skippedLocs?: string[];
  /** A kept post type's list that was full, so its site's index is read every night. */
  full?: boolean;
}

/** What a source kept of its sites' sitemaps between runs (data/raw/<dataset>-sitemaps.json). */
export interface SitemapState {
  version: 1;
  /** When tonight's kept lists were read, so a reader of editedAt knows how current it is. */
  readAt: string;
  /** Per site folder: when its index was last read, and its lists; null = the site has no WordPress sitemap. */
  sites: Record<string, { indexReadAt: string; sitemaps: KeptSitemap[] | null }>;
  siteWide?: { readAt: string; locs: string[] };
  /** Every kept page's edit time from its site's WordPress sitemap, by page key. */
  editedAt: Record<string, string>;
}

const DAY_MS = 86_400_000;
const nightOf = (time: number) => Math.floor(time / DAY_MS);

/** The sitemap state a source kept from its last run, or null when it has none or it cannot be read. */
export function readSitemapState(filePath: string): SitemapState | null {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SitemapState;
    return state?.version === 1 && state.sites && typeof state.sites === 'object' ? state : null;
  } catch {
    return null;
  }
}

/**
 * Whether tonight reads a site's sitemap index (and its skipped lists) again: it was never read or
 * its read is a whole cycle old, it is the site's own night in the cycle, or one of its kept lists
 * was full (WordPress may have added a second list).
 */
export function readIndexTonight(folder: string, kept: SitemapState['sites'][string] | undefined, now: number,
  days = SITEMAP_INDEX_DAYS): boolean {
  if (!kept) return true;
  const readAt = Date.parse(kept.indexReadAt);
  if (!Number.isFinite(readAt) || now - readAt >= days * DAY_MS || readAt > now) return true;
  if (kept.sitemaps?.some(sitemap => sitemap.full)) return true;
  const tonight = nightOf(now);
  return tonight % days === ownNight(folder, days) && nightOf(readAt) < tonight;
}

/** Every URL the sites' sitemaps list, the skipped ones apart, with where each site's list came from. */
export async function listedSitePages(
  sites: readonly FolderSite[],
  skippedPostTypes: Readonly<Record<string, string>>,
  kept: SitemapState | null = null,
  now = Date.now(),
  fetchXml: (url: string) => Promise<string | null> = fetchSitemap
): Promise<{ urls: string[]; skipped: string[]; report: string[]; editedAt: Map<string, string>;
  state: SitemapState; requests: number; keptReads: number }> {
  const pace = createRequestPacer(REQUEST_INTERVAL_MS);
  let requests = 0;
  const read = async (url: string) => {
    await pace();
    requests += 1;
    return fetchXml(url);
  };
  const nowIso = new Date(now).toISOString();
  let siteWide: string[] | undefined;
  const keptSiteWide = kept?.siteWide && now - Date.parse(kept.siteWide.readAt) < SITEMAP_INDEX_DAYS * DAY_MS
    ? kept.siteWide : undefined;
  const state: SitemapState = { version: 1, readAt: nowIso, sites: {}, editedAt: {} };
  const urls: string[] = [];
  const skipped: string[] = [];
  const report: string[] = [];
  const editedAt = new Map<string, string>();
  let keptReads = 0;
  const siteWideLocs = async (): Promise<string[]> => {
    if (siteWide) return siteWide;
    if (keptSiteWide) {
      siteWide = keptSiteWide.locs;
      state.siteWide = keptSiteWide;
      return siteWide;
    }
    const xml = await read(SITE_WIDE_SITEMAP);
    if (!xml) throw new Error(`The site-wide sitemap ${SITE_WIDE_SITEMAP} could not be read.`);
    siteWide = sitemapLocs(xml);
    state.siteWide = { readAt: nowIso, locs: siteWide };
    return siteWide;
  };
  // A site's lists: from its index tonight, or from the last read of it (kept) on the other nights.
  const readSite = async (site: FolderSite, fromKept: SitemapState['sites'][string] | undefined) => {
    let sitemaps: KeptSitemap[] | null;
    let indexReadAt = nowIso;
    if (fromKept) {
      sitemaps = fromKept.sitemaps;
      indexReadAt = fromKept.indexReadAt;
    } else {
      const index = await read(`${SITE}/${site.folder}/wp-sitemap.xml`);
      const listed = index ? contentSitemaps(index) : [];
      sitemaps = listed.length ? listed.map(url => ({ url, type: sitemapPostType(url) ?? '' })) : null;
    }
    const own: string[] = [];
    const siteSkipped: string[] = [];
    const types: string[] = [];
    const keptLists: KeptSitemap[] = [];
    if (sitemaps) {
      for (const sitemap of sitemaps) {
        const skip = Object.hasOwn(skippedPostTypes, sitemap.type);
        let locs: string[];
        if (skip && fromKept && sitemap.skippedLocs) {
          locs = sitemap.skippedLocs;
        } else {
          const xml = await read(sitemap.url);
          // A list gone since the index was read: the site changed, so read its index again tonight.
          if (!xml && fromKept) return null;
          if (!xml) throw new Error(`${site.folder}: its sitemap ${sitemap.url} could not be read.`);
          locs = sitemapLocs(xml);
          if (!skip) {
            keptReads += 1;
            for (const [key, time] of sitemapEditTimes(xml)) {
              const before = editedAt.get(key);
              if (!before || Date.parse(time) > Date.parse(before)) editedAt.set(key, time);
            }
          }
        }
        types.push(`${sitemap.type} ${locs.length}${skip ? ' skipped' : ''}`);
        (skip ? siteSkipped : own).push(...locs);
        keptLists.push({ url: sitemap.url, type: sitemap.type,
          ...(skip ? { skippedLocs: locs } : {}), ...(!skip && locs.length >= SITEMAP_MAX_ENTRIES ? { full: true } : {}) });
      }
    } else {
      own.push(...await siteWideLocs());
    }
    return { own, siteSkipped, types, entry: { indexReadAt, sitemaps: sitemaps ? keptLists : null } };
  };
  for (const site of sites) {
    const keptSite = kept?.sites?.[site.folder];
    const fresh = !readIndexTonight(site.folder, keptSite, now) ? keptSite : undefined;
    const result = (fresh ? await readSite(site, fresh) : null) ?? await readSite(site, undefined);
    if (!result) throw new Error(`${site.folder}: its sitemap could not be read.`);
    state.sites[site.folder] = result.entry;
    const listed = result.own.filter(url => siteFolder(url, new Set([site.folder])));
    report.push(`${site.folder}: ${listed.length} listed (${result.entry.sitemaps
      ? `WordPress sitemap: ${result.types.join(', ')}` : 'site-wide sitemap'})`);
    urls.push(...listed);
    skipped.push(...result.siteSkipped);
  }
  state.editedAt = Object.fromEntries(editedAt);
  return { urls, skipped, report, editedAt, state, requests, keptReads };
}

/** Collects every page of a source's sites into data/raw/<dataset>.raw.json. With --list, only prints the pages. */
export async function collectFolderSites(source: FolderSiteSource, argv: readonly string[] = process.argv): Promise<void> {
  const outputPath = path.join(RAW_DIR, `${source.dataset}.raw.json`);
  const sites = readSites(source.sitesPath);
  const folders = new Set(sites.map(site => site.folder.toLowerCase()));
  const elsewhere = pagesCollectedElsewhere(source.collectedElsewhere);
  const reviewedSkips = readSkippedPages(source.sitesPath);
  const statePath = path.join(RAW_DIR, `${source.dataset}-sitemaps.json`);
  const listing = await listedSitePages(sites, source.skippedPostTypes, readSitemapState(statePath));
  const { urls, skipped, report, editedAt } = listing;
  report.forEach(line => console.log(line));
  noteSiteDownloads(`${source.dataset} sitemaps: ${listing.requests} read (${listing.keptReads} lists of kept pages, ` +
    `${listing.requests - listing.keptReads} indexes and skipped lists on their weekly night), ${sites.length} sites.`);
  const seedUrls = sitePageUrls(urls, folders, new Set([...elsewhere, ...reviewedSkips.keys()]), source.skippedPostTypes);
  if (!seedUrls.length) throw new Error(`The ${source.dataset} sitemaps list no pages to collect.`);
  console.log(`${seedUrls.length} pages to collect; ${skipped.length} listed pages skipped by post type; `
    + `${elsewhere.size} pages are kept by other collectors.`);
  if (argv.includes('--list')) {
    seedUrls.forEach(url => console.log(url));
    return;
  }
  // Kept for the next run, and for the smaller Ramapo site collectors' edit times (page-dates.ts).
  fs.writeFileSync(statePath, `${JSON.stringify(listing.state)}\n`);
  const known = new Set([...elsewhere, ...reviewedSkips.keys(), ...[...seedUrls, ...skipped].map(url => pageKey(url)!)]);
  const skippedPrefixes = new Set(skipped.map(skippedPathPrefix).filter((prefix): prefix is string => prefix !== null)
    .filter(prefix => !POST_PERMALINK.test(`${prefix}x/`)));
  const dataset = await collectRawDataset({
    dataset: source.dataset,
    retainSourceHtml: true,
    compressSourceHtml: true,
    // Collected every night: a page its site's sitemap says nobody edited since the last download is
    // downloaded again only on its own night every four weeks; a page no sitemap dates (a site without
    // a WordPress sitemap, a page found only through a link) on its own night every week.
    listedEditedAt: url => editedAt.get(pageKey(url) ?? ''),
    undatedReuseDays: UNDATED_REUSE_DAYS,
    deadReuseDays: DEAD_REUSE_DAYS,
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

// Each site's document writes a sidebar block or document list repeated on half its pages once.
const SITE_PAGE_LAYOUT = { hoistRepeatedSections: true } as const;

/** Each site's pages as its context document writes them (siteDocuments), in the list's order. */
export function sitePages(
  dataset: RawDatasetV1,
  sites: readonly FolderSite[],
  skippedPostTypes: Readonly<Record<string, string>>,
  excluded: ReadonlySet<string> = new Set(),
  skippedSections: ReadonlyMap<string, readonly SkippedSection[]> = new Map()
): Array<{ site: FolderSite; pages: WrittenPage[] }> {
  return siteDatasets(dataset, sites, skippedPostTypes, excluded, skippedSections)
    .map(({ site, dataset: siteDataset }) => ({ site, pages: core6Pages(siteDataset, SITE_PAGE_LAYOUT) }));
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
      ...SITE_PAGE_LAYOUT,
    });
    if (document.pages) documents.set(`${site.folder}.md`, document);
  }
  return documents;
}

/**
 * What a source's documents are written from: data/normalized/<dataset>.json, which normalize:raw
 * replays from the captured HTML, its sites, and the pages and sections left out. Image, file and
 * password-protected pages are left out, and so are pages of events that ended before now's
 * campus date, found by their captured HTML in data/raw/<dataset>-sources.raw.json.
 */
export function readPublishedPages(source: FolderSiteSource, now = new Date()) {
  const input = path.join(process.cwd(), 'data', 'normalized', `${source.dataset}.json`);
  const dataset = validateRawDatasetV1(JSON.parse(fs.readFileSync(input, 'utf8')));
  if (dataset.dataset !== source.dataset) throw new Error(`${input} holds ${dataset.dataset}, not ${source.dataset}.`);
  const sites = readSites(source.sitesPath);
  const capture = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${source.dataset}-sources.raw.json`), 'utf8')) as RawSourceCaptureV1;
  const shells = wordpressShellPages(capture);
  const pastEvents = pastEventPages(capture, campusDate(now));
  const excluded = new Set([
    ...readSkippedPages(source.sitesPath).keys(), ...pagesCollectedElsewhere(source.collectedElsewhere), ...shells, ...pastEvents,
  ]);
  return { dataset, sites, shells, pastEvents, excluded, skippedSections: readSkippedSections(source.sitesPath) };
}

/** Writes a source's documents (readPublishedPages) into outputDir, replacing what was there. */
export function writeSiteDocuments(source: FolderSiteSource, outputDir: string): void {
  const { dataset, sites, shells, pastEvents, excluded, skippedSections } = readPublishedPages(source);
  const documents = siteDocuments(dataset, sites, source.skippedPostTypes, excluded, skippedSections);
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
    + `left out ${shells.size} image, file and password-protected pages and ${pastEvents.size} pages of events that have ended.`);
}
