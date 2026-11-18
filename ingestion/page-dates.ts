/**
 * page-dates.ts
 *
 * When each www.ramapo.edu page was last edited, as the office and school site collectors read it
 * from the sites' WordPress sitemaps (data/raw/office-pages-sitemaps.json and
 * academic-sites-sitemaps.json). The smaller Ramapo site collectors (safety, housing, counseling,
 * transportation, health) run before those collectors, so they read the last run's dates: an edit
 * reaches them the next night or the one after, instead of up to a week later.
 *
 * Dates read more than MAX_DATES_AGE_HOURS ago are not used: a page then counts as undated and is
 * downloaded on its weekly night, as before (11-18).
 */

import path from 'path';
import { pageKey, readSitemapState } from './folder-sites';

export const MAX_DATES_AGE_HOURS = 48;
const DATE_FILES = ['office-pages-sitemaps.json', 'academic-sites-sitemaps.json'];

/** Each page's edit time by page key, from the sitemap states read within maxAgeHours of `now`. */
export function readPageEditTimes(rawDir = path.join(process.cwd(), 'data', 'raw'), now = Date.now(),
  maxAgeHours = MAX_DATES_AGE_HOURS): Map<string, string> {
  const times = new Map<string, string>();
  for (const file of DATE_FILES) {
    const state = readSitemapState(path.join(rawDir, file));
    const readAt = state ? Date.parse(state.readAt) : NaN;
    if (!state || !Number.isFinite(readAt) || now - readAt > maxAgeHours * 3_600_000 || readAt > now) continue;
    for (const [key, time] of Object.entries(state.editedAt ?? {})) {
      const before = times.get(key);
      if (!before || Date.parse(time) > Date.parse(before)) times.set(key, time);
    }
  }
  return times;
}

/** A collector's listedEditedAt from those dates: a page's edit time, or undefined when none is known. */
export function pageEditTimeLookup(times: ReadonlyMap<string, string> = readPageEditTimes()):
  (url: string) => string | undefined {
  return url => times.get(pageKey(url) ?? '');
}

/**
 * The reuse options of a small Ramapo site collector collected every night: a page is downloaded
 * when its sitemap says it was edited since its last download, and otherwise once every 28 nights
 * on its own night (a page with no edit date weekly, a "not found" page monthly), as the office
 * pages are.
 */
export function editDatedReuse(times?: ReadonlyMap<string, string>): {
  listedEditedAt: (url: string) => string | undefined; undatedReuseDays: number; deadReuseDays: number;
} {
  return { listedEditedAt: pageEditTimeLookup(times), undatedReuseDays: 7, deadReuseDays: 28 };
}
