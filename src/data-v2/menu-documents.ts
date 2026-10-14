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

export function menuDocuments(state: JsonRecord): MenuDocument[] {
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
      found.push({ name, title: documentTitle(uri), url, mimeType: typeof media.mimeType === 'string' ? media.mimeType : '' });
    }
  }
  return found;
}
