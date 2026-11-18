/**
 * site-guard.ts
 *
 * Ramapo's own sites (*.ramapo.edu, and the college's athletics site ramapoathletics.com) are
 * read as little and as gently as possible (Dan, November 2, 2026). Four rules live here:
 *
 * 1. Only the daily data run downloads from them. A laptop, or any other machine, reuses the
 *    pages that run captured (npm run data:bootstrap -- --require-raw) and never collects on
 *    its own. A collection Dan asks for on a laptop sets ROCKYGPT_ALLOW_SITE_FETCH=1 for that
 *    one command. The workflow's dev build (ROCKYGPT_BUILD_TARGET=dev) also only reuses pages.
 * 2. At most RAMAPO_CONCURRENCY requests are open to one Ramapo host at a time, whatever a
 *    collector asks for.
 * 3. Each request to a Ramapo host starts at least RAMAPO_REQUEST_GAP_MS after the last one
 *    to that host started, or the crawl delay the site's robots.txt asks for when that is longer.
 * 4. Every request to a Ramapo site is checked against that site's robots.txt first (read once a
 *    run per site, with the robots-parser package). A page robots.txt disallows is not requested.
 *    Before this rule, only the athletics site's robots.txt was read in code; ramapo.edu's and
 *    Archway's were read once by a person and copied into comments, so a new "Disallow" line
 *    would have gone unnoticed (tool review, November 18, 2026).
 */

import fs from 'node:fs';
import path from 'node:path';
import robotsParser from 'robots-parser';

export const ALLOW_SITE_FETCH_ENV = 'ROCKYGPT_ALLOW_SITE_FETCH';
export const RAMAPO_CONCURRENCY = 2;
export const RAMAPO_REQUEST_GAP_MS = 500;
/** A browser's user agent, sent unless a request sets its own: requests never name the project. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

type GuardEnvironment = Readonly<Record<string, string | undefined>>;

/** Ramapo's own sites outside ramapo.edu: the athletics site (its robots.txt also asks 30 s between pages). */
const RAMAPO_OTHER_HOSTS = ['ramapoathletics.com'];

/** Whether a host is one of Ramapo's own: ramapo.edu and every name under it, and the athletics site. */
export function isRamapoHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'ramapo.edu' || host.endsWith('.ramapo.edu')
    || RAMAPO_OTHER_HOSTS.some(other => host === other || host.endsWith(`.${other}`));
}

/**
 * Whether this process may download from Ramapo's sites: the daily data run, or a run told to.
 * The workflow's dev build never may: it builds from the pages production already captured.
 */
export function siteFetchAllowed(env: GuardEnvironment = process.env): boolean {
  if (env.ROCKYGPT_BUILD_TARGET === 'dev') return false;
  return env.GITHUB_ACTIONS === 'true' || env[ALLOW_SITE_FETCH_ENV] === '1';
}

export class SiteFetchBlockedError extends Error {
  constructor(url: string) {
    super(
      `Not downloading ${url}: only the daily data run reads Ramapo's sites. ` +
        "Use production's captured pages instead (npm run data:bootstrap -- --require-raw). " +
        `If Dan asked for a fresh collection on this machine, run the command with ${ALLOW_SITE_FETCH_ENV}=1.`
    );
    this.name = 'SiteFetchBlockedError';
  }
}

/** Stops a request to a Ramapo site that this process may not make. Other hosts pass. */
export function assertSiteFetchAllowed(input: string | URL, env: GuardEnvironment = process.env): void {
  const url = input instanceof URL ? input : new URL(input);
  if (isRamapoHost(url.hostname) && !siteFetchAllowed(env)) throw new SiteFetchBlockedError(url.toString());
}

/** What one site's robots.txt says for every robot (`User-agent: *`), since requests never name the project. */
export interface SiteRobots {
  /** Whether a page may be requested. */
  allows(url: string | URL): boolean;
  /** The crawl delay it asks for, in milliseconds (0 when none). */
  delayMs: number;
  /** Why every page is refused, when robots.txt could not be read. */
  unreadable?: string;
}

/**
 * The rules of a robots.txt file. RFC 9309: a missing file (any 4xx but 429) allows everything,
 * and an unreachable one (5xx, 429, no answer) is read as "disallow everything" for this run.
 */
export function siteRobots(robotsUrl: string, status: number | undefined, text = ''): SiteRobots {
  if (status !== undefined && status >= 200 && status < 300) {
    const robot = robotsParser(robotsUrl, text);
    return {
      allows: url => robot.isAllowed(url.toString()) !== false,
      delayMs: Math.max(0, (robot.getCrawlDelay() ?? 0) * 1000),
    };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return { allows: () => true, delayMs: 0 };
  }
  const unreadable = `${robotsUrl} could not be read (${status ?? 'no answer'})`;
  return { allows: () => false, delayMs: 0, unreadable };
}

export class RobotsDisallowedError extends Error {
  constructor(url: string, robots: SiteRobots) {
    super(robots.unreadable
      ? `Not downloading ${url}: ${robots.unreadable}, so every page of that site is left alone this run.`
      : `Not downloading ${url}: the site's robots.txt does not allow it.`);
    this.name = 'RobotsDisallowedError';
  }
}

const ROBOTS_TIMEOUT_MS = 15_000;
const ROBOTS_ATTEMPTS = 2;
const robotsByOrigin = new Map<string, Promise<SiteRobots>>();

function isRobotsFile(url: URL): boolean {
  return url.pathname === '/robots.txt';
}

async function readSiteRobots(origin: string): Promise<SiteRobots> {
  const robotsUrl = `${origin}/robots.txt`;
  assertSiteFetchAllowed(robotsUrl);
  let status: number | undefined;
  let text = '';
  for (let attempt = 1; attempt <= ROBOTS_ATTEMPTS; attempt += 1) {
    await paceRamapoRequest(robotsUrl);
    try {
      const response = await fetch(robotsUrl, {
        headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/plain' }, signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      });
      status = response.status;
      if (status < 500 && status !== 429) {
        text = await response.text();
        break;
      }
    } catch {
      status = undefined;
    }
  }
  const robots = siteRobots(robotsUrl, status, text);
  noteBlocked({
    type: 'site', site: origin, status: status ?? null,
    refuses: robots.unreadable ? ['/ (robots.txt could not be read)'] : everyRobotDisallows(text),
    crawlDelaySeconds: robots.delayMs / 1000,
  });
  return robots;
}

/**
 * The Disallow lines robots.txt gives every robot (`User-agent: *`), for the run's list of what is
 * blocked. Shown to people only: robots-parser alone decides whether a page may be requested.
 */
export function everyRobotDisallows(text: string): string[] {
  const refused: string[] = [];
  let inGroup = false;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(raw);
    if (!match) continue;
    const field = match[1].toLowerCase();
    if (field === 'user-agent') {
      inGroup = (lastWasAgent && inGroup) || match[2] === '*';
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (inGroup && field === 'disallow' && match[2]) refused.push(match[2]);
  }
  return [...new Set(refused)];
}

/** One line of the run's list of what robots.txt blocks (`data/review/blocked-pages.jsonl`). */
export type BlockedNote =
  | { type: 'site'; site: string; status: number | null; refuses: string[]; crawlDelaySeconds: number }
  | { type: 'refused'; url: string; reason: string };

/** The run's list of what robots.txt blocks, kept beside the download note during a refresh. */
export const BLOCKED_PAGES_NOTE = path.join('data', 'review', 'blocked-pages.jsonl');
export const BLOCKED_PAGES_NOTE_ENV = 'ROCKYGPT_BLOCKED_PAGES_NOTE';

/** Adds a line to the run's blocked list (during a refresh; otherwise nothing is written). */
export function noteBlocked(note: BlockedNote, notePath = process.env[BLOCKED_PAGES_NOTE_ENV]): void {
  if (!notePath) return;
  try {
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.appendFileSync(notePath, `${JSON.stringify(note)}\n`);
  } catch {
    // The list is a convenience; a collection never fails over it.
  }
}

/** The robots.txt rules of a Ramapo site, read once a run (only the first caller downloads it). */
export function robotsFor(input: string | URL): Promise<SiteRobots> {
  const url = input instanceof URL ? input : new URL(input);
  const origin = url.origin.toLowerCase();
  let robots = robotsByOrigin.get(origin);
  if (!robots) {
    robots = readSiteRobots(origin);
    robotsByOrigin.set(origin, robots);
  }
  return robots;
}

/** Forgets every site's robots.txt, so the next request reads it again (tests). */
export function forgetSiteRobots(): void {
  robotsByOrigin.clear();
}

// When the next request to each Ramapo host may start.
const nextStartByHost = new Map<string, number>();

/**
 * Checks a request to a Ramapo host against the site's robots.txt, then waits until it may
 * start: RAMAPO_REQUEST_GAP_MS (or the site's longer crawl delay) after the last request to the
 * same host started. Other hosts pass at once. Every collector's requests share the gap, the
 * browser-driven ones (Playwright) included. A page robots.txt disallows throws
 * RobotsDisallowedError before anything is sent.
 */
export async function paceRamapoRequest(input: string | URL): Promise<void> {
  const url = input instanceof URL ? input : new URL(input);
  if (!isRamapoHost(url.hostname)) return;
  let gapMs = RAMAPO_REQUEST_GAP_MS;
  if (!isRobotsFile(url)) {
    const robots = await robotsFor(url);
    if (!robots.allows(url)) {
      const refused = new RobotsDisallowedError(url.toString(), robots);
      noteBlocked({ type: 'refused', url: url.toString(), reason: robots.unreadable ?? 'robots.txt disallows it' });
      throw refused;
    }
    gapMs = Math.max(gapMs, robots.delayMs);
  }
  const host = url.host.toLowerCase();
  const start = Math.max(Date.now(), nextStartByHost.get(host) ?? 0);
  nextStartByHost.set(host, start + gapMs);
  const wait = start - Date.now();
  if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
}

/**
 * Where a run notes what it read from Ramapo's sites, one line per collector. The daily run prints
 * it as its last step, so the counts sit at the end of the log where they are easy to find.
 */
export const SITE_DOWNLOADS_NOTE = path.join('data', 'review', 'site-downloads.txt');

/**
 * Set by the refresh to the note's path for itself and the collectors it starts. Anything else
 * (the test suite, a collector run by hand) only prints its lines, so the note holds the run's
 * real counts and nothing from the tests that run after it.
 */
export const SITE_DOWNLOADS_NOTE_ENV = 'ROCKYGPT_SITE_DOWNLOADS_NOTE';

/** Starts the run's note afresh and has this process and the collectors it starts write to it. */
export function startSiteDownloadsNote(notePath = path.join(process.cwd(), SITE_DOWNLOADS_NOTE),
  blockedPath = path.join(path.dirname(notePath), path.basename(BLOCKED_PAGES_NOTE))): void {
  fs.rmSync(notePath, { force: true });
  fs.rmSync(blockedPath, { force: true });
  process.env[SITE_DOWNLOADS_NOTE_ENV] = notePath;
  process.env[BLOCKED_PAGES_NOTE_ENV] = blockedPath;
}

/** Prints a line and, during a refresh, adds it to the run's note of what was read from Ramapo's sites. */
export function noteSiteDownloads(line: string, notePath = process.env[SITE_DOWNLOADS_NOTE_ENV]): void {
  console.log(line);
  if (!notePath) return;
  try {
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.appendFileSync(notePath, `${line}\n`);
  } catch {
    // The note is a convenience; a collection never fails over it.
  }
}
