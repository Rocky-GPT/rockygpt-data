import { validateMenuData, type MenuSection } from './schema';

/** An explicitly empty API response is unavailable menu data, not a malformed response. */
export function normalizeMenuSnapshot(input: unknown): MenuSection[] {
  if (Array.isArray(input) && input.length === 0) return [];
  return validateMenuData(input);
}

export interface MenuDateCapture {
  date: string;
  sections: unknown;
}

/** Never substitute a fabricated empty source response for a failed request. */
export async function collectMenuDates(
  dates: readonly string[],
  fetchDate: (date: string) => Promise<unknown>,
): Promise<MenuDateCapture[]> {
  const captures: MenuDateCapture[] = [];
  for (const date of dates) captures.push({ date, sections: await fetchDate(date) });
  return captures;
}

/** Rebuild the dated menu artifact directly from its unchanged raw capture. */
export function normalizeMenuWeek(input: unknown): {
  version: 1; collectedAt: string; dates: Array<{ date: string; sections: MenuSection[] }>;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('menu-week must be an object');
  }
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.collectedAt !== 'string'
      || !Number.isFinite(Date.parse(value.collectedAt)) || !Array.isArray(value.dates)
      || value.dates.length === 0) {
    throw new Error('menu-week requires version, collection time and dated captures');
  }
  const seen = new Set<string>();
  const dates = value.dates.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('menu-week date capture must be an object');
    }
    const capture = item as Record<string, unknown>;
    const date = capture.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
        || seen.has(date)) {
      throw new Error('menu-week capture requires a unique real service date');
    }
    seen.add(date);
    return { date, sections: normalizeMenuSnapshot(capture.sections) };
  });
  return { version: 1, collectedAt: value.collectedAt, dates };
}
