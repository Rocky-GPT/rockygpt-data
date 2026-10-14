import { CAMPUS_TIME_ZONE } from './event-time';

/**
 * Seasonal dining-hours resolution (PROB-010), shared by the file
 * repository, the publisher, and (semantically) the dedicated dining-hours
 * API: the first season covering the instant governs. Missing seasonal
 * details are unknown, not a closure or permission to use standard hours.
 */

type JsonRecord = Record<string, unknown>;

export const SEASONAL_CLOSURE = 'Closed (seasonal closure)';
export const DINING_HOURS_UNKNOWN = 'Hours unavailable';

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

export function formatDiningRange(range: JsonRecord, includeLabel = true): string {
  const start = range.startTime as SeasonTime | undefined;
  const finish = range.finishTime as SeasonTime | undefined;
  const label = typeof range.label === 'string' ? range.label.trim() : '';
  const allDayValue = range.allDay && typeof range.allDay === 'object'
    ? (range.allDay as JsonRecord).value : range.allDay;
  if (range.closed === true || (typeof allDayValue === 'string'
    && allDayValue.trim().toLowerCase() === 'closed') || /^(closed|no service)\b/i.test(label)) return 'Closed';
  const valid = (time: SeasonTime | undefined): boolean => Boolean(time &&
    /^(0?[1-9]|1[0-2])$/.test(String(time.hour)) &&
    /^[0-5]\d$/.test(String(time.minute)) && /^(AM|PM)$/i.test(String(time.period)));
  if (!valid(start) || !valid(finish)) return includeLabel && label ? `${label}: ${DINING_HOURS_UNKNOWN}` : DINING_HOURS_UNKNOWN;
  const prefix = includeLabel && label ? `${label}: ` : '';
  return `${prefix}${start!.hour}:${start!.minute} ${start!.period} - ${finish!.hour}:${finish!.minute} ${finish!.period}`;
}

function seasonList(openingHours: JsonRecord): JsonRecord[] {
  return Array.isArray(openingHours.seasonalHours)
    ? (openingHours.seasonalHours as JsonRecord[])
    : [];
}

function dayGroupSchedule(groups: JsonRecord[], day: string): string | null {
  const schedules: string[] = [];
  for (const group of groups) {
    const days = Array.isArray(group.days) ? (group.days as JsonRecord[]) : [];
    if (!days.some((entry) => entry.value === day)) continue;
    const hours = Array.isArray(group.hours) ? (group.hours as JsonRecord[]) : [];
    const schedule = hours.map((range) => formatDiningRange(range)).join('; ');
    schedules.push(schedule || DINING_HOURS_UNKNOWN);
  }
  return schedules.length ? schedules.join('; ') : null;
}

/**
 * The schedule imposed by an active seasonal override for `day` at the
 * instant `at`, or null when no season covers the instant (standard weekly
 * hours then apply). Matches the dedicated dining-hours API: empty seasonal
 * hours, or an active season without this day, mean hours are unavailable.
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
    if (!groups.length) return DINING_HOURS_UNKNOWN;
    const schedule = dayGroupSchedule(groups, day);
    return schedule === 'Closed' ? SEASONAL_CLOSURE : schedule ?? DINING_HOURS_UNKNOWN;
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

/** The weekdays that occur between two campus-local dates, inclusive. */
function weekdaysBetween(validFrom: string, validUntil: string): Set<string> {
  const days = new Set<string>();
  const until = Date.parse(`${validUntil}T00:00:00Z`);
  for (let at = Date.parse(`${validFrom}T00:00:00Z`); at <= until && days.size < 7; at += 86_400_000) {
    days.add(WEEK[new Date(at).getUTCDay()]);
  }
  return days;
}

/**
 * Database rows for each season × weekday that occurs within the season's
 * campus-local dates; a weekday outside them could never apply. Day-granular
 * bounds round outward, so an override can only over-apply on its boundary
 * day. A missing override remains unknown; it must never be rendered as a
 * confirmed closure.
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
    const days = weekdaysBetween(validFrom, validUntil);
    for (const day of WEEK) {
      if (!days.has(day)) continue;
      const schedule = groups.length ? dayGroupSchedule(groups, day) : null;
      rows.push({
        day,
        schedule: schedule === 'Closed' ? SEASONAL_CLOSURE : schedule ?? DINING_HOURS_UNKNOWN,
        validFrom,
        validUntil,
      });
    }
  }
  return rows;
}
