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

import { normalizeOpeningHours } from './opening-hours';

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
  const hours = normalizeOpeningHours(schedule);
  if (hours === null) return null;
  const minute = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  return hours.map(interval => ({
    start: minute(interval.open),
    end: minute(interval.close) + (interval.close_day_offset ?? 0) * MINUTES_PER_DAY,
  })).sort((left, right) => left.start - right.start);
}

/** Half-open minutes relative to the schedule’s service day, including next-day endpoints. */
function covers(window: Window, minutes: number): boolean {
  return minutes >= window.start && minutes < window.end;
}

/**
 * Status of one schedule at one moment.
 *
 * `minutes` is minutes past midnight in campus local time; the caller owns the
 * timezone conversion, so this stays a pure function of a schedule and a clock.
 * For overnight carryover, callers must also consult the preceding service day
 * using minutes + 1440; this function never invents a previous-day schedule.
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
