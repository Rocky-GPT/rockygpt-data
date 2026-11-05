/**
 * archway-app-events.ts
 *
 * What Archway's new events app knows beyond the calendar files: each event's ticket price and its
 * place as the app names it (Dan, November 5, 2026: "Also read Archway's new app").
 *
 * Since November 5, 2026 Archway's event pages are a browser app ("CampusGroups") that loads its
 * events from https://archway.ramapo.edu/api/v2/graphql. The app's own `Events` list query answers
 * without signing in, 40 upcoming events a request, so about six requests a night replace the
 * ~190 event pages read before. Archway's robots.txt (November 5) disallows only /upload/,
 * /student_docs/, /downloads/, /mobile_ws/v17/, /mobile_ws/v18/ and *ajax_widget_new.
 *
 * The calendar files stay the list of events (and their descriptions); the app only adds facts to
 * the events they list. If the app cannot be read, tonight's events go out without those facts.
 */

import { canonicalArchwayEventUrl } from '../src/archway-event-url';
import { fetchWithPolicy } from './http-client';
import { noteSiteDownloads, paceRamapoRequest } from './site-guard';
import type { ArchwayEvent } from './schema';

export const ARCHWAY_GRAPHQL_URL = 'https://archway.ramapo.edu/api/v2/graphql';
/** The app's own page size for its Events list. */
const PAGE_SIZE = 40;
/** A ceiling on pages read in one night (about 208 events were upcoming on November 5). */
const MAX_PAGES = 15;

/** The fields of the app's own `Events` query this collector uses, nothing tied to a viewer. */
export const EVENTS_QUERY = `query Events($first: Int, $after: String, $filter: EventFilterInput) {
  events(first: $first, after: $after, filter: $filter) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        id
        name
        startDate
        location { kind name isToBeDetermined eventLocationPrivacy }
        registration { paidOptionsWithheldReason options { price { amount currency isFlexible } } }
      }
    }
  }
}`;

export interface AppEvent {
  id?: string;
  name?: string;
  startDate?: string;
  location?: { kind?: string | null; name?: string | null; isToBeDetermined?: boolean | null; eventLocationPrivacy?: string | null } | null;
  registration?: { paidOptionsWithheldReason?: string | null; options?: Array<{ price?: { amount?: number | null; currency?: string | null; isFlexible?: boolean | null } | null }> | null } | null;
}

/** What the app adds to one calendar-file event. */
export interface AppEventFacts {
  ticketStatus?: string;
  location?: string;
}

/** The event's lookup URL from the app's id, which is base64 of "ramapo:Event:<number>". */
export function appEventUrl(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const decoded = Buffer.from(id, 'base64').toString('utf8');
  const match = /^ramapo:Event:(\d+)$/.exec(decoded);
  return match ? canonicalArchwayEventUrl(`https://archway.ramapo.edu/rsvp_boot?id=${match[1]}`) : undefined;
}

function dollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * The ticket line as the app's own event card writes it (amounts are dollars): "FREE" when every
 * option costs nothing, otherwise "$5" or "$5 - $10". Nothing when the event has no option, a price
 * is not in dollars, an option is a donation (isFlexible), or the app holds back paid options from
 * a reader who is not signed in (paidOptionsWithheldReason), since "FREE" could then be wrong.
 */
export function ticketStatusFromApp(event: AppEvent): string | undefined {
  if (event.registration?.paidOptionsWithheldReason) return undefined;
  const prices = (event.registration?.options ?? []).map((option) => option?.price);
  if (!prices.length) return undefined;
  const amounts: number[] = [];
  for (const price of prices) {
    if (!price || typeof price.amount !== 'number' || !Number.isFinite(price.amount) || price.amount < 0) return undefined;
    if (price.isFlexible || (price.currency && price.currency !== 'USD')) return undefined;
    amounts.push(price.amount);
  }
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  if (high === 0) return 'FREE';
  return low === high ? dollars(low) : `${dollars(low)} - ${dollars(high)}`;
}

/** The place as the app names it, when it is shown to everyone and named. */
export function placeFromApp(event: AppEvent): string | undefined {
  const location = event.location;
  if (!location || location.isToBeDetermined) return undefined;
  if (location.eventLocationPrivacy && location.eventLocationPrivacy !== 'PUBLIC') return undefined;
  const name = location.name?.replace(/\s+/g, ' ').trim();
  return name || undefined;
}

/** The facts the app gives for each event, by lookup URL. */
export function appEventFacts(events: readonly AppEvent[]): Map<string, AppEventFacts> {
  const facts = new Map<string, AppEventFacts>();
  for (const event of events) {
    const url = appEventUrl(event.id);
    if (!url) continue;
    const ticketStatus = ticketStatusFromApp(event);
    const location = placeFromApp(event);
    facts.set(url, {
      ...(ticketStatus ? { ticketStatus } : {}),
      ...(location ? { location } : {}),
    });
  }
  return facts;
}

/**
 * The calendar files' events with the app's ticket line and place. The app's place wins: the files
 * spell places their own way and hide private and online ones behind sign-in.
 */
export function withAppFacts(events: readonly ArchwayEvent[], facts: ReadonlyMap<string, AppEventFacts>): ArchwayEvent[] {
  return events.map((event) => {
    const found = event.url ? facts.get(canonicalArchwayEventUrl(event.url) ?? event.url) : undefined;
    if (!found) return event;
    return {
      ...event,
      ...(found.ticketStatus && !event.ticketStatus ? { ticketStatus: found.ticketStatus } : {}),
      ...(found.location ? { location: found.location } : {}),
    };
  });
}

interface EventsPage {
  data?: { events?: { totalCount?: number; pageInfo?: { endCursor?: string | null; hasNextPage?: boolean }; edges?: Array<{ node?: AppEvent }> } };
  errors?: Array<{ message?: string }>;
}

/** Every live or upcoming event the app lists, read one page of 40 at a time, gently. */
export async function fetchAppEvents(): Promise<{ events: AppEvent[]; requests: number; totalCount?: number }> {
  const events: AppEvent[] = [];
  let after: string | undefined;
  let totalCount: number | undefined;
  let requests = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    await paceRamapoRequest(ARCHWAY_GRAPHQL_URL);
    requests += 1;
    const response = await fetchWithPolicy(ARCHWAY_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        operationName: 'Events',
        query: EVENTS_QUERY,
        variables: { first: PAGE_SIZE, ...(after ? { after } : {}), filter: { timeRange: 'LIVE_OR_UPCOMING' } },
      }),
    }, { expectedContentTypes: ['application/json'], retryNonIdempotent: true, perHostConcurrency: 1 });
    if (!response.ok) throw new Error(`Archway's events app answered HTTP ${response.status}.`);
    const body = JSON.parse(response.text()) as EventsPage;
    if (body.errors?.length) throw new Error(`Archway's events app: ${body.errors.map((error) => error.message).join('; ')}`);
    const connection = body.data?.events;
    if (!connection) throw new Error("Archway's events app returned no events list.");
    totalCount = connection.totalCount ?? totalCount;
    for (const edge of connection.edges ?? []) if (edge.node) events.push(edge.node);
    const next = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined;
    if (!next) return { events, requests, totalCount };
    after = next;
  }
  throw new Error(`Archway's events app still had more events after ${MAX_PAGES} pages.`);
}

/**
 * Tonight's events with what the app adds. A failed read leaves the events as the calendar files
 * give them and says so in the run's note.
 */
export async function addAppFacts(events: ArchwayEvent[]): Promise<{ events: ArchwayEvent[]; facts: Map<string, AppEventFacts> }> {
  try {
    const read = await fetchAppEvents();
    const facts = appEventFacts(read.events);
    const enriched = withAppFacts(events, facts);
    const matched = events.filter((event) => event.url && facts.has(canonicalArchwayEventUrl(event.url) ?? event.url)).length;
    const priced = enriched.filter((event) => event.ticketStatus).length;
    noteSiteDownloads(`Archway events app: ${read.requests} requests, ${read.events.length} events` +
      `${read.totalCount !== undefined ? ` of ${read.totalCount}` : ''}; ${matched} of ${events.length} calendar-file events matched, ` +
      `${priced} with a ticket line.`);
    return { events: enriched, facts };
  } catch (error) {
    noteSiteDownloads(`Archway events app not read (${error instanceof Error ? error.message : String(error)}); ` +
      'events go out with the calendar files\' facts only.');
    return { events, facts: new Map() };
  }
}
