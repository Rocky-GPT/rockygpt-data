/**
 * athletics.ts
 *
 * Ramapo's varsity teams from the college's athletics site (src/data-v2/athletics.ts):
 *   npm run fetch:athletics-schedules   each team's schedule page (daily source)
 *   npm run fetch:athletics-coaches     each team's coaches page (weekly source)
 *
 * The site's robots.txt asks every robot for 30 seconds between requests, so this reads one page
 * at a time, ATHLETICS_GAP_MS apart: 16 schedule pages take about 8 minutes. It reads robots.txt
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
import { noteSiteDownloads } from './site-guard';
import reviewedTeams from '../src/reference/athletics-teams.json';
import { ATHLETICS_COACHES_SOURCE, ATHLETICS_SCHEDULES_SOURCE, athleticsCapture, type AthleticsCapture,
  type AthleticsPage, type ReviewedAthletics } from '../src/data-v2/athletics';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
/** The robots.txt crawl delay (30 s), never less. */
export const ATHLETICS_GAP_MS = 30_000;
const PAGES = { schedules: { dataset: ATHLETICS_SCHEDULES_SOURCE, path: 'schedule' }, coaches: { dataset: ATHLETICS_COACHES_SOURCE, path: 'coaches' } } as const;

/** The rules of a robots.txt group for every robot (`User-agent: *`). */
export function robotsRules(robots: string): { allow: string[]; disallow: string[]; delaySeconds: number } {
  const rules = { allow: [] as string[], disallow: [] as string[], delaySeconds: 0 };
  let inGroup = false;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group.
      inGroup = (lastWasAgent && inGroup) || value === '*';
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!inGroup) continue;
    if (field === 'allow' && value) rules.allow.push(value);
    if (field === 'disallow' && value) rules.disallow.push(value);
    if (field === 'crawl-delay' && Number.isFinite(Number(value))) rules.delaySeconds = Number(value);
  }
  return rules;
}

const pattern = (rule: string) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);

/** Whether a path may be read: the longest matching rule wins, and Allow wins a tie. */
export function robotsAllows(rules: { allow: string[]; disallow: string[] }, pathname: string): boolean {
  const longest = (list: string[]) => Math.max(-1, ...list.filter(rule => pattern(rule).test(pathname)).map(rule => rule.length));
  return longest(rules.allow) >= longest(rules.disallow);
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

  const robots = await get(`${reviewed.site}/robots.txt`);
  if (!robots.ok) throw new Error(`${reviewed.site}/robots.txt answered ${robots.status}; not reading the site without it.`);
  const rules = robotsRules(robots.text());
  if (rules.delaySeconds * 1000 > ATHLETICS_GAP_MS) {
    throw new Error(`${reviewed.site} now asks for ${rules.delaySeconds} s between requests; ATHLETICS_GAP_MS is ${ATHLETICS_GAP_MS / 1000} s.`);
  }
  const pages: AthleticsPage[] = [];
  let read = 0;
  let kept = 0;
  for (const team of reviewed.teams) {
    const url = `${reviewed.site}/sports/${team.slug}/${pagePath}`;
    if (!robotsAllows(rules, new URL(url).pathname)) throw new Error(`${reviewed.site}/robots.txt no longer allows ${url}.`);
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
  if (!read) throw new Error(`No ${kind} page could be read from ${reviewed.site}.`);
  const generatedAt = new Date().toISOString();
  const capture: AthleticsCapture = { schemaVersion: 1, dataset, generatedAt, site: reviewed.site, pages };
  writeJsonFile(rawFile, capture);
  writeRawFileProvenance(dataset, rawFile, { sourceUrl: reviewed.site, recordCount: read, fetchedAt: generatedAt });
  noteSiteDownloads(`${dataset}: read ${read} of ${reviewed.teams.length} pages from ${reviewed.site}${kept ? `, kept last copy of ${kept}` : ''} (${ATHLETICS_GAP_MS / 1000} s apart).`);
}

if (process.argv[1]?.endsWith('athletics.ts')) {
  const kind = process.argv[2];
  if (kind !== 'schedules' && kind !== 'coaches') {
    console.error('Usage: tsx ingestion/athletics.ts schedules|coaches');
    process.exitCode = 1;
  } else {
    main(kind).catch(error => { console.error('Fatal:', error instanceof Error ? error.message : error); process.exitCode = 1; });
  }
}
