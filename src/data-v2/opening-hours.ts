/** Weekly wall-clock intervals. Calendar applicability is separate source metadata. */
export interface OpeningInterval {
  open: string;
  close: string;
  close_day_offset?: 1;
}

const CLOCK = '(?:\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?\\s*m\\.?|\\d{2}:\\d{2}|noon|midnight)';
const RANGE = new RegExp(`^(${CLOCK})\\s*(?:[-–—]|to)\\s*(${CLOCK})$`, 'i');

function minutes(value: string): number | null {
  if (/^noon$/i.test(value)) return 720;
  if (/^midnight$/i.test(value)) return 0;
  const clock = value.replace(/\./g, '').replace(/\s+/g, '').match(/^(\d{1,2})(?::(\d{2}))?([ap]m)?$/i);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  if (minute > 59) return null;
  if (clock[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
  } else if (!clock[2] || hour > 23) return null;
  return hour * 60 + minute;
}

function clock(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** [] is explicit closure; null is unknown, malformed, ambiguous or partially parsed text. */
export function normalizeOpeningHours(schedule: string | null | undefined): OpeningInterval[] | null {
  const text = schedule?.trim();
  if (!text) return null;
  if (/^closed$/i.test(text)) return [];
  const intervals: OpeningInterval[] = [];
  const windows: { start: number; end: number }[] = [];
  for (const segment of text.split(/\s+and\s+|;|,/i)) {
    const range = segment.trim().match(RANGE);
    if (!range) return null;
    const start = minutes(range[1]);
    const close = minutes(range[2]);
    if (start === null || close === null || start === close) return null;
    const overnight = close < start;
    const end = close + (overnight ? 1440 : 0);
    if (windows.some(window => start < window.end && window.start < end)) return null;
    windows.push({ start, end });
    intervals.push({ open: clock(start), close: clock(close), ...(overnight ? { close_day_offset: 1 as const } : {}) });
  }
  return intervals;
}
