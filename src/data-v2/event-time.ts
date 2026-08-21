/**
 * Deterministic campus event time parsing (PROB-011).
 *
 * Normalized events carry human labels like "Thu, Aug 20, 2026" + "8 AM".
 * `Date.parse` over those strings is runtime/locale-sensitive and rejects
 * whole-hour times, which previously published most events with a NULL
 * `starts_at`. This module parses the supported label shapes explicitly and
 * localizes them to the campus timezone, so a required start either becomes
 * a canonical timestamp or fails loudly — never a silent NULL.
 */

export const CAMPUS_TIME_ZONE = 'America/New_York';

const MONTH_BY_PREFIX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DATE_PATTERN = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/;
const TIME_PATTERN = /(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?/i;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

interface TimeParts {
  hour: number;
  minute: number;
}

export type EventStartParse =
  | { ok: true; startsAtIso: string }
  | { ok: false; reason: string };

function parseTimeText(label: string | undefined): TimeParts | null {
  if (!label) return null;
  const match = label.match(TIME_PATTERN);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const period = match[3].toUpperCase();
  if (period === 'P' && hour < 12) hour += 12;
  if (period === 'A' && hour === 12) hour = 0;
  return { hour, minute };
}

function parseDateText(
  label: string
): { date: DateParts; embeddedTime: TimeParts | null } | null {
  const match = label.match(DATE_PATTERN);
  if (!match || match.index === undefined) return null;
  const month = MONTH_BY_PREFIX[match[1].slice(0, 3).toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || day < 1 || day > 31) return null;
  // Some scraped ranges embed the start time inside the date label
  // ("Sun, Aug 23, 2026 10:00 PM –"); that time is the event start.
  const remainder = label.slice(match.index + match[0].length);
  return { date: { year, month, day }, embeddedTime: parseTimeText(remainder) };
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC instant without a
 * timezone library: render a guess back into the zone via Intl and correct by
 * the difference. Two passes settle every regular and DST-transition date to
 * one deterministic instant.
 */
function zonedTimeToUtc(date: DateParts, time: TimeParts, timeZone: string): Date {
  const desired = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  let guess = desired;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(guess));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const rendered = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute')
    );
    if (rendered === desired) break;
    guess += desired - rendered;
  }
  return new Date(guess);
}

export function parseEventStart(
  dateLabel: string | undefined,
  timeLabel?: string,
  timeZone = CAMPUS_TIME_ZONE
): EventStartParse {
  const parsedDate = parseDateText(dateLabel ?? '');
  if (!parsedDate) {
    return { ok: false, reason: `unrecognized date label "${dateLabel ?? ''}"` };
  }
  let time = parsedDate.embeddedTime;
  if (!time) {
    if (timeLabel && DATE_PATTERN.test(timeLabel)) {
      // A full date in the time field is an end datetime from a scraped
      // range; without an embedded start on the date label there is no
      // trustworthy start time.
      return {
        ok: false,
        reason: `time label "${timeLabel}" contains a date instead of a start time`,
      };
    }
    time = parseTimeText(timeLabel);
  }
  if (!time) {
    return { ok: false, reason: `unrecognized start time "${timeLabel ?? ''}"` };
  }
  return {
    ok: true,
    startsAtIso: zonedTimeToUtc(parsedDate.date, time, timeZone).toISOString(),
  };
}

export interface UnparseableEventStart {
  title: string;
  dateLabel: string;
  reason: string;
}

/**
 * Publishable events (rows carrying a title and date, mirroring the
 * publisher's own skip rule) whose start cannot be parsed. Used by the
 * quality gate so invalid rows fail before activation instead of becoming
 * permanently eligible NULL timestamps.
 */
export function unparseableEventStarts(
  events: Array<Record<string, unknown>>
): UnparseableEventStart[] {
  const failures: UnparseableEventStart[] = [];
  for (const event of events) {
    const title = typeof event.title === 'string' ? event.title.trim() : '';
    const dateLabel = typeof event.date === 'string' ? event.date.trim() : '';
    if (!title || !dateLabel) continue;
    const timeLabel = typeof event.time === 'string' ? event.time : undefined;
    const parsed = parseEventStart(dateLabel, timeLabel);
    if (!parsed.ok) failures.push({ title, dateLabel, reason: parsed.reason });
  }
  return failures;
}
