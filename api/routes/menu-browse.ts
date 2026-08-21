/**
 * @module api/menu/browse/route
 * Date-specific dining menu browsing from the active RockyGPT release.
 *
 * The daily collector fetches and normalizes the seven-day source window.
 * User requests never bypass release validation with a live upstream call.
 */

import { loadReleaseArtifact } from '../../src/data-v2/release-artifacts';
import { activeSeasonSchedule, SEASONAL_CLOSURE } from '../../src/data-v2/dining-seasons';

import type { ApiHandler, ApiResponse } from '../http';

/**
 * Mirrors the response helper these handlers were written against, so the
 * logic below is the same code that ran inside the web app.
 */
const json = (
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): ApiResponse => ({ status: init?.status ?? 200, body, headers: init?.headers });


async function isBirchClosedOnDate(dateStr: string): Promise<boolean> {
  try {
    const loaded = await loadReleaseArtifact('dining-hours');
    const p = loaded.payload as {
      composition?: {
        subject?: {
          regions?: Array<{
            fragments?: Array<{
              content?: {
                main?: {
                  name?: string;
                  openingHours?: Record<string, unknown>;
                };
              };
            }>;
          }>;
        };
      };
    };

    const fragments = p?.composition?.subject?.regions?.[0]?.fragments || [];
    const birch = fragments.find((f) => f.content?.main?.name?.toLowerCase().includes('birch'));
    if (!birch?.content?.main?.openingHours) return false;

    const targetDate = new Date(dateStr + 'T12:00:00Z');
    const weekday = targetDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
    const sched = activeSeasonSchedule(birch.content.main.openingHours, weekday, targetDate);
    return sched === SEASONAL_CLOSURE || sched === 'Closed';
  } catch {
    return false;
  }
}

/**
 * Forces this route to evaluate menu query parameters at request time.
 */

interface MenuItem {
  formalName?: string;
  description?: string;
  calories?: string;
  isVegan?: boolean;
  isVegetarian?: boolean;
  allergens?: { name: string }[];
}

interface MenuSection {
  name?: string;
  groups?: unknown[];
}

function normalizeItem(raw: unknown): MenuItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const formalName = typeof r.formalName === 'string' ? r.formalName.trim() : '';
  if (!formalName) return null;
  return {
    formalName,
    description: typeof r.description === 'string' ? r.description.trim() : undefined,
    calories: typeof r.calories === 'string' ? r.calories.trim() : undefined,
    isVegan: typeof r.isVegan === 'boolean' ? r.isVegan : undefined,
    isVegetarian: typeof r.isVegetarian === 'boolean' ? r.isVegetarian : undefined,
  };
}

function buildMarkdown(sections: MenuSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const s = section as Record<string, unknown>;
    const sectionName = typeof s.name === 'string' ? s.name.trim() : '';
    if (!sectionName) continue;
    lines.push(`## ${sectionName}`);
    lines.push('');

    const groups = Array.isArray(s.groups) ? s.groups : [];
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const g = group as Record<string, unknown>;
      const groupName = typeof g.name === 'string' ? g.name.trim() : '';
      if (groupName) {
        lines.push(`### ${groupName}`);
        lines.push('');
      }

      const items = Array.isArray(g.items) ? g.items : [];
      for (const item of items) {
        const normalized = normalizeItem(item);
        if (!normalized) continue;
        let line = `- **${normalized.formalName}**`;
        if (normalized.calories) line += ` (${normalized.calories}cal)`;
        const tags: string[] = [];
        if (normalized.isVegan) tags.push('Vegan');
        if (normalized.isVegetarian) tags.push('Vegetarian');
        if (tags.length > 0) line += ` _[${tags.join(', ')}]_`;
        lines.push(line);
        if (normalized.description) lines.push(`> ${normalized.description}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Returns menu data filtered for browsing by meal, date, or section query parameters.
 */
export const getMenuBrowse: ApiHandler = async (request) => {
  const dateParam = request.url.searchParams.get('date');

  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return json({ error: 'Missing or invalid date parameter (YYYY-MM-DD)' }, { status: 400 });
  }

  try {
    const isClosed = await isBirchClosedOnDate(dateParam);
    if (isClosed) {
      return json({
        content: null,
        success: true,
        available: false,
        closed: true,
        closureReason: 'Seasonal closure',
        date: dateParam,
      });
    }

    const loaded = await loadReleaseArtifact('menu-week');
    const week = loaded.payload as {
      dates?: Array<{ date?: unknown; sections?: unknown }>;
    };
    const match = Array.isArray(week.dates)
      ? week.dates.find((entry) => entry.date === dateParam)
      : undefined;
    const rawData = match?.sections;

    // Validate: must be an array with at least one section containing items
    if (!Array.isArray(rawData) || rawData.length === 0) {
      return json({
        content: null,
        success: true,
        available: false,
        date: dateParam,
        releaseVersion: loaded.releaseVersion,
      });
    }

    // Check if any section has valid items
    const hasItems = rawData.some((section: unknown) => {
      if (!section || typeof section !== 'object') return false;
      const s = section as Record<string, unknown>;
      const groups = Array.isArray(s.groups) ? s.groups : [];
      return groups.some((group: unknown) => {
        if (!group || typeof group !== 'object') return false;
        const g = group as Record<string, unknown>;
        const items = Array.isArray(g.items) ? g.items : [];
        return items.some((item: unknown) => {
          if (!item || typeof item !== 'object') return false;
          const i = item as Record<string, unknown>;
          return typeof i.formalName === 'string' && i.formalName.trim().length > 0;
        });
      });
    });

    if (!hasItems) {
      return json({
        content: null,
        success: true,
        available: false,
        date: dateParam,
        releaseVersion: loaded.releaseVersion,
      });
    }

    const markdown = buildMarkdown(rawData as MenuSection[]);

    return json({
      content: markdown,
      success: true,
      available: true,
      date: dateParam,
      releaseVersion: loaded.releaseVersion,
    });
  } catch (error) {
    console.error(`Error loading released menu for ${dateParam}:`, error);
    return json({
      content: null,
      success: true,
      available: false,
      date: dateParam,
    });
  }
}
