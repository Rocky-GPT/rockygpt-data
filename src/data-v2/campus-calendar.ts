import type { CampusIdentity } from './campus-identities';
import { calendarWithConcepts } from './calendar-concepts';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';

/**
 * @module data-v2/campus-calendar
 * The academic calendar as graph nodes: each term ("Fall 2026") and each dated entry on it
 * ("Reading Day (No Classes)" on Dec 8, 2026), joined by `in_term`.
 *
 * Ramapo's calendar pages list a term's dates under its name; a few dates are listed under two
 * terms (Winter 2027 repeats the fall's last week). A date is one node however many terms list
 * it, with one `in_term` link to each term that lists it, read from that term's page.
 */

export const CALENDAR_SOURCE_KEY = 'academic-calendar';
const CURRENT_CALENDAR_URL = 'https://www.ramapo.edu/academic-calendars/';
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

interface CalendarSemester { name: string; sourceUrl?: string; events: Array<{ date: string; title: string; description?: string }> }

const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const campusDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const longDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });

export function termIdentityId(termId: string): string {
  return uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'term', CALENDAR_SOURCE_KEY, termId]));
}

export function calendarDateIdentityId(recordKey: string): string {
  return uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'calendar_date', CALENDAR_SOURCE_KEY, recordKey]));
}

export interface CalendarGraph {
  entities: CampusIdentity[];
  terms: GraphRecordCollectionData;
  dates: GraphRecordCollectionData;
  unresolved: IdentityCoverageIssue[];
}

/** Term and calendar-date identities and their records, from the release's calendar artifact. */
export function compileCalendarIdentities(calendar: unknown, collectedAt = ''): CalendarGraph {
  const semesters = (Array.isArray(calendar) ? calendar : [])
    .filter((term): term is CalendarSemester => Boolean(term) && typeof term === 'object'
      && typeof (term as CalendarSemester).name === 'string' && Array.isArray((term as CalendarSemester).events));
  const unresolved: IdentityCoverageIssue[] = [];
  const termRows: GraphRecordRow[] = [];
  const dateRows = new Map<string, GraphRecordRow & { terms: string[] }>();
  const termOf = new Map<string, { id: string; name: string; url: string }>();
  const listedIn = new Map<string, string[]>();
  for (const semester of calendarWithConcepts(semesters)) {
    const name = text(semester.name);
    const sourceUrl = text(semester.sourceUrl) || CURRENT_CALENDAR_URL;
    const termKey = semester.events[0]?.termId;
    const [, season, year] = /^(Winter|Spring|Summer|Fall)\s+(20\d{2})$/i.exec(name) ?? [];
    if (!termKey || !season) {
      unresolved.push({ collection: 'terms', record: name, reason: 'The calendar section is not named like "Fall 2026"; no term identity is made.', kind: 'note' });
      continue;
    }
    termOf.set(termKey, { id: termIdentityId(termKey), name, url: sourceUrl });
    termRows.push({ source_record_key: termKey, name, season: season.toLowerCase(), year: Number(year), source_url: sourceUrl });
    for (const event of semester.events) {
      const title = text(event.title);
      if (!event.startsAt) {
        unresolved.push({ collection: 'calendar_dates', record: `${name}: ${event.date} ${title}`, reason: 'The listed date could not be read as a calendar day; no date identity is made.', kind: 'unlinked_record' });
        continue;
      }
      const instant = new Date(event.startsAt);
      const day = campusDate.format(instant);
      const key = `${day}:${title}`;
      const row = dateRows.get(key) ?? {
        source_record_key: key, date: day, starts_at: event.startsAt, title, date_label: text(event.date),
        time: text(event.description) || null, family: event.family, kind: event.kind,
        session: event.session ?? null, session_id: event.sessionId ?? null,
        source_url: sourceUrl, terms: [],
      };
      if (!row.terms.includes(name)) row.terms.push(name);
      dateRows.set(key, row);
      listedIn.set(key, [...new Set([...listedIn.get(key) ?? [], termKey])]);
    }
  }
  const entities: CampusIdentity[] = [];
  for (const row of termRows) {
    entities.push({ id: termIdentityId(row.source_record_key), kind: 'term', name: String(row.name), aliases: [],
      links: [{ collection: 'terms', source_key: CALENDAR_SOURCE_KEY, source_record_keys: [row.source_record_key] }] });
  }
  for (const [key, row] of dateRows) {
    entities.push({
      id: calendarDateIdentityId(key), kind: 'calendar_date',
      name: `${row.title} (${longDate.format(new Date(String(row.starts_at)))})`.slice(0, 240), aliases: [],
      links: [{ collection: 'calendar_dates', source_key: CALENDAR_SOURCE_KEY, source_record_keys: [key] }],
      relationships: (listedIn.get(key) ?? []).map(termKey => ({
        type: 'in_term' as const, target_entity_id: termOf.get(termKey)!.id,
        evidence: [{ collection: 'calendar_dates' as const, source_key: CALENDAR_SOURCE_KEY, source_record_key: key, field: 'term', source_url: termOf.get(termKey)!.url }],
      })),
    });
  }
  return {
    entities,
    terms: { source_key: CALENDAR_SOURCE_KEY, collected_at: collectedAt, rows: termRows },
    dates: { source_key: CALENDAR_SOURCE_KEY, collected_at: collectedAt, rows: [...dateRows.values()] },
    unresolved,
  };
}
