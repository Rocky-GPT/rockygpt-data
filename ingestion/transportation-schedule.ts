import type { ShuttleRoute } from '../src/static/shuttleSchedule';
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
  ['Ramsey Route 17', 'weekday', 'shuttle-mid-day-weekday-express-train-schedule'],
  ['Weekday Roadrunner Express', 'weekday', 'ramapo-roadrunner-express-shuttle'],
  ['Saturday Roadrunner Express', 'saturday', 'saturday-shuttle-schedule'],
  ['Sunday Roadrunner Express', 'sunday', 'sunday-shuttle-schedule'],
] as const;

function text(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function clock(value: string | undefined): string | undefined {
  const cleaned = text(value).replace(/\s*:\s*/g, ':').replace(/-$/, '').trim();
  if (/^(?:[-–—]|N\/A|see express)?$/i.test(cleaned)) return undefined;
  const match = cleaned.match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AP]M)$/i);
  if (!match) throw new Error(`Unsupported published shuttle time: ${JSON.stringify(value)}`);
  return `${Number(match[1])}:${match[2]} ${match[3].toUpperCase()}`;
}

export function parseShuttleTable(table: RawPageV1['tables'][number]): ShuttleRoute[] {
  const departure = table.headers.findIndex(header => /^leave ramapo$/i.test(text(header)));
  const arrival = table.headers.findIndex(header => /^arrive on campus$/i.test(text(header)));
  if (departure < 0 || arrival <= departure) throw new Error('Shuttle table needs Leave Ramapo and Arrive on Campus columns.');
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
      if (time) stops.push({ location: text(table.headers[column]), time });
    }
    trips.push({ departure: departureTime, stops, arrival: clock(row[arrival]) ?? 'N/A' });
  }
  if (!trips.length) throw new Error('Published shuttle timetable contains no trips.');
  return trips;
}

/** Use the captured official columns, including repeated stops on outbound/return legs. */
export function parseTransportationSchedules(dataset: RawDatasetV1): PublishedShuttleSchedule[] {
  if (dataset.dataset !== 'transportation') throw new Error('Expected the transportation raw dataset.');
  return ROUTES.map(([name, serviceDay, slug]) => {
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
}
