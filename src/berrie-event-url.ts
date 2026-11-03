/**
 * A Berrie Center show's own page: www.ramapo.edu/berriecenter/event/<slug>/, and for a show
 * with several performances one page per date, /berriecenter/event/<slug>/<YYYY-MM-DD>/.
 * The path after /event/ names one performance, so it is the show's stable ID.
 */
const BERRIE_EVENT_PATH = /^\/berriecenter\/event\/([a-z0-9_-]+(?:\/\d{4}-\d{2}-\d{2})?)\/?$/i;

/** The performance's ID ("as-you-like-it/2026-11-13"), or '' for any other address. */
export function berrieEventId(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['www.ramapo.edu', 'ramapo.edu'].includes(url.hostname.toLowerCase()) ||
      url.port || url.username || url.password) return '';
    return url.pathname.match(BERRIE_EVENT_PATH)?.[1].toLowerCase() ?? '';
  } catch {
    return '';
  }
}

/** The one address each performance is looked up by. */
export function canonicalBerrieEventUrl(value: unknown): string | undefined {
  const id = berrieEventId(value);
  return id ? `https://www.ramapo.edu/berriecenter/event/${id}/` : undefined;
}
