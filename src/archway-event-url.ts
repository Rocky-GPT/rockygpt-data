/** Archway may redirect the listing's RSVP URL into the hosting group's path.
 * Only an unambiguous numeric event ID on the official host identifies the
 * same occurrence. This lookup key must not replace a captured source URL. */
export function canonicalArchwayEventUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const ids = url.searchParams.getAll('id');
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'archway.ramapo.edu' ||
      url.port || url.username || url.password || !/\/(?:rsvp_boot|rsvp)\/?$/.test(url.pathname) ||
      ids.length !== 1 || !/^\d+$/.test(ids[0])) return undefined;
    return `https://archway.ramapo.edu/rsvp_boot?id=${ids[0]}`;
  } catch {
    return undefined;
  }
}
