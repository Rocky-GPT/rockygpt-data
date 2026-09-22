import { load } from 'cheerio';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawPageV1 } from './raw-types';

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
function archwayUrl(value: string, base?: string): URL | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol === 'https:' && url.hostname === 'archway.ramapo.edu' && !url.username && !url.password) return url;
  } catch { /* Not an official source URL. */ }
}
function eventId(url: URL | undefined): string | undefined {
  const ids = url?.searchParams.getAll('id');
  if (url && /\/(?:rsvp_boot|rsvp)\/?$/.test(url.pathname) && ids?.length === 1 && /^\d+$/.test(ids[0])) return ids[0];
}

/** Capture the explicit host block before generic HTML flattening loses its
 * association between a host name, group ID and website. Names are checks only. */
export function buildArchwayEventDetailPage(options: {
  requestedUrl: string; url: string; html: string; statusCode: number; fetchedAt?: string;
}): RawPageV1 {
  const source = archwayUrl(options.url);
  const requestedId = eventId(archwayUrl(options.requestedUrl));
  if (options.statusCode !== 200 || !requestedId || eventId(source) !== requestedId) {
    throw new Error('Archway detail did not return the requested event occurrence.');
  }
  const $ = load(options.html);
  if (!$('#event_host, .rsvp__event-org').length || /sign in or register/i.test($('title').text())) {
    throw new Error('Archway detail is not an event page (possibly a sign-in response).');
  }
  const organizers: NonNullable<RawPageV1['archwayOrganizers']> = [];
  const bylines = $('.rsvp__event-org').toArray().map(el => clean($(el).text()));
  const hosts = $('#event_host [role="group"]');
  hosts.each((_, element) => {
    if (hosts.length !== 1 || bylines.length !== 1) return;
    const block = $(element);
    if (clean(block.find('h2').text()) !== 'Hosted By') return;
    const names = block.find('strong').toArray().map(el => clean($(el).text())).filter(Boolean);
    if (names.length !== 1 || !bylines.includes(`by ${names[0]}`)) return;
    const links = block.find('a[href]').toArray().map(el => ({
      label: clean($(el).text()), url: archwayUrl($(el).attr('href')!, source!.href),
    }));
    const groupIds = new Set(links.flatMap(({ url }) => {
      const ids = url?.searchParams.getAll('group_ids');
      return url?.pathname === '/events' && ids?.length === 1 && /^\d+$/.test(ids[0]) ? ids : [];
    }));
    const websites = new Set(links.filter(link => link.label === 'Website' && link.url &&
      /^\/[^/]+\/?$/.test(link.url.pathname) && !link.url.search && !link.url.hash).map(link => link.url!.href));
    if (groupIds.size !== 1 || websites.size !== 1) return;
    organizers.push({ groupId: [...groupIds][0], groupUrl: [...websites][0], name: names[0] });
  });
  return { ...buildRawPageFromHtml({ ...options, sourceType: 'detail', allowedHost: 'archway.ramapo.edu' }),
    // An empty array means capture ran but could not verify a host; never fall
    // back to unrelated page-wide links for these new captures.
    archwayOrganizers: organizers };
}
