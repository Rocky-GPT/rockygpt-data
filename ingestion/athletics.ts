/**
 * athletics.ts
 *
 * Ramapo's varsity teams from the college's athletics site (src/data-v2/athletics.ts):
 *   npm run fetch:athletics-schedules   each team's schedule page (daily source)
 *   npm run fetch:athletics-coaches     each team's coaches page (weekly source)
 *   npm run fetch:athletics-pages       the site's reviewed information pages (weekly source):
 *                                       intramurals and Bradley Center memberships, read
 *                                       into headed sections like the office pages, and published
 *                                       as the Athletics office's own pages (office_sections)
 *
 * The site's robots.txt asks every robot for 30 seconds between requests, so this reads one page
 * at a time, ATHLETICS_GAP_MS apart: 16 schedule pages took about 8 minutes every night. A team
 * out of season (no game in the days around today on its last copy) keeps that copy for up to
 * OFF_SEASON_KEEP_DAYS, so a night reads only the teams in season (inSeasonOrDue). It reads robots.txt
 * first and stops if the team pages are no longer allowed or a longer delay is asked for. Player
 * rosters are never read. A page that fails keeps last capture's copy when there is one.
 *
 * Each page's HTML is saved without its scripts, styles and images; the graph build reads it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { DEFAULT_USER_AGENT, fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawFileProvenance } from './pipeline-utils';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawPageV1 } from './raw-types';
import { noteSiteDownloads, robotsFor, type SiteRobots } from './site-guard';
import reviewedTeams from '../src/reference/athletics-teams.json';
import { ATHLETICS_COACHES_SOURCE, ATHLETICS_SCHEDULES_SOURCE, athleticsCapture, parseSchedule, type AthleticsCapture,
  type AthleticsPage, type ReviewedAthletics } from '../src/data-v2/athletics';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
/** The robots.txt crawl delay (30 s), never less. */
export const ATHLETICS_GAP_MS = 30_000;
/** How long an out-of-season team's schedule copy is kept before it is read again. */
export const OFF_SEASON_KEEP_DAYS = 7;
/** A game this many days before or after today puts the team in season (results, next games). */
export const SEASON_DAYS_BEFORE = 3;
export const SEASON_DAYS_AFTER = 14;
const DAY_MS = 86_400_000;

/**
 * Whether tonight must read a team's schedule page: when there is no good last copy, when that
 * copy is OFF_SEASON_KEEP_DAYS old, when it lists no game date at all that could be read, or when
 * one of its games falls from SEASON_DAYS_BEFORE days ago to SEASON_DAYS_AFTER days ahead. A
 * season's first schedule posted while the team was out of season is read within the week.
 */
export function inSeasonOrDue(previous: AthleticsPage | undefined, now: Date): boolean {
  if (!previous || previous.status !== 200 || !previous.html) return true;
  const age = now.getTime() - Date.parse(previous.fetchedAt);
  if (!(age >= 0 && age < OFF_SEASON_KEEP_DAYS * DAY_MS)) return true;
  let dates: number[];
  try {
    dates = parseSchedule(previous.html).games.map(game => Date.parse(`${game.date}T12:00:00Z`)).filter(Number.isFinite);
  } catch {
    return true;
  }
  if (!dates.length) return true;
  const from = now.getTime() - SEASON_DAYS_BEFORE * DAY_MS - DAY_MS;
  const until = now.getTime() + SEASON_DAYS_AFTER * DAY_MS + DAY_MS;
  return dates.some(date => date >= from && date <= until);
}

export const ATHLETICS_PAGES_DATASET = 'athletics-pages';

const PAGES = { schedules: { dataset: ATHLETICS_SCHEDULES_SOURCE, path: 'schedule' }, coaches: { dataset: ATHLETICS_COACHES_SOURCE, path: 'coaches' } } as const;

/**
 * The site's robots.txt rules (site-guard reads it once a run, with robots-parser). The run stops
 * when robots.txt cannot be read, or asks for a longer gap than ATHLETICS_GAP_MS.
 */
async function athleticsRobots(site: string): Promise<SiteRobots> {
  const robots = await robotsFor(site);
  if (robots.unreadable) throw new Error(`${robots.unreadable}; not reading the site without it.`);
  if (robots.delayMs > ATHLETICS_GAP_MS) {
    throw new Error(`${site} now asks for ${robots.delayMs / 1000} s between requests; ATHLETICS_GAP_MS is ${ATHLETICS_GAP_MS / 1000} s.`);
  }
  return robots;
}

/** A page's HTML without scripts, styles, images and frames (JSON-LD data is kept). */
export function trimPage(html: string): string {
  const $ = cheerio.load(html);
  $('script:not([type="application/ld+json"]), style, noscript, svg, iframe, link, meta, img, picture, source').remove();
  return ($.html() ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main(kind: keyof typeof PAGES): Promise<void> {
  const reviewed = reviewedTeams as ReviewedAthletics;
  const { dataset, path: pagePath } = PAGES[kind];
  const rawFile = path.join(RAW_DIR, `${dataset}.raw.json`);
  const previous = fs.existsSync(rawFile) ? athleticsCapture(JSON.parse(fs.readFileSync(rawFile, 'utf8'))) : undefined;
  const get = (url: string) => fetchWithPolicy(url, { headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/html,text/plain' } },
    { perHostConcurrency: 1, attempts: 2, timeoutMs: 30_000 });

  const robots = await athleticsRobots(reviewed.site);
  const pages: AthleticsPage[] = [];
  let read = 0;
  let kept = 0;
  let reused = 0;
  const now = new Date();
  for (const team of reviewed.teams) {
    const url = `${reviewed.site}/sports/${team.slug}/${pagePath}`;
    if (!robots.allows(url)) throw new Error(`${reviewed.site}/robots.txt no longer allows ${url}.`);
    const last = previous?.pages.find(p => p.team === team.slug && p.url === url);
    if (kind === 'schedules' && last && !inSeasonOrDue(last, now)) {
      pages.push(last);
      reused += 1;
      continue;
    }
    await sleep(ATHLETICS_GAP_MS);
    const fetchedAt = new Date().toISOString();
    let page: AthleticsPage;
    try {
      const response = await get(url);
      const html = response.ok ? trimPage(response.text()) : undefined;
      page = { team: team.slug, url, status: response.status, fetchedAt,
        ...html ? { html, contentHash: createHash('sha256').update(html).digest('hex') } : {} };
    } catch (error) {
      page = { team: team.slug, url, status: 0, fetchedAt };
      console.warn(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (page.status === 200) read += 1;
    else {
      // Last capture's copy stands in for a page that failed tonight; it keeps its own date.
      const old = previous?.pages.find(p => p.team === team.slug && p.status === 200 && p.html);
      if (old) { page = old; kept += 1; }
      console.warn(`${url} answered ${page.status === 200 ? 'with an error; kept the last copy' : page.status}.`);
    }
    pages.push(page);
  }
  if (!read && !reused) throw new Error(`No ${kind} page could be read from ${reviewed.site}.`);
  const generatedAt = new Date().toISOString();
  const capture: AthleticsCapture = { schemaVersion: 1, dataset, generatedAt, site: reviewed.site, pages };
  writeJsonFile(rawFile, capture);
  writeRawFileProvenance(dataset, rawFile, { sourceUrl: reviewed.site, recordCount: read + reused, fetchedAt: generatedAt });
  noteSiteDownloads(`${dataset}: read ${read} of ${reviewed.teams.length} pages from ${reviewed.site}${kept ? `, kept last copy of ${kept}` : ''}`
    + `${reused ? `, ${reused} out of season kept their copy under ${OFF_SEASON_KEEP_DAYS} days old` : ''} (${ATHLETICS_GAP_MS / 1000} s apart).`);
}

/** The site's reviewed information pages, read into headed sections (raw-collector's reader) and
 * kept as athletics-pages.raw.json, which the publish reads with every other captured page. */
export interface AthleticsPagesCapture { schemaVersion: 1; dataset: string; generatedAt: string; site: string; pages: RawPageV1[] }

async function readInfoPages(): Promise<void> {
  const reviewed = reviewedTeams as ReviewedAthletics;
  const listed = reviewed.pages ?? [];
  const rawFile = path.join(RAW_DIR, `${ATHLETICS_PAGES_DATASET}.raw.json`);
  const previous = fs.existsSync(rawFile) ? (JSON.parse(fs.readFileSync(rawFile, 'utf8')) as AthleticsPagesCapture).pages ?? [] : [];
  const get = (url: string) => fetchWithPolicy(url, { headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/html,text/plain' } },
    { perHostConcurrency: 1, attempts: 2, timeoutMs: 30_000 });
  const robots = await athleticsRobots(reviewed.site);
  const pages: RawPageV1[] = [];
  let read = 0;
  let kept = 0;
  for (const { url } of listed) {
    const target = new URL(url);
    if (!robots.allows(target)) {
      console.warn(`${reviewed.site}/robots.txt does not allow ${url}; not read.`);
      continue;
    }
    await sleep(ATHLETICS_GAP_MS);
    const fetchedAt = new Date().toISOString();
    let page: RawPageV1 | undefined;
    try {
      const response = await get(url);
      if (response.ok) {
        page = buildRawPageFromHtml({ url, html: response.text(), sourceType: 'seed', fetchedAt, statusCode: response.status,
          allowedHost: target.hostname });
      } else console.warn(`${url} answered ${response.status}.`);
    } catch (error) {
      console.warn(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (page?.sections.length) {
      pages.push(page);
      read += 1;
      continue;
    }
    // Last capture's copy stands in for a page that failed tonight; it keeps its own date.
    const old = previous.find(p => p.url === page?.url || p.url === url);
    if (old) { pages.push(old); kept += 1; }
    if (page && !page.sections.length) console.warn(`${url}: no section could be read${old ? '; kept the last copy' : ''}.`);
  }
  // No page read and no last copy writes an empty capture with a warning, not a stop: these pages
  // add to the Athletics office's own and never hold up the night's publish.
  if (listed.length && !read && !kept) console.warn(`::warning::No information page could be read from ${reviewed.site}.`);
  const generatedAt = new Date().toISOString();
  const capture: AthleticsPagesCapture = { schemaVersion: 1, dataset: ATHLETICS_PAGES_DATASET, generatedAt, site: reviewed.site, pages };
  writeJsonFile(rawFile, capture);
  writeRawFileProvenance(ATHLETICS_PAGES_DATASET, rawFile, { sourceUrl: reviewed.site, recordCount: pages.length, fetchedAt: generatedAt });
  noteSiteDownloads(`${ATHLETICS_PAGES_DATASET}: read ${read} of ${listed.length} pages from ${reviewed.site}`
    + `${kept ? `, kept last copy of ${kept}` : ''} (${ATHLETICS_GAP_MS / 1000} s apart).`);
}

if (process.argv[1]?.endsWith('athletics.ts')) {
  const kind = process.argv[2];
  const fatal = (error: unknown) => { console.error('Fatal:', error instanceof Error ? error.message : error); process.exitCode = 1; };
  if (kind === 'pages') readInfoPages().catch(fatal);
  else if (kind !== 'schedules' && kind !== 'coaches') {
    console.error('Usage: tsx ingestion/athletics.ts schedules|coaches|pages');
    process.exitCode = 1;
  } else {
    main(kind).catch(fatal);
  }
}
