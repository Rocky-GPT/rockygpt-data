/**
 * The dining hours page as a browser shows it. Sodexo stores some closed days as a range with no
 * times and no label, and only its page renderer prints "Closed" for them. This keeps what the page
 * displays for each venue's regular day groups, so a closure is read from the page, never inferred.
 */
import type { Browser } from 'playwright';

export interface RenderedDayGroup { days: string; hours: string[] }
export interface RenderedVenue { name: string; regular: RenderedDayGroup[] }
/** What happened to the page's "More hours" buttons: opened, hidden (left alone), or would not open. */
export interface MoreHoursResult { opened: number; hidden: number; stuck: number }
export interface RenderedDiningHours { sourceUrl: string; renderedAt: string; venues: RenderedVenue[]; moreHours?: MoreHoursResult }

const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** How long the page's own script gets to draw the venues after the network goes quiet. */
const DRAW_TIMEOUT_MS = 30_000;
/** How long one "More hours" button gets to open. A person's click is instant. */
const OPEN_TIMEOUT_MS = 5_000;

/** The part of a page button this needs. */
export interface MoreHoursButton { isVisible(): Promise<boolean>; click(options: { timeout: number }): Promise<void> }

/**
 * Opens each "More hours" button a person could click, last one first so a button that goes away
 * when opened does not move the ones still to open. Opening is a means, not the goal: the page often
 * prints every venue's regular hours with no button at all, and at times carries a button that is
 * hidden. A hidden button cannot be clicked, so it is left alone, and one that will not open is
 * counted and passed over. The caller reads whatever regular hours the page then shows.
 */
export async function openMoreHours(buttons: MoreHoursButton[]): Promise<MoreHoursResult> {
  const result: MoreHoursResult = { opened: 0, hidden: 0, stuck: 0 };
  for (const button of [...buttons].reverse()) {
    if (!(await button.isVisible())) { result.hidden++; continue; }
    await button.click({ timeout: OPEN_TIMEOUT_MS }).then(() => { result.opened++; }, () => { result.stuck++; });
  }
  return result;
}

/** Every venue's "Regular Hours" groups exactly as the page prints them, with "More hours" opened where it can be. */
export async function captureRenderedDiningHours(browser: Browser, url: string): Promise<RenderedDiningHours> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    // The page's own script draws the venues; a quiet network does not mean they are drawn yet.
    await page.locator('h2.location-name').first().waitFor({ state: 'attached', timeout: DRAW_TIMEOUT_MS });
    const moreHours = await openMoreHours(await page.locator('.more-hours').all());
    if (moreHours.opened) await page.waitForTimeout(1000);
    const venues = await page.evaluate(() => [...document.querySelectorAll('h2.location-name')].map((heading) => {
      // The venue's own block: the nearest container holding this heading (not the whole page).
      const block = heading.closest('[class*="Hoursstyles__LocationHoursContainer"]');
      const regular = [...(block?.querySelectorAll('h3') ?? [])].find((h3) => h3.textContent?.trim() === 'Regular Hours');
      // Only the groups printed after the "Regular Hours" heading: a venue's special hours come before it.
      const groups = [...(regular?.parentElement?.querySelectorAll('.hours-detail-container') ?? [])]
        .filter((group) => Boolean(regular && (regular.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING)))
        .map((group) => {
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
      moreHours,
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
