/**
 * Temporary, on this work branch only: a free check for the overnight audit of 2026-11-17.
 * Campus hours and the club list have a 180-day freshness window, so the nightly job reads them
 * about twice a year. This reads the same public pages once, with the collectors' own download
 * helper and readers, and prints what each page says today, so it can be compared with the copy
 * the bot holds. It writes nothing anywhere and uses no keys. Removed before anything merges.
 */
import { load } from 'cheerio';
import { fetchWithPolicy } from '../ingestion/http-client';
import {
  ATHLETICS_HOURS_URL, BERRIE_SEASON_URL, GENERAL_CAMPUS_HOURS_URL, LIBRARY_HOURS_URL, OFFICE_HOURS_PAGES,
  campusHoursFromCaptures, configuredOfficeHours, hoursPageText, parseAthleticsFacilityHours,
  parseGeneralCampusHours, parseLibraryHours, type HoursSourceCapture,
} from '../ingestion/campus-hours';
import type { LocationHours } from '../ingestion/schema';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const line = (kind: string, fields: Record<string, unknown>) => console.log(`${kind} ${JSON.stringify(fields)}`);
const week = (record: LocationHours) => DAYS.map((day) => record.hours[day]).join(' | ');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function page(url: string): Promise<HoursSourceCapture | null> {
  try {
    const response = await fetchWithPolicy(url, { headers: { Accept: 'text/html,application/xhtml+xml' } },
      { expectedContentTypes: ['text/html', 'application/xhtml+xml'] });
    if (!response.ok) { line('PAGE_FAIL', { url, status: response.status }); return null; }
    return { sourceUrl: url, collectedAt: new Date().toISOString(), html: response.text() };
  } catch (error) {
    line('PAGE_FAIL', { url, error: message(error) });
    return null;
  }
}

async function main() {
  const started = Date.now();
  const urls = [...new Set([ATHLETICS_HOURS_URL, LIBRARY_HOURS_URL, GENERAL_CAMPUS_HOURS_URL,
    ...OFFICE_HOURS_PAGES.map((office) => office.url), BERRIE_SEASON_URL])];
  const captures: HoursSourceCapture[] = [];
  for (const url of urls) {
    const capture = await page(url);
    if (capture) captures.push(capture);
  }
  line('PAGES', { asked: urls.length, read: captures.length, seconds: Math.round((Date.now() - started) / 1000) });
  const by = new Map(captures.map((capture) => [capture.sourceUrl, capture]));

  // 1. The collector's own whole-run check: one unreadable page fails all campus hours.
  try {
    const records = campusHoursFromCaptures(captures, true);
    line('WHOLE_RUN', { ok: records.length === 13 + OFFICE_HOURS_PAGES.length, records: records.length,
      expected: 13 + OFFICE_HOURS_PAGES.length });
  } catch (error) {
    line('WHOLE_RUN', { ok: false, error: message(error) });
  }

  // 2. Each source on its own, so every page that no longer reads is listed, not only the first.
  const fixed: Array<[string, (text: string) => LocationHours[]]> = [
    [ATHLETICS_HOURS_URL, parseAthleticsFacilityHours], [LIBRARY_HOURS_URL, parseLibraryHours],
    [GENERAL_CAMPUS_HOURS_URL, parseGeneralCampusHours]];
  let ok = 0; let failed = 0;
  for (const [url, parser] of fixed) {
    const capture = by.get(url);
    if (!capture) { failed += 1; line('HOURS_FAIL', { url, error: 'page not read' }); continue; }
    try {
      for (const record of parser(hoursPageText(capture.html))) {
        ok += 1; line('HOURS', { name: record.name, url, week: week(record), notes: record.notes ?? '' });
      }
    } catch (error) { failed += 1; line('HOURS_FAIL', { url, error: message(error) }); }
  }
  for (const office of OFFICE_HOURS_PAGES) {
    const capture = by.get(office.url);
    if (!capture) { failed += 1; line('HOURS_FAIL', { name: office.name, url: office.url, error: 'page not read' }); continue; }
    try {
      const record = configuredOfficeHours(office, hoursPageText(capture.html), capture.collectedAt);
      ok += 1; line('HOURS', { name: record.name, url: office.url, week: week(record), notes: record.notes ?? '' });
    } catch (error) { failed += 1; line('HOURS_FAIL', { name: office.name, url: office.url, error: message(error) }); }
  }
  const library = by.get(LIBRARY_HOURS_URL);
  if (library) {
    const text = hoursPageText(library.html);
    line('LIBRARY_PAGE', { special: /special hours/i.test(text), thanksgiving: /thanksgiving/i.test(text),
      text: text.slice(0, 1500) });
  }
  line('HOURS_TOTAL', { read: ok, failed });

  // 3. The club list: one page. Names only, as the collector's list reader finds them.
  const clubs = await (async () => {
    try {
      const response = await fetchWithPolicy('https://archway.ramapo.edu/club_signup?view=all&',
        { headers: { Accept: 'text/html,application/xhtml+xml' }, credentials: 'omit', redirect: 'follow' },
        { expectedContentTypes: ['text/html', 'application/xhtml+xml'] });
      if (!response.ok) return { status: response.status, names: [] as string[] };
      const $ = load(response.text());
      const names: string[] = [];
      $('li.list-group-item').each((_, element) => {
        const item = $(element);
        if (item.attr('id') === 'list-group-item_header') return;
        const name = (item.find('h2 a[href]').first().text() || item.find('[role="group"]').first().attr('aria-label') || '')
          .replace(/\s+/g, ' ').trim();
        if (name) names.push(name);
      });
      return { status: response.status, names: [...new Set(names)].sort() };
    } catch (error) { return { status: 0, error: message(error), names: [] as string[] }; }
  })();
  line('CLUBS', { status: clubs.status, count: clubs.names.length, error: (clubs as { error?: string }).error });
  for (const name of clubs.names) line('CLUB', { name });
  line('DONE', { seconds: Math.round((Date.now() - started) / 1000) });
}

void main();
