/**
 * The dining hours page as a browser shows it. Sodexo stores some closed days as a range with no
 * times and no label, and only its page renderer prints "Closed" for them. This keeps what the page
 * displays for each venue's regular day groups, so a closure is read from the page, never inferred.
 */
import type { Browser } from 'playwright';

export interface RenderedDayGroup { days: string; hours: string[] }
export interface RenderedVenue { name: string; regular: RenderedDayGroup[] }
export interface RenderedDiningHours { sourceUrl: string; renderedAt: string; venues: RenderedVenue[] }

const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** Every venue's "Regular Hours" groups exactly as the page prints them after "More hours" is opened. */
export async function captureRenderedDiningHours(browser: Browser, url: string): Promise<RenderedDiningHours> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    for (const more of await page.locator('.more-hours').all()) await more.click();
    await page.waitForTimeout(1000);
    const venues = await page.evaluate(() => [...document.querySelectorAll('h2.location-name')].map((heading) => {
      // The venue's own block: the nearest container holding this heading (not the whole page).
      const block = heading.closest('[class*="Hoursstyles__LocationHoursContainer"]');
      const regular = [...(block?.querySelectorAll('h3') ?? [])].find((h3) => h3.textContent?.trim() === 'Regular Hours');
      const groups = [...(regular?.parentElement?.querySelectorAll('.hours-detail-container') ?? [])].map((group) => {
        const label = group.querySelector('.days-label');
        label?.querySelectorAll('.sr-only').forEach((hidden) => hidden.remove());
        return { days: label?.textContent ?? '', hours: [...group.querySelectorAll('.open-hours-container span')].map((span) => span.textContent ?? '') };
      });
      return { name: heading.textContent ?? '', regular: groups };
    }));
    return {
      sourceUrl: url, renderedAt: new Date().toISOString(),
      venues: venues.map((venue) => ({ name: text(venue.name), regular: venue.regular.map((group) => ({
        days: text(group.days), hours: group.hours.map(text).filter(Boolean) })) })),
    };
  } finally {
    await page.close();
  }
}

type JsonRecord = Record<string, unknown>;

/** "Saturday - Sunday" for a group of days; one day is just its name. */
function dayLabel(days: unknown[]): string {
  const names = days.map((day) => (typeof day === 'string' ? day : text(String((day as JsonRecord)?.value ?? '')))).filter(Boolean);
  return names.length > 1 ? `${names[0]} - ${names[names.length - 1]}` : names[0] ?? '';
}

const isEmptyRange = (range: JsonRecord) => range.startTime === undefined && range.finishTime === undefined
  && !text(range.label as string | undefined) && String((range.allDay as JsonRecord)?.value ?? range.allDay ?? 'false').toLowerCase() === 'false';

/**
 * Marks a regular day group Closed where the data has only empty ranges and the rendered page prints
 * exactly "Closed" for the same venue and the same days. Returns the venues and days it marked.
 */
export function applyRenderedClosures(state: JsonRecord, rendered: RenderedDiningHours): string[] {
  const marked: string[] = [];
  const regions = (((state.composition as JsonRecord)?.subject as JsonRecord)?.regions ?? []) as JsonRecord[];
  for (const fragment of regions.flatMap((region) => (region.fragments ?? []) as JsonRecord[])) {
    const main = ((fragment.content as JsonRecord)?.main ?? {}) as JsonRecord;
    const venue = rendered.venues.find((item) => item.name === text(main.name as string));
    if (!venue) continue;
    for (const group of (((main.openingHours as JsonRecord)?.standardHours ?? []) as JsonRecord[])) {
      const ranges = (group.hours ?? []) as JsonRecord[];
      if (!ranges.length || !ranges.every(isEmptyRange)) continue;
      const days = dayLabel((group.days ?? []) as unknown[]);
      const shown = venue.regular.filter((item) => item.days.replace(/\s*-\s*/g, ' - ') === days);
      if (shown.length !== 1 || shown[0].hours.length !== 1 || shown[0].hours[0] !== 'Closed') continue;
      for (const range of ranges) { range.closed = true; range.label = 'Closed'; }
      marked.push(`${venue.name}: ${days}`);
    }
  }
  return marked;
}
