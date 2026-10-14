/**
 * The menu files a dining venue publishes instead of dated menus: The Atrium's menu board is a
 * PDF, for example. Each file keeps the venue's name, its own title (from its file name) and its
 * address. A relative address is resolved against the media host the same state names for its
 * other files; with no such host it is left out rather than guessed.
 */
type JsonRecord = Record<string, unknown>;

export interface MenuDocument { name: string; title: string; url: string; mimeType: string }

const MEDIA_PATH = '/web/en-us/media/';

/** "/web/en-us/media/Atrium%20Menu%20Boards%202026_tcm17-92157.pdf" → "Atrium Menu Boards 2026". */
export function documentTitle(uri: string): string {
  const file = decodeURIComponent(uri.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '');
  return file.replace(/(?:_tcm[\d-]+)+$/i, '').replace(/\s+/g, ' ').trim();
}

/** A file whose title names only years before the capture's ("Starbucks FallMenu2024" in 2026) is
 * an old menu the feed still links; it is left out. A title naming no year is kept. */
export function isOutdatedTitle(title: string, capturedAt: Date): boolean {
  const years = [...title.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map(match => Number(match[1]));
  return years.length > 0 && years.every(year => year < capturedAt.getUTCFullYear());
}

export function menuDocuments(state: JsonRecord, capturedAt?: Date): MenuDocument[] {
  const text = JSON.stringify(state);
  const absolute = [...text.matchAll(/https:\/\/[a-z0-9.-]+\/web\/en-us\/media\/[^"]+/gi)].map(match => new URL(match[0]).origin);
  const origins = new Set(absolute);
  const origin = origins.size === 1 ? [...origins][0] : null;
  const found: MenuDocument[] = [];
  const regions = (((state.composition as JsonRecord)?.subject as JsonRecord)?.regions ?? []) as JsonRecord[];
  for (const fragment of regions.flatMap(region => (region.fragments ?? []) as JsonRecord[])) {
    const main = ((fragment.content as JsonRecord)?.main ?? {}) as JsonRecord;
    const name = typeof main.name === 'string' ? main.name.trim() : '';
    for (const menu of (Array.isArray(main.menus) ? main.menus : []) as JsonRecord[]) {
      const media = (((((menu.content as JsonRecord)?.main as JsonRecord)?.link as JsonRecord)?.media as JsonRecord)?.content as JsonRecord)?.main as JsonRecord | undefined;
      const uri = typeof media?.uri === 'string' ? media.uri : '';
      if (!name || media?.type !== 'Download' || !uri) continue;
      const url = /^https:\/\//i.test(uri) ? uri : uri.startsWith(MEDIA_PATH) && origin ? `${origin}${uri}` : '';
      if (!url) continue;
      const title = documentTitle(uri);
      if (capturedAt && isOutdatedTitle(title, capturedAt)) continue;
      found.push({ name, title, url, mimeType: typeof media.mimeType === 'string' ? media.mimeType : '' });
    }
  }
  return found;
}

/** What one venue's Sodexo listing names as its menus. `dated` is true when one of them links to
 * a menu page (Birch Tree Inn's dated menus); a venue listing only files, or nothing, publishes no
 * dated menu. `menus` keeps each listed menu's name and what it links to, as the page states it. */
export interface MenuListing { name: string; dated: boolean; menus: Array<{ name: string; kind: 'page' | 'file' | 'none'; uri: string }> }

export function menuListings(state: JsonRecord): MenuListing[] {
  const regions = (((state.composition as JsonRecord)?.subject as JsonRecord)?.regions ?? []) as JsonRecord[];
  const listings: MenuListing[] = [];
  for (const fragment of regions.flatMap(region => (region.fragments ?? []) as JsonRecord[])) {
    const main = ((fragment.content as JsonRecord)?.main ?? {}) as JsonRecord;
    const name = typeof main.name === 'string' ? main.name.trim() : '';
    if (!name || !Array.isArray(main.menus)) continue;
    const menus = (main.menus as JsonRecord[]).map(menu => {
      const content = ((menu.content as JsonRecord)?.main ?? {}) as JsonRecord;
      const link = (content.link ?? {}) as JsonRecord;
      const media = ((((link.media as JsonRecord)?.content as JsonRecord)?.main) ?? {}) as JsonRecord;
      const kind: 'page' | 'file' | 'none' = typeof link.uri === 'string' && link.uri ? 'page'
        : media.type === 'Download' && typeof media.uri === 'string' && media.uri ? 'file' : 'none';
      const uri = kind === 'page' ? String(link.uri) : kind === 'file' ? String(media.uri) : '';
      return { name: typeof content.name === 'string' ? content.name.trim() : '', kind, uri };
    });
    listings.push({ name, dated: menus.some(menu => menu.kind === 'page'), menus });
  }
  return listings;
}
