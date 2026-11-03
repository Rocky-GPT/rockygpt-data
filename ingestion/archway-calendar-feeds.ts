/**
 * archway-calendar-feeds.ts
 *
 * The Archway event list, read from the calendar files Archway publishes for every group
 * (archway.ramapo.edu/ical/ramapo/ical_club_<groupId>.ics, the "Subscribe" button's files).
 *
 * Why (Dan, November 3, 2026): the collector used to page through
 * archway.ramapo.edu/mobile_ws/v17/mobile_events_list, and Archway's robots.txt asks every robot
 * to stay out of /mobile_ws/v17/. The calendar files and the Subscribe page that lists them are
 * not disallowed. The school-wide file (ical_ramapo.ics) is not used: on November 3 it still held
 * only August 20 to September 8, while each group's own file was current.
 *
 * Gentle by design: the Subscribe page is read once a run. On a normal day only the groups that had
 * events in the last capture are read (42 on November 3). Every group is read on Mondays, when no
 * last capture exists, or when ARCHWAY_FEEDS_ALL=1, so a group's first event shows up within a week.
 */

import pLimit from 'p-limit';
import { canonicalArchwayEventUrl } from '../src/archway-event-url';
import { fetchWithPolicy } from './http-client';
import { noteSiteDownloads, paceRamapoRequest, RAMAPO_CONCURRENCY } from './site-guard';
import { validateArchwayEvents, type ArchwayEvent } from './schema';

export const ARCHWAY_FEED_INDEX_URL =
  'https://archway.ramapo.edu/ics_helper?modal=true&embed=1&mode=set';
const CAMPUS_TIME_ZONE = 'America/New_York';
/** The share of group files that may fail before the run stops instead of publishing a short list. */
export const MAX_FEED_FAILURE_SHARE = 0.2;

export function groupFeedUrl(groupId: string): string {
  return `https://archway.ramapo.edu/ical/ramapo/ical_club_${groupId}.ics`;
}

/** The group a calendar file belongs to, from its own address. */
export function feedGroupId(feedUrl: string): string | undefined {
  return /\/ical_club_(\d+)\.ics(?:$|\?)/.exec(feedUrl)?.[1];
}

export type FeedGroup = { groupId: string; name?: string };

/** Every group calendar file the Subscribe page names, with the group's name where the page gives it. */
export function parseFeedIndex(html: string): FeedGroup[] {
  const groups = new Map<string, FeedGroup>();
  for (const match of html.matchAll(/ical_club_(\d+)\.ics/g)) {
    const groupId = match[1];
    if (!groups.has(groupId)) groups.set(groupId, { groupId });
  }
  return [...groups.values()];
}

export type IcsProperty = { name: string; params: Record<string, string>; value: string };
export type IcsEvent = IcsProperty[];

function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

function parseIcsLine(line: string): IcsProperty | null {
  // NAME;PARAM=VALUE;PARAM="VALUE":value — a colon inside a quoted parameter is not the separator.
  let inQuotes = false;
  let split = -1;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) { split = index; break; }
  }
  if (split <= 0) return null;
  const [name, ...rawParams] = line.slice(0, split).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf('=');
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(split + 1) };
}

/** The VEVENT blocks of a calendar file, with folded lines joined. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events: IcsEvent[] = [];
  let current: IcsEvent | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = []; continue; }
    if (line === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const property = parseIcsLine(line);
    if (property) current.push(property);
  }
  return events;
}

function first(event: IcsEvent, name: string): IcsProperty | undefined {
  return event.find((property) => property.name === name);
}

type IcsInstant = { at: Date; allDay: boolean };

/** An ICS date-time: UTC ("...Z"), a wall clock in the campus zone (TZID or floating), or a whole day. */
export function parseIcsInstant(property: IcsProperty | undefined): IcsInstant | null {
  if (!property) return null;
  const value = property.value.trim();
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (day || property.params.VALUE === 'DATE') {
    const [, y, m, d] = day ?? /^(\d{4})(\d{2})(\d{2})/.exec(value) ?? [];
    if (!y) return null;
    return { at: zonedWallClock(Number(y), Number(m), Number(d), 0, 0), allDay: true };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(value);
  if (!match) return null;
  const [, y, m, d, hh, mm, , z] = match;
  if (z) return { at: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm))), allDay: false };
  // A TZID other than the campus zone is not something Archway writes; read it as campus time.
  return { at: zonedWallClock(Number(y), Number(m), Number(d), Number(hh), Number(mm)), allDay: false };
}

function zoneParts(at: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TIME_ZONE, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).formatToParts(at);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedWallClock(year: number, month: number, day: number, hour: number, minute: number): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let pass = 0; pass < 2; pass += 1) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: CAMPUS_TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(p.find((part) => part.type === type)?.value);
    const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    guess += desired - shown;
  }
  return new Date(guess);
}

/** "Fri, Oct 30, 2026", as the Archway listing wrote dates. */
export function campusDateLabel(at: Date): string {
  const p = zoneParts(at);
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year}`;
}

/** "11:15 AM" or "12 PM", as the Archway listing wrote times. */
export function campusTimeLabel(at: Date): string {
  const p = zoneParts(at);
  const hour24 = Number(p.hour) % 24;
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const period = hour24 < 12 ? 'AM' : 'PM';
  return p.minute === '00' ? `${hour} ${period}` : `${hour}:${p.minute} ${period}`;
}

/** Archway appends the college's street address to every room ("York Room, 505 Ramapo Valley Road, ..."). */
export function feedLocation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const place = unescapeIcsText(value)
    .replace(/,\s*505 Ramapo Valley Road\b.*$/i, '')
    // A map pin's coordinates after the room ("Mansion York Room, 41.081276,-74.175518").
    .replace(/,\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/, '')
    .replace(/\s+/g, ' ').trim();
  // Archway writes "undefined" for no place, and hides private and online places behind sign-in;
  // the event page's own Where line says which (withDetailPageFacts).
  if (!place || place === '-' || /^undefined$/i.test(place) || /^sign in to\b/i.test(place)) return undefined;
  return place;
}

function organizerName(property: IcsProperty | undefined): string | undefined {
  const name = property?.params.CN?.replace(/\s+/g, ' ').trim();
  return name || undefined;
}

/** The event's kinds: every CATEGORIES value except the group's acronym, which names the host, not the event. */
export function feedTags(event: IcsEvent): string[] {
  const tags: string[] = [];
  for (const property of event.filter((p) => p.name === 'CATEGORIES')) {
    const kind = (property.params['X-CG-CATEGORY'] ?? '').toLowerCase();
    if (kind === 'club_acronym') continue;
    for (const raw of property.value.split(/(?<!\\),/)) {
      const tag = unescapeIcsText(raw).replace(/^(?:event_type|topic_tags?)\s*:\s*/i, '').trim();
      if (tag && !/^club_acronym\s*:/i.test(tag) && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

/**
 * One calendar entry as the event the listing used to give. `organizerIdentity` names the group
 * whose own file holds the entry only when the entry's organizer is that group, so a co-host's file
 * never claims another group's event.
 */
export function feedEvent(
  entry: IcsEvent,
  feed: { groupId: string; url: string; groupName?: string },
  collectedAt: string
): ArchwayEvent | null {
  const title = first(entry, 'SUMMARY') ? unescapeIcsText(first(entry, 'SUMMARY')!.value).replace(/\s+/g, ' ').trim() : '';
  const start = parseIcsInstant(first(entry, 'DTSTART'));
  const url = canonicalArchwayEventUrl(first(entry, 'URL')?.value.trim());
  if (!title || !start || !url) return null;
  const end = parseIcsInstant(first(entry, 'DTEND'));
  const organizer = organizerName(first(entry, 'ORGANIZER'));
  const description = first(entry, 'DESCRIPTION')
    ? unescapeIcsText(first(entry, 'DESCRIPTION')!.value).replace(/\s+/g, ' ').trim()
    : '';
  const tags = feedTags(entry);
  const sameDay = end && campusDateLabel(end.at) === campusDateLabel(start.at);
  const ownGroup = organizer && (!feed.groupName || feed.groupName === organizer);
  return {
    title,
    date: campusDateLabel(start.at),
    time: start.allDay ? '12 AM' : campusTimeLabel(start.at),
    ...(end && !end.allDay && sameDay ? { endTime: campusTimeLabel(end.at) } : {}),
    ...(start.allDay ? { endTime: '11:59 PM' } : {}),
    ...(organizer ? { organizer } : {}),
    ...(ownGroup ? { organizerIdentity: { groupId: feed.groupId, sourceUrl: feed.url, collectedAt } } : {}),
    ...(feedLocation(first(entry, 'LOCATION')?.value) ? { location: feedLocation(first(entry, 'LOCATION')?.value) } : {}),
    ...(description ? { description } : {}),
    url,
    ...(tags.length ? { tags } : {}),
  };
}

/**
 * The upcoming events across group files, one per Archway event, soonest first. An event found in
 * two files keeps the copy whose file is its organizer's own; a copy from a co-host's file has no
 * organizer identity.
 */
export function mergeFeedEvents(
  feeds: Array<{ groupId: string; url: string; groupName?: string; text: string }>,
  collectedAt: string,
  now = new Date(collectedAt)
): ArchwayEvent[] {
  const byUrl = new Map<string, { event: ArchwayEvent; starts: number }>();
  for (const feed of feeds) {
    for (const entry of parseIcs(feed.text)) {
      const event = feedEvent(entry, feed, collectedAt);
      if (!event) continue;
      const starts = parseIcsInstant(first(entry, 'DTSTART'))!.at;
      const ends = parseIcsInstant(first(entry, 'DTEND'))?.at ?? starts;
      if (ends.getTime() < now.getTime()) continue;
      const kept = byUrl.get(event.url!);
      if (!kept || (!kept.event.organizerIdentity && event.organizerIdentity)) {
        byUrl.set(event.url!, { event, starts: starts.getTime() });
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => a.starts - b.starts || a.event.title.localeCompare(b.event.title))
    .map(({ event }) => event);
}

function isMondayOnCampus(now: Date): boolean {
  return zoneParts(now).weekday === 'Mon';
}

/** Which groups to read today: every group on a full day, otherwise the groups that had events last time. */
export function groupsToRead(
  index: FeedGroup[],
  previous: ArchwayEvent[] | null,
  now = new Date(),
  env: Readonly<Record<string, string | undefined>> = process.env
): { groups: FeedGroup[]; all: boolean } {
  const active = new Set((previous ?? []).map((event) => event.organizerIdentity?.groupId).filter(Boolean) as string[]);
  const all = env.ARCHWAY_FEEDS_ALL === '1' || active.size === 0 || isMondayOnCampus(now);
  if (all) {
    const known = new Map(index.map((group) => [group.groupId, group]));
    for (const groupId of active) if (!known.has(groupId)) known.set(groupId, { groupId });
    return { groups: [...known.values()], all: true };
  }
  const named = new Map(index.map((group) => [group.groupId, group]));
  return { groups: [...active].map((groupId) => named.get(groupId) ?? { groupId }), all: false };
}

/** Reads the Subscribe page, then each chosen group's calendar file, gently. */
export async function fetchCalendarFeedEvents(previous: ArchwayEvent[] | null): Promise<ArchwayEvent[]> {
  const collectedAt = new Date().toISOString();
  await paceRamapoRequest(ARCHWAY_FEED_INDEX_URL);
  const indexResponse = await fetchWithPolicy(ARCHWAY_FEED_INDEX_URL, {}, {
    expectedContentTypes: ['text/html', 'application/xhtml+xml'],
    perHostConcurrency: RAMAPO_CONCURRENCY,
  });
  if (!indexResponse.ok) throw new Error(`Archway's Subscribe page returned HTTP ${indexResponse.status}.`);
  const index = parseFeedIndex(indexResponse.text());
  if (index.length === 0) throw new Error("Archway's Subscribe page named no group calendar files.");
  const { groups, all } = groupsToRead(index, previous);

  const limit = pLimit(RAMAPO_CONCURRENCY);
  let failed = 0;
  const failures: string[] = [];
  const feeds = (await Promise.all(groups.map((group) => limit(async () => {
    const url = groupFeedUrl(group.groupId);
    try {
      await paceRamapoRequest(url);
      const response = await fetchWithPolicy(url, {}, {
        expectedContentTypes: ['text/calendar', 'text/plain', 'application/octet-stream'],
        perHostConcurrency: RAMAPO_CONCURRENCY,
      });
      const text = response.ok ? response.text() : '';
      if (!text.includes('BEGIN:VCALENDAR')) {
        failed += 1;
        failures.push(`${group.groupId} (HTTP ${response.status}, ${response.headers.get('content-type') ?? 'no type'})`);
        return null;
      }
      return { ...group, url, text };
    } catch (error) {
      failed += 1;
      failures.push(`${group.groupId} (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  })))).filter((feed): feed is NonNullable<typeof feed> => Boolean(feed));

  noteSiteDownloads(`Archway calendar files: ${groups.length} read (${all ? 'every group' : 'groups with events'}), ` +
    `${failed} failed${failures.length ? `: ${failures.join('; ')}` : ''}, plus the Subscribe page`);
  if (groups.length && failed / groups.length > MAX_FEED_FAILURE_SHARE) {
    throw new Error(`${failed} of ${groups.length} Archway calendar files could not be read.`);
  }
  // Names come from the files themselves: a file's own events name its group as organizer.
  const named = feeds.map((feed) => ({ ...feed, groupName: feed.name ?? ownerName(feed.text) }));
  const events = mergeFeedEvents(named, collectedAt);
  return validateArchwayEvents(events);
}

/** The group a file belongs to: the organizer named on most of its entries. */
export function ownerName(text: string): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of parseIcs(text)) {
    const name = organizerName(first(entry, 'ORGANIZER'));
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
