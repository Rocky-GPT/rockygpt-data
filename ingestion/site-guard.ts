/**
 * site-guard.ts
 *
 * Ramapo's own sites (*.ramapo.edu, and the college's athletics site ramapoathletics.com) are
 * read as little and as gently as possible (Dan, November 2, 2026). Three rules live here:
 *
 * 1. Only the daily data run downloads from them. A laptop, or any other machine, reuses the
 *    pages that run captured (npm run data:bootstrap -- --require-raw) and never collects on
 *    its own. A collection Dan asks for on a laptop sets ROCKYGPT_ALLOW_SITE_FETCH=1 for that
 *    one command. The workflow's dev build (ROCKYGPT_BUILD_TARGET=dev) also only reuses pages.
 * 2. At most RAMAPO_CONCURRENCY requests are open to one Ramapo host at a time, whatever a
 *    collector asks for.
 * 3. Each request to a Ramapo host starts at least RAMAPO_REQUEST_GAP_MS after the last one
 *    to that host started.
 */

import fs from 'node:fs';
import path from 'node:path';

export const ALLOW_SITE_FETCH_ENV = 'ROCKYGPT_ALLOW_SITE_FETCH';
export const RAMAPO_CONCURRENCY = 2;
export const RAMAPO_REQUEST_GAP_MS = 500;

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

// When the next request to each Ramapo host may start.
const nextStartByHost = new Map<string, number>();

/**
 * Waits until a request to this host may start: RAMAPO_REQUEST_GAP_MS after the last one to the
 * same Ramapo host started. Other hosts do not wait. Every collector's requests share the gap,
 * the browser-driven ones (Playwright) included.
 */
export async function paceRamapoRequest(input: string | URL): Promise<void> {
  const url = input instanceof URL ? input : new URL(input);
  if (!isRamapoHost(url.hostname)) return;
  const host = url.host.toLowerCase();
  const start = Math.max(Date.now(), nextStartByHost.get(host) ?? 0);
  nextStartByHost.set(host, start + RAMAPO_REQUEST_GAP_MS);
  const wait = start - Date.now();
  if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
}

/**
 * Where a run notes what it read from Ramapo's sites, one line per collector. The daily run prints
 * it as its last step, so the counts sit at the end of the log where they are easy to find.
 */
export const SITE_DOWNLOADS_NOTE = path.join('data', 'review', 'site-downloads.txt');

/** Prints a line and adds it to the run's note of what was read from Ramapo's sites. */
export function noteSiteDownloads(line: string, notePath = path.join(process.cwd(), SITE_DOWNLOADS_NOTE)): void {
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.appendFileSync(notePath, `${line}\n`);
  } catch {
    // The note is a convenience; a collection never fails over it.
  }
}
