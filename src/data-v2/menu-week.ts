import { loadReleaseArtifact } from './release-artifacts';
import type { MenuItemRecord } from './schemas';
import { V2_SOURCES } from './sources';

/**
 * @module data-v2/menu-week
 * The seven-day menu the collector already publishes.
 *
 * The structured `menu_items` table holds one day, so chat answered "I don't
 * have that" to any question about another day — while the menu modal, one
 * click away in the same app, displayed the full week from the `menu-week`
 * release artifact. The data was published; only one reader could see it.
 *
 * Reads that same artifact so chat and the modal answer from one source.
 */

interface RawItem {
  formalName?: unknown;
  description?: unknown;
  calories?: unknown;
  isVegan?: unknown;
  isVegetarian?: unknown;
  allergens?: unknown;
}

interface RawGroup {
  name?: unknown;
  items?: unknown;
}

interface RawSection {
  name?: unknown;
  groups?: unknown;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Sections carry the meal period ("Lunch"), groups the station ("Chefs Table").
 * Both are flattened onto each item so the result matches `MenuItemRecord`,
 * which is what every dining answer template already expects.
 */
function itemsFromSections(sections: RawSection[]): MenuItemRecord[] {
  const records: MenuItemRecord[] = [];

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const meal = stringOrUndefined(section.name) ?? 'MENU';
    const groups = Array.isArray(section.groups) ? (section.groups as RawGroup[]) : [];

    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const station = stringOrUndefined(group.name) ?? 'General';
      const items = Array.isArray(group.items) ? (group.items as RawItem[]) : [];

      for (const item of items) {
        const name = stringOrUndefined(item?.formalName);
        if (!name) continue;
        const allergens = Array.isArray(item.allergens)
          ? (item.allergens as Array<{ name?: unknown }>)
              .map((allergen) => stringOrUndefined(allergen?.name))
              .filter((value): value is string => Boolean(value))
          : [];
        records.push({
          meal: meal.toUpperCase(),
          station,
          name,
          calories: stringOrUndefined(item.calories),
          vegan: item.isVegan === true,
          vegetarian: item.isVegetarian === true,
          allergens,
          source: V2_SOURCES.dining,
        });
      }
    }
  }

  return records;
}

/**
 * Menu items for one calendar date, or an empty list when the published window
 * does not cover it. An empty list is a real answer — the collector publishes
 * seven days, and the last of them is often still empty upstream.
 */
export async function menuItemsForDate(date: string): Promise<MenuItemRecord[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];

  try {
    const loaded = await loadReleaseArtifact('menu-week');
    const week = loaded.payload as { dates?: Array<{ date?: unknown; sections?: unknown }> };
    const match = Array.isArray(week.dates)
      ? week.dates.find((entry) => entry.date === date)
      : undefined;
    if (!match || !Array.isArray(match.sections)) return [];
    return itemsFromSections(match.sections as RawSection[]);
  } catch {
    // A missing artifact leaves the caller to defer, which is what it did
    // before this module existed.
    return [];
  }
}

/** The dates the published window covers, for diagnostics and tests. */
export async function publishedMenuDates(): Promise<string[]> {
  try {
    const loaded = await loadReleaseArtifact('menu-week');
    const week = loaded.payload as { dates?: Array<{ date?: unknown }> };
    return Array.isArray(week.dates)
      ? week.dates
          .map((entry) => (typeof entry.date === 'string' ? entry.date : null))
          .filter((value): value is string => Boolean(value))
      : [];
  } catch {
    return [];
  }
}
