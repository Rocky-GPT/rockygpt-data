import { CAMPUS_TIME_ZONE } from './event-time';

/**
 * Seasonal dining-hours resolution (PROB-010), shared by the file
 * repository, the publisher, and (semantically) the dedicated dining-hours
 * API: the first season covering the instant governs; a season with no
 * opening hours — or none for the requested day — is a closure; otherwise
 * standard weekly hours apply.
 */

type JsonRecord = Record<string, unknown>;

export const SEASONAL_CLOSURE = 'Closed (seasonal closure)';

const WEEK = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

interface SeasonTime {
  hour?: unknown;
  minute?: unknown;
  period?: unknown;
}

function formatRange(range: JsonRecord): string {
  const start = range.startTime as SeasonTime | undefined;
  const finish = range.finishTime as SeasonTime | undefined;
  if (!start || !finish) return 'Closed';
  return `${start.hour}:${start.minute} ${start.period} - ${finish.hour}:${finish.minute} ${finish.period}`;
}

function seasonList(openingHours: JsonRecord): JsonRecord[] {
  return Array.isArray(openingHours.seasonalHours)
    ? (openingHours.seasonalHours as JsonRecord[])
    : [];
}

function dayGroupSchedule(groups: JsonRecord[], day: string): string | null {
  for (const group of groups) {
    const days = Array.isArray(group.days) ? (group.days as JsonRecord[]) : [];
    if (!days.some((entry) => entry.value === day)) continue;
    const hours = Array.isArray(group.hours) ? (group.hours as JsonRecord[]) : [];
    const schedule = hours.map(formatRange).join('; ');
    return schedule || 'Closed';
  }
  return null;
}

/**
 * The schedule imposed by an active seasonal override for `day` at the
 * instant `at`, or null when no season covers the instant (standard weekly
 * hours then apply). Matches the dedicated dining-hours API: empty seasonal
 * hours, or an active season without this day, mean the venue is closed.
 */
export function activeSeasonSchedule(
  openingHours: JsonRecord,
  day: string,
  at: Date
): string | null {
  for (const season of seasonList(openingHours)) {
    const from = Date.parse(String(season.from ?? ''));
    const to = Date.parse(String(season.to ?? ''));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (at.getTime() < from || at.getTime() > to) continue;
    const groups = Array.isArray(season.openingHours)
      ? (season.openingHours as JsonRecord[])
      : [];
    if (!groups.length) return SEASONAL_CLOSURE;
    const schedule = dayGroupSchedule(groups, day);
    return schedule === null || schedule === 'Closed' ? SEASONAL_CLOSURE : schedule;
  }
  return null;
}

export function campusLocalDate(at: Date, timeZone = CAMPUS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export interface SeasonalPublicationRow {
  day: string;
  schedule: string;
  validFrom: string;
  validUntil: string;
}

/**
 * Database rows for each season × weekday, bounded by the season's
 * campus-local dates. Day-granular bounds round outward, so an override can
 * only over-apply on its boundary day — the conservative direction (a venue
 * may be reported closed while briefly open, never open while closed).
 */
export function seasonalPublicationRows(openingHours: JsonRecord): SeasonalPublicationRow[] {
  const rows: SeasonalPublicationRow[] = [];
  for (const season of seasonList(openingHours)) {
    const fromMs = Date.parse(String(season.from ?? ''));
    const toMs = Date.parse(String(season.to ?? ''));
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue;
    const validFrom = campusLocalDate(new Date(fromMs));
    const validUntil = campusLocalDate(new Date(toMs));
    const groups = Array.isArray(season.openingHours)
      ? (season.openingHours as JsonRecord[])
      : [];
    for (const day of WEEK) {
      const schedule = groups.length ? dayGroupSchedule(groups, day) : null;
      rows.push({
        day,
        schedule: schedule === null || schedule === 'Closed' ? SEASONAL_CLOSURE : schedule,
        validFrom,
        validUntil,
      });
    }
  }
  return rows;
}
