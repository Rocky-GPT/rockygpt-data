import type { ShuttleRoute, ShuttleTrains } from '../src/static/shuttleSchedule';
import type { RawDatasetV1, RawPageV1 } from './raw-types';

export interface PublishedShuttleSchedule {
  name: string;
  serviceDay: 'weekday' | 'saturday' | 'sunday';
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
  return schedules;
}
