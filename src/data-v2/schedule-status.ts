/**
 * Deterministic open/closed status for a published schedule string.
 *
 * Schedules are published as prose — "8:00am-9:30am and 11:30am-12:30pm",
 * "07:45 AM - 02:00 PM", "CLOSED" — and until now the service returned that
 * text unchanged, leaving every consumer to parse the windows and compare them
 * against the clock itself. Measured cost of that: a language model asked
 * whether a venue is open scored 6.7% at exactly the closing minute and 20%
 * between two windows, while scoring 96.7% at an opening minute
 * (rockygpt-evals/corpus/BASELINE.md).
 *
 * Whether a moment falls inside a published window is arithmetic with one
 * correct answer, so it is computed here once rather than re-derived, possibly
 * differently, by each consumer.
 *
 * **Interval semantics are half-open: `[start, end)`.** A venue is open at its
 * opening minute and closed at its closing minute. This is stated rather than
 * left to a consumer's judgement, because "open until 5:00pm" is genuinely
 * ambiguous in English and inconsistent answers to the same question are worse
 * than either convention.
 *
 * Text this module cannot parse yields `unknown` — never `closed`. Reporting a
 * venue shut because its hours were written in an unfamiliar format would turn
 * a formatting problem into a false factual claim.
 */

export type ScheduleStatusReason =
  | 'open'
  | 'before_first_open'
  | 'between_windows'
  | 'after_last_close'
  | 'closed_all_day'
  | 'unknown';

export interface ScheduleStatus {
  /** Absent when the schedule text could not be parsed. */
  openNow?: boolean;
  /** Next opening time later today, when currently closed and one remains. */
  opensAt?: string;
  /** End of the window currently in progress, when open. */
  closesAt?: string;
  statusReason: ScheduleStatusReason;
}

interface Window {
  start: number;
  end: number;
}

const MINUTES_PER_DAY = 24 * 60;
const TIME = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/gi;
/** Windows are separated by "and", a semicolon, or a comma. */
const SEPARATOR = /\s+and\s+|;|,/i;

function toMinutes(hour: number, minute: number, meridiem: string): number {
  const base = hour % 12;
  return (meridiem.toLowerCase() === 'p' ? base + 12 : base) * 60 + minute;
}

/** Minutes past midnight rendered the way the datasets publish times. */
export function formatMinutes(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

/**
 * Open windows in a schedule string.
 *
 * `[]` means closed all day. `null` means the text was not understood, which
 * callers must not treat as closed.
 */
export function parseSchedule(schedule: string): Window[] | null {
  const text = (schedule || '').trim();
  if (!text) return null;
  if (/^closed\b/i.test(text)) return [];
  // "Unknown" is what the repositories emit for a day a venue publishes no
  // hours for. It is an absence of data, not a closure.
  if (/^unknown\b/i.test(text)) return null;

  const windows: Window[] = [];
  for (const segment of text.split(SEPARATOR)) {
    const times = [...segment.matchAll(TIME)];
    if (times.length !== 2) continue;
    const [open, close] = times.map((match) =>
      toMinutes(Number(match[1]), Number(match[2] ?? 0), match[3])
    );
    windows.push({ start: open, end: close });
  }
  return windows.length ? windows.sort((left, right) => left.start - right.start) : null;
}

/** True when a window covers `minutes`, half-open, wrapping past midnight. */
function covers(window: Window, minutes: number): boolean {
  return window.end > window.start
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end;
}

/**
 * Status of one schedule at one moment.
 *
 * `minutes` is minutes past midnight in campus local time; the caller owns the
 * timezone conversion, so this stays a pure function of a schedule and a clock.
 */
export function scheduleStatusAt(schedule: string, minutes: number): ScheduleStatus {
  const windows = parseSchedule(schedule);
  if (windows === null) return { statusReason: 'unknown' };
  if (windows.length === 0) return { openNow: false, statusReason: 'closed_all_day' };

  const current = windows.find((window) => covers(window, minutes));
  if (current) {
    return {
      openNow: true,
      closesAt: formatMinutes(current.end),
      statusReason: 'open',
    };
  }

  // Closed. Which kind of closed is the part a consumer cannot recover from a
  // bare `false`, and is what makes a useful answer possible: "opens at 11:30"
  // versus "closed for the rest of the day".
  const upcoming = windows.find((window) => window.start > minutes);
  if (!upcoming) return { openNow: false, statusReason: 'after_last_close' };
  return {
    openNow: false,
    opensAt: formatMinutes(upcoming.start),
    statusReason: upcoming === windows[0] ? 'before_first_open' : 'between_windows',
  };
}
