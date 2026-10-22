import type { ShuttleRoute, ShuttleTrains } from '../src/static/shuttleSchedule';
import type { RawDatasetV1, RawPageV1 } from './raw-types';

export interface PublishedShuttleSchedule {
  name: string;
  /** `special`: a holiday or event timetable, named by the day its page heading gives. */
  serviceDay: 'weekday' | 'saturday' | 'sunday' | 'special';
  sourceUrl: string;
  collectedAt: string;
  sourceTitle: string | null;
  trips: ShuttleRoute[];
}

const ROUTES = [
  // The page's own title, "Fall 2026 Shuttle Mid-Day Weekday Express Train Schedule".
  ['Mid-Day Weekday Express Train', 'weekday', 'shuttle-mid-day-weekday-express-train-schedule'],
  ['Weekday Roadrunner Express', 'weekday', 'ramapo-roadrunner-express-shuttle'],
  ['Saturday Roadrunner Express', 'saturday', 'saturday-shuttle-schedule'],
  ['Sunday Roadrunner Express', 'sunday', 'sunday-shuttle-schedule'],
] as const;

function text(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** A stop as a place: the mid-day table's "Arrive Ramsey Rt 17 Train" and "Depart Ramsey Rt 17 Train"
 * columns are two visits to one stop, like the full routes' outbound and return train columns. */
function stopName(header: string | undefined): string {
  return text(header).replace(/^(?:arrive|depart)\s+/i, '');
}

function clock(value: string | undefined): string | undefined {
  const cleaned = text(value).replace(/\s*:\s*/g, ':').replace(/-$/, '').trim();
  if (/^(?:[-–—]|N\/A|see express)?$/i.test(cleaned)) return undefined;
  const match = cleaned.match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AP]M)$/i);
  if (!match) throw new Error(`Unsupported published shuttle time: ${JSON.stringify(value)}`);
  return `${Number(match[1])}:${match[2]} ${match[3].toUpperCase()}`;
}

/** Every clock a train cell lists ("6:44 PM 7:07 PM 7:14 PM"), or none for "–", "See express" or "N/A". */
function clocks(value: string | undefined): string[] {
  const cell = text(value);
  if (/^(?:[-–—]*|N\/A|see express)$/i.test(cell)) return [];
  const found = [...cell.matchAll(/(0?[1-9]|1[0-2])\s*:\s*([0-5]\d)\s*([AP]M)/gi)];
  const rest = cell.replace(/(0?[1-9]|1[0-2])\s*:\s*([0-5]\d)\s*([AP]M)/gi, '').replace(/[\s,;-]+/g, '');
  if (!found.length || rest) throw new Error(`Unsupported published train time: ${JSON.stringify(value)}`);
  return found.map(match => `${Number(match[1])}:${match[2]} ${match[3].toUpperCase()}`);
}

export function parseShuttleTable(table: RawPageV1['tables'][number]): ShuttleRoute[] {
  const departure = table.headers.findIndex(header => /^leave ramapo$/i.test(text(header)));
  const arrival = table.headers.findIndex(header => /^arrive on campus$/i.test(text(header)));
  if (departure < 0 || arrival <= departure) throw new Error('Shuttle table needs Leave Ramapo and Arrive on Campus columns.');
  const fromNyc = table.headers.findIndex(header => /^train arrives from nyc$/i.test(text(header)));
  const toNyc = table.headers.findIndex(header => /^train leaves for nyc$/i.test(text(header)));
  const trips: ShuttleRoute[] = [];
  for (const row of table.rows) {
    const first = text(row[departure]);
    if (!first || /^[-–—]+$/.test(first) || /^leave ramapo$/i.test(first)) continue;
    // Whole-row notes are not trips; malformed clock-like departures must fail.
    if (!/^\d/.test(first)) {
      if (row.length === 1) continue;
      throw new Error(`Unsupported shuttle departure row: ${JSON.stringify(first)}`);
    }
    const departureTime = clock(first);
    if (!departureTime) continue;
    const stops = [];
    for (let column = departure + 1; column < arrival; column++) {
      const time = clock(row[column]);
      if (time) stops.push({ location: stopName(table.headers[column]), time });
    }
    const trip: ShuttleRoute = { departure: departureTime, stops, arrival: clock(row[arrival]) ?? 'N/A' };
    if (fromNyc > arrival || toNyc > arrival) {
      const trains: ShuttleTrains = {
        arrives_from_nyc: fromNyc > arrival ? clocks(row[fromNyc]) : [],
        leaves_for_nyc: toNyc > arrival ? clocks(row[toNyc]) : [],
      };
      if ([row[fromNyc], row[toNyc]].some(cell => /^see express$/i.test(text(cell)))) trains.see_express = true;
      trip.trains = trains;
    }
    trips.push(trip);
  }
  if (!trips.length) throw new Error('Published shuttle timetable contains no trips.');
  return trips;
}

const SPECIAL_SLUG = 'special-shuttle-schedule';

/**
 * The special-schedule page's timetables, each named by the heading it sits under ("September 7th
 * (Labor Day)"). The page prints no year, so none is assigned: a special timetable is never read as
 * a weekday, Saturday or Sunday schedule, only offered as the one its heading names.
 */
export function parseSpecialSchedules(dataset: RawDatasetV1): PublishedShuttleSchedule[] {
  const page = dataset.pages.find(candidate => {
    const url = new URL(candidate.url);
    return candidate.statusCode !== null && candidate.statusCode >= 200 && candidate.statusCode < 300
      && url.hostname === 'www.ramapo.edu' && url.pathname.replace(/\/+$/, '') === `/about/transportation-services/${SPECIAL_SLUG}`;
  });
  if (!page) return [];
  const tables = page.tables.filter(table => table.headers.some(header => /^leave ramapo$/i.test(text(header))));
  const captured = new Date(page.fetchedAt);
  const schedules = tables.map(table => {
    // The heading whose section text holds this table's first trip.
    // Sections print a table as "cell | cell; row | ..."; compare letters and digits only.
    const squash = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const firstRow = squash((table.rows.find(row => /^\d/.test(text(row[0]))) ?? []).slice(0, 3).join(''));
    const owners = page.sections.filter(section => firstRow && squash(section.text).includes(firstRow));
    if (owners.length !== 1) throw new Error(`A special shuttle timetable must sit under exactly one heading; found ${owners.length}.`);
    return { name: `Special Shuttle Schedule: ${text(owners[0].heading)}`, serviceDay: 'special' as const, sourceUrl: page.url,
      collectedAt: page.fetchedAt, sourceTitle: page.title, trips: parseShuttleTable(table) };
  });
  // A special day already past when the page was read is a leftover ("September 7th (Labor Day)"
  // still listed in October): it is left out. A heading with no readable day is kept.
  return schedules.filter(schedule => !isPastSpecialDay(schedule.name, captured));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "September 7th (Labor Day)" read on October 14 names a day already past that year. */
export function isPastSpecialDay(heading: string, captured: Date): boolean {
  const match = heading.match(new RegExp(String.raw`\b(${MONTHS.join('|')})\s+(\d{1,2})(?:st|nd|rd|th)?\b`, 'i'));
  if (!match || Number.isNaN(captured.getTime())) return false;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const campus = new Date(captured.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return month < campus.getMonth() || (month === campus.getMonth() && day < campus.getDate());
}

/** Use the captured official columns, including repeated stops on outbound/return legs. */
export function parseTransportationSchedules(dataset: RawDatasetV1): PublishedShuttleSchedule[] {
  if (dataset.dataset !== 'transportation') throw new Error('Expected the transportation raw dataset.');
  const schedules = ROUTES.map(([name, serviceDay, slug]): PublishedShuttleSchedule => {
    const candidates = dataset.pages.filter(page => {
      const url = new URL(page.url);
      return page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 300
        && url.hostname === 'www.ramapo.edu'
        && url.pathname.replace(/\/+$/, '') === `/about/transportation-services/${slug}`;
    });
    if (!candidates.length) throw new Error(`Missing successful source capture for ${name}.`);
    const tablesFor = (page: RawPageV1) => page.tables.filter(table => table.headers.some(header => /^leave ramapo$/i.test(text(header))));
    const page = candidates[0];
    const tables = tablesFor(page);
    if (tables.length !== 1 || candidates.some(candidate => JSON.stringify(tablesFor(candidate)) !== JSON.stringify(tables))) {
      throw new Error(`Ambiguous published timetable for ${name}.`);
    }
    return { name, serviceDay, sourceUrl: page.url, collectedAt: page.fetchedAt, sourceTitle: page.title, trips: parseShuttleTable(tables[0]) };
  });
  // One spelling per stop, the one most timetable pages use: the Saturday page heads a column
  // "CITY MD Ramsey", the weekday and Sunday pages "City MD Ramsey".
  const spellings = new Map<string, Map<string, number>>();
  for (const route of schedules) {
    for (const location of new Set(route.trips.flatMap(trip => trip.stops.map(stop => stop.location)))) {
      const seen = spellings.get(location.toLowerCase()) ?? new Map<string, number>();
      spellings.set(location.toLowerCase(), seen.set(location, (seen.get(location) ?? 0) + 1));
    }
  }
  const canonical = (location: string) => [...spellings.get(location.toLowerCase())!]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  for (const stop of schedules.flatMap(route => route.trips.flatMap(trip => trip.stops))) stop.location = canonical(stop.location);
  for (const special of parseSpecialSchedules(dataset)) {
    for (const stop of special.trips.flatMap(trip => trip.stops)) if (spellings.has(stop.location.toLowerCase())) stop.location = canonical(stop.location);
    schedules.push(special);
  }
  return schedules;
}

/** A shuttle stop as the stop-descriptions page explains it, under the name the timetables use. */
export interface ShuttleStopDescription { stop: string; label: string; description: string; pickup: string | null; sourceUrl: string; collectedAt: string }

/**
 * The page's own label for each stop, and the stop name the timetables use for it (reviewed
 * 2026-10-14). "Ramapo College" is the campus stop, which timetables write as leaving Ramapo and
 * arriving on campus. A label missing from the page stops the collector; a new one is ignored
 * until it is added here, so no stop is matched by a guess.
 */
export const STOP_LABELS: ReadonlyArray<readonly [label: string, stop: string]> = [
  ['Ramapo College', 'Ramapo College (Bradley Center)'],
  ['Ramsey Route 17 Train Station', 'Ramsey Rt 17 Train'],
  ['Interstate', 'Interstate Plaza'],
  ['Ramsey Square', 'Ramsey Square'],
  ['CityMD Ramsey Urgent Care', 'City MD Ramsey'],
  ['Ramsey Farmer’s Market', 'Ramsey Farmers Market'],
  ['Garden State Plaza', 'Garden State Plaza'],
  ['Barnes & Noble/Fashion Center', 'Barnes & Noble/ Fashion Center'],
];

export function parseStopDescriptions(dataset: RawDatasetV1): ShuttleStopDescription[] {
  const page = dataset.pages.find(candidate => new URL(candidate.url).pathname.replace(/\/+$/, '') === '/about/transportation-services/shuttle-stop-descriptions'
    && candidate.statusCode !== null && candidate.statusCode >= 200 && candidate.statusCode < 300);
  if (!page) return [];
  const section = page.sections.find(item => text(item.heading) === 'Shuttle Stop Descriptions');
  if (!section) throw new Error('The shuttle stop descriptions section is missing.');
  const body = text(section.text);
  const starts = STOP_LABELS.map(([label, stop]) => {
    const at = body.indexOf(`${label}: `);
    if (at < 0) throw new Error(`The stop descriptions no longer describe "${label}".`);
    return { label, stop, at };
  }).sort((a, b) => a.at - b.at);
  return starts.map((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].at : body.length;
    const description = text(body.slice(entry.at + entry.label.length + 2, end));
    const pickup = description.match(/At this location, the pick up and drop off (?:is|are) ([^.]+(?:\.[^.]+)?)\.(?:\s|$)/i)?.[1] ?? null;
    return { stop: entry.stop, label: entry.label, description, pickup: pickup ? text(pickup) : null,
      sourceUrl: page.url, collectedAt: page.fetchedAt };
  });
}
