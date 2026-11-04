import { load, type CheerioAPI } from 'cheerio';
import type { ArchwayEvent } from './schema';
import { sourceHtml, type RawSourceCaptureV1 } from './raw-collector';
import { sanitizeEventDescription } from './event-description';
import { campusDateLabel, campusTimeLabel } from './archway-calendar-feeds';
import { berrieEventId, canonicalBerrieEventUrl } from '../src/berrie-event-url';

/**
 * @module ingestion/berrie-events
 * The Berrie Center's shows as events, read from the show pages the school sites collector
 * already keeps (www.ramapo.edu/berriecenter/event/...), so nothing more is downloaded.
 *
 * Archway lists most campus events, but the theater's shows ("As You Like It", the Arch
 * Performances concerts) are in no Archway group's calendar file since November 3, 2026. The
 * Berrie Center's own pages are The Events Calendar's single-event pages: each says its date and
 * time, its venue ("Sharp Theater"), its organizer, its cost and what it is about.
 *
 * Only shows that start today or later are kept. A show Archway also lists (same day and start
 * time, and one title holds the other, "RCNJ Theater Presents:" aside) stays Archway's alone, since
 * Archway's copy names the group that hosts it.
 */

type Page = RawSourceCaptureV1['pages'][number];
type Row = Record<string, unknown>;

const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const BODY_CLASS = /<body\b[^>]*\bclass\s*=\s*(["'])([^"']*)\1/i;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CAMPUS_TIME_ZONE = 'America/New_York';

function campusDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** A wall-clock time on campus ("7:30 pm") on a campus day ("2026-11-13"), as an instant. */
function campusInstant(day: string, clock: string): Date | null {
  const d = day.match(ISO_DAY);
  const t = clock.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i);
  if (!d || !t) return null;
  const hour = (Number(t[1]) % 12) + (t[3].toLowerCase() === 'p' ? 12 : 0);
  const desired = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, Number(t[2] ?? 0));
  let guess = desired;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: CAMPUS_TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess));
    const v = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
    const rendered = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'));
    if (rendered === desired) break;
    guess += desired - rendered;
  }
  return new Date(guess);
}

/** The page's schema.org Event, which The Events Calendar writes into each event page. */
function jsonLdEvent($: CheerioAPI): Row | undefined {
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    let parsed: unknown;
    try { parsed = JSON.parse($(script).contents().text()); } catch { continue; }
    const items = (Array.isArray(parsed) ? parsed : [parsed]).flatMap(item =>
      item && typeof item === 'object' && Array.isArray((item as Row)['@graph']) ? (item as Row)['@graph'] as unknown[] : [item]);
    const event = items.find(item => item && typeof item === 'object' && [(item as Row)['@type']].flat().includes('Event'));
    if (event) return event as Row;
  }
  return undefined;
}

const nameOf = (value: unknown): string => {
  const first = Array.isArray(value) ? value[0] : value;
  return first && typeof first === 'object' ? text(load(`<p>${text((first as Row).name)}</p>`)('p').text()) : '';
};

/** "$18", "Free", "$5 - $10" as the page writes it; "" when it gives none. */
function costText($: CheerioAPI, event: Row | undefined): string {
  const shown = text($('.tribe-events-event-cost').first().text());
  if (shown) return shown;
  const offers = [event?.offers].flat()[0] as Row | undefined;
  const price = text(offers?.price);
  if (!price) return '';
  return /^0+(?:\.0+)?$/.test(price) ? 'Free' : /^\d+(?:\.\d+)?$/.test(price) ? `$${price}` : price;
}

/** A start and an end from the page's own date and time lines, when it has no schema.org Event. */
function scheduleTimes($: CheerioAPI): { start: Date; end?: Date; allDay: boolean } | null {
  const day = $('abbr.tribe-events-start-date[title], abbr.tribe-events-start-datetime[title]').first().attr('title')?.slice(0, 10) ?? '';
  if (!ISO_DAY.test(day)) return null;
  const endDay = $('abbr.tribe-events-end-date[title], abbr.tribe-events-end-datetime[title]').first().attr('title')?.slice(0, 10) || day;
  const line = text($('.tribe-events-start-time').first().text()) || text($('.tribe-events-schedule').first().text()).replace(/^.*@/, '');
  const clocks = [...line.matchAll(/\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?/gi)].map(m => m[0]);
  if (!clocks.length) {
    const start = campusInstant(day, '12 am');
    return start ? { start, allDay: true } : null;
  }
  const start = campusInstant(day, clocks[0]);
  const end = clocks[1] ? campusInstant(endDay, clocks[1]) ?? undefined : undefined;
  return start ? { start, end, allDay: false } : null;
}

function instantOf(value: unknown): { at: Date; allDay: boolean } | null {
  const raw = text(value);
  if (ISO_DAY.test(raw)) { const at = campusInstant(raw, '12 am'); return at ? { at, allDay: true } : null; }
  const at = new Date(raw);
  return raw && Number.isFinite(at.getTime()) ? { at, allDay: false } : null;
}

/** One show page as an event, or null when the page is not a dated Events Calendar event. */
export function berrieEventFromPage(page: Pick<Page, 'url' | 'html' | 'htmlGzip'>): ArchwayEvent | null {
  const url = canonicalBerrieEventUrl(page.url);
  const html = url ? sourceHtml(page) : '';
  if (!url || !(html.match(BODY_CLASS)?.[2].split(/\s+/) ?? []).includes('single-tribe_events')) return null;
  const $ = load(html);
  const event = jsonLdEvent($);
  const title = text($('.tribe-events-single-event-title').first().text()) || nameOf([{ name: event?.name }]);
  if (!title) return null;

  let start: Date | undefined; let end: Date | undefined; let allDay = false;
  const ldStart = instantOf(event?.startDate);
  if (ldStart) {
    start = ldStart.at; allDay = ldStart.allDay;
    end = instantOf(event?.endDate)?.at;
  } else {
    const times = scheduleTimes($);
    if (!times) return null;
    ({ start, end, allDay } = times);
  }
  if (!start) return null;

  const result: ArchwayEvent = { title, date: campusDateLabel(start), url };
  result.time = allDay ? '12 AM' : campusTimeLabel(start);
  if (allDay) { if (!end || campusDay(end) === campusDay(start)) result.endTime = '11:59 PM'; }
  else if (end && end > start && campusDay(end) === campusDay(start)) result.endTime = campusTimeLabel(end);
  const venue = text($('.tribe-venue').first().text()) || nameOf(event?.location);
  if (venue) result.location = venue;
  const organizer = text($('.tribe-organizer').first().text()) || nameOf(event?.organizer);
  if (organizer) result.organizer = organizer;
  // A space after each paragraph and list item, so their sentences do not run together.
  const shownDescription = ($('.tribe-events-single-event-description').first().html() ?? '').replace(/<\/(p|li|h\d|div)>/gi, '</$1> ');
  const description = sanitizeEventDescription(shownDescription || text(event?.description));
  if (description) result.description = description;
  const cost = costText($, event);
  if (cost) result.ticketStatus = cost;
  const tags = $('.tribe-events-event-categories a').toArray().map(a => text($(a).text())).filter(Boolean);
  if (tags.length) result.tags = [...new Set(tags)];
  return result;
}

/** The shows the captured pages hold that start on campus today or later, soonest first. */
export function berrieEventsFromCapture(capture: Pick<RawSourceCaptureV1, 'pages'>, now = new Date()): ArchwayEvent[] {
  const today = campusDay(now);
  const byUrl = new Map<string, { event: ArchwayEvent; start: number }>();
  for (const page of capture.pages) {
    if (!berrieEventId(page.url) || (typeof page.statusCode === 'number' && (page.statusCode < 200 || page.statusCode >= 300))) continue;
    const event = berrieEventFromPage(page);
    if (!event?.url || byUrl.has(event.url)) continue;
    const start = Date.parse(`${event.date} ${event.time}`);
    const startDay = campusDayOfLabel(event.date);
    if (!startDay || startDay < today) continue;
    byUrl.set(event.url, { event, start: Number.isFinite(start) ? start : 0 });
  }
  return [...byUrl.values()].sort((a, b) => a.start - b.start || a.event.url!.localeCompare(b.event.url!)).map(v => v.event);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Fri, Nov 13, 2026" as "2026-11-13". */
function campusDayOfLabel(label: string): string {
  const m = label.match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  const month = m ? MONTHS.indexOf(m[1]) + 1 : 0;
  return m && month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}

const coreTitle = (title: string): string => title.toLowerCase().replace(/&/g, ' and ')
  .replace(/^\s*(?:rcnj\s+theat(?:er|re)\s+(?:program\s+)?presents?|rcnj\s+theat(?:er|re)|arch\s+performances?)\s*[:\-–]\s*/i, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Archway's events, then the Berrie shows Archway does not list. */
export function withBerrieEvents(archway: ArchwayEvent[], berrie: ArchwayEvent[]): ArchwayEvent[] {
  const listed = archway.map(e => ({ date: e.date, time: e.time ?? '', title: coreTitle(e.title) }));
  const extra = berrie.filter(show => {
    const title = coreTitle(show.title);
    return title && !listed.some(e => e.date === show.date && e.time === (show.time ?? '') && e.title &&
      (e.title.includes(title) || title.includes(e.title)));
  });
  return [...archway, ...extra];
}
