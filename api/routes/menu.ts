/**
 * @module api/menu/route
 * Serves the generated dining-menu markdown context file.
 *
 * Returns the full `data/context/dining/menu.md` content along with
 * generation and file-modified timestamps used by the menu modal
 * to display freshness indicators.
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



async function isBirchClosedToday(): Promise<boolean> {
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

    const now = new Date();
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
    const sched = activeSeasonSchedule(birch.content.main.openingHours, weekday, now);
    return sched === SEASONAL_CLOSURE || sched === 'Closed';
  } catch {
    return false;
  }
}

/**
 * Returns the current dining menu payload.
 */
export const getMenu: ApiHandler = async () => {
  try {
    const isClosed = await isBirchClosedToday();
    if (isClosed) {
      return json({
        content: null,
        success: true,
        available: false,
        closed: true,
        closureReason: 'Seasonal closure',
      });
    }

    const loaded = await loadReleaseArtifact('menu-context');
    const fileContent = (loaded.payload as { content?: unknown }).content;
    if (typeof fileContent !== 'string') throw new Error('Invalid menu artifact.');

    const generatedMatch = fileContent.match(/\*Generated \(UTC\):\s*([^\*]+)\*/);
    const generatedUtc = generatedMatch?.[1]?.trim() || null;

    return json({
      content: fileContent,
      success: true,
      available: true,
      generatedUtc,
      fileUpdatedUtc: generatedUtc,
      releaseVersion: loaded.releaseVersion,
    });
  } catch (error) {
    console.error('Error serving menu file:', error);
    return json(
      { error: 'Menu data unavailable' }, 
      { status: 404 }
    );
  }
}
