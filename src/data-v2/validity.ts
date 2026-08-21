/**
 * @module data-v2/validity
 *
 * Campus hours arrive with their applicability written into a free-text note —
 * `"Spring Semester 2026 (Jan 20 – May 12)"` — while the weekday table beside
 * it carries no dates at all. Nothing parsed that note, so `valid_from` and
 * `valid_until` were published NULL, and the repository reads NULL validity as
 * "applies on every date". That is how Spring semester library hours were
 * answered as today's hours in August.
 *
 * This turns the note back into a window the rest of the pipeline already
 * knows how to honour.
 */

export interface ValidityWindow {
  /** ISO date, YYYY-MM-DD. */
  validFrom: string;
  /** ISO date, YYYY-MM-DD. Inclusive. */
  validUntil: string;
}

export interface NotesValidity {
  /** An explicit, dated range found in the note. */
  window: ValidityWindow | null;
  /**
   * A term or season was named but carried no dates, so the content's real
   * applicability cannot be established from the note alone.
   */
  termWithoutDates: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).join('|');

// "Jan 20 – May 12", "January 20 to May 12", "Jan 20 - May 12".
const RANGE = new RegExp(
  String.raw`\b(${MONTH_NAMES})\.?\s+(\d{1,2})\b\s*(?:[–—-]|to)\s*\b(${MONTH_NAMES})\.?\s+(\d{1,2})\b`,
  'i'
);

const TERM = /\b(spring|summer|fall|autumn|winter)\b(?:\s+(?:semester|term|session))?\s*(\d{4})?/i;

const YEAR = /\b(20\d{2})\b/;

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Reads whatever applicability a free-text note states.
 *
 * A range without a year borrows the year named elsewhere in the note; a range
 * whose end month precedes its start month is taken to cross into the next
 * year (a winter session, say).
 */
export function readValidityFromNotes(notes?: string | null): NotesValidity {
  const text = (notes ?? '').trim();
  if (!text) return { window: null, termWithoutDates: null };

  const range = RANGE.exec(text);
  if (range) {
    const [, startMonthName, startDayText, endMonthName, endDayText] = range;
    const startMonth = MONTHS[startMonthName!.toLowerCase()]!;
    const endMonth = MONTHS[endMonthName!.toLowerCase()]!;
    const startDay = Number(startDayText);
    const endDay = Number(endDayText);

    const yearMatch = YEAR.exec(text);
    if (yearMatch) {
      const startYear = Number(yearMatch[1]);
      const crossesNewYear =
        endMonth < startMonth || (endMonth === startMonth && endDay < startDay);
      return {
        window: {
          validFrom: iso(startYear, startMonth, startDay),
          validUntil: iso(crossesNewYear ? startYear + 1 : startYear, endMonth, endDay),
        },
        termWithoutDates: null,
      };
    }
  }

  // A term named with no dates: the note asserts a season without bounding it.
  const term = TERM.exec(text);
  if (term) {
    return { window: null, termWithoutDates: term[0].trim() };
  }

  return { window: null, termWithoutDates: null };
}

/** True once `now` is past the window's final day. */
export function isWindowExpired(window: ValidityWindow, now: Date): boolean {
  const today = now.toISOString().slice(0, 10);
  return today > window.validUntil;
}

interface HoursRecord {
  name?: unknown;
  notes?: unknown;
}

/**
 * Content whose own note says it stopped applying must not reach publish.
 *
 * Freshness gates measure when a source was *collected*, so hours collected
 * yesterday pass even when the schedule inside them expired last semester.
 * This is the content-side counterpart.
 */
export function hoursValidityErrors(
  records: unknown,
  now: Date
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(records)) return { errors, warnings };

  for (const record of records as HoursRecord[]) {
    const name = typeof record?.name === 'string' ? record.name : 'unnamed location';
    const notes = typeof record?.notes === 'string' ? record.notes : undefined;
    const { window, termWithoutDates } = readValidityFromNotes(notes);

    if (window && isWindowExpired(window, now)) {
      errors.push(
        `Hours for "${name}" expired on ${window.validUntil} (${notes}). ` +
          'Refresh the source or remove the stale schedule before publishing.'
      );
    } else if (termWithoutDates) {
      warnings.push(
        `Hours for "${name}" cite "${termWithoutDates}" without dates, so their validity ` +
          'cannot be checked or published. Add an explicit range to the note.'
      );
    }
  }

  return { errors, warnings };
}
