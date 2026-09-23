import { createHash } from 'node:crypto';
import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue, IdentitySnapshot } from './compile-campus-identities';
import reviewedCaptures from '../reference/archway-event-identity-captures.json';

type Row = Record<string, unknown>;
export interface ArchwayIdentityInputs { clubs?: unknown; eventDetails?: unknown }
export interface EventOrganizerEvidence {
  source_key: string; source_record_key: string; source_record_id: string;
  event_url: string; organizer_group_id: string; organizer_url: string;
  organizer_name: string; collected_at: string; source_url: string;
}
export interface EventOrganizersArtifact { schema_version: 1; events: EventOrganizerEvidence[] }
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') as Row[] : [];
const groupCategories = new Set(['Student Organization', 'Honor Society', 'Greek Life', 'Office Sponsored Organization']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const numericId = (v: unknown): string => /^\d+$/.test(text(v)) ? text(v) : '';
/** The resolver's exact-name comparison: collapse whitespace, ignore case. */
export const normalizeName = (v: string): string => v.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/** Fixed namespace plus the publisher's immutable external ID, never a name,
 * date, generated database UUID, email or phone. Do not change this namespace.
 * Every Archway group, student club or not, derives its ID with kind 'club', so a
 * group Archway recategorizes keeps its ID; the string is a persistence label. */
export function archwayIdentityId(kind: 'club' | 'event', sourceId: string): string {
  const namespace = Buffer.from('274b5890c7d249c3aefddc216ea0cd85', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`archway:${kind}:${sourceId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function canonicalClubUrl(value: unknown): string {
  try { const url = new URL(text(value)); if (!['https:', 'http:'].includes(url.protocol)) return ''; url.hash = ''; return url.toString().replace(/\/+$/, ''); } catch { return ''; }
}
export function archwayEventId(value: unknown): string {
  try {
    const url = new URL(text(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'archway.ramapo.edu' || !/\/(?:rsvp_boot|rsvp)\/?$/.test(url.pathname)) return '';
    return numericId(url.searchParams.get('id'));
  } catch { return ''; }
}
function campusDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(text(value));
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function uniqueBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) { const id = key(value); if (id) map.set(id, [...(map.get(id) || []), value]); }
  return map;
}
function clubSources(snapshot: IdentitySnapshot, inputs: ArchwayIdentityInputs): Row[] {
  // Current published IDs win over an older optional raw capture, but a
  // disagreement at the same exact website remains ambiguous, not precedence.
  const all = [...rows(snapshot.artifacts.clubs), ...rows(inputs.clubs)].filter(r => numericId(r.clubId));
  return [...new Map(all.map(r => [JSON.stringify([r.clubId, canonicalClubUrl(r.websiteUrl), r.name]), r])).values()];
}

/** Extract only an explicit Archway event page's by-line + unique group filter
 * + linked group page. Navigation names, venue text, descriptions and shared
 * telephone numbers never establish relationships. Preserve per-page time. */
export function eventOrganizersArtifact(snapshot: IdentitySnapshot, inputs: ArchwayIdentityInputs = {}): EventOrganizersArtifact {
  const groups = uniqueBy(clubSources(snapshot, inputs), r => numericId(r.clubId));
  const pages: Row[] = [...rows((inputs.eventDetails as Row)?.pages), ...reviewedCaptures.pages];
  const events: EventOrganizerEvidence[] = [];
  // The official listing identifies the primary organizer by immutable clubId.
  // Normalization preserves that assertion in the release's events artifact;
  // the club directory supplies its independently published website, never a
  // name-based join. Details can corroborate or conflict with this assertion.
  for (const listing of rows(snapshot.artifacts.events)) {
    const identity = listing.organizerIdentity as Row | undefined;
    if (!identity || identity.sourceUrl !== 'https://archway.ramapo.edu/home/events/') continue;
    const eventId = archwayEventId(listing.url); const groupId = numericId(identity.groupId);
    const collectedAt = text(identity.collectedAt); const name = text(listing.organizer);
    const matches = groups.get(groupId) || [];
    const names = new Set(matches.map(r => text(r.name))); const urls = new Set(matches.map(r => canonicalClubUrl(r.websiteUrl)));
    if (!eventId || !collectedAt || Number.isNaN(Date.parse(collectedAt)) || !name || names.size !== 1 || !names.has(name) || urls.size !== 1) continue;
    const url = [...urls][0];
    if (!url) continue;
    const website = new URL(url);
    if (website.hostname !== 'archway.ramapo.edu' || (text(identity.groupLogin) && website.pathname.replace(/^\/|\/$/g, '') !== text(identity.groupLogin))) continue;
    for (const row of snapshot.events || []) {
      if (archwayEventId(row.event_url) !== eventId || !UUID.test(text(row.id))) continue;
      events.push({ source_key: text(row.source_key), source_record_key: text(row.source_record_key), source_record_id: text(row.id), event_url: text(row.event_url), organizer_group_id: groupId, organizer_url: url, organizer_name: name, collected_at: collectedAt, source_url: text(identity.sourceUrl) });
    }
  }
  for (const page of pages) {
    const eventId = archwayEventId(page.url);
    const collectedAt = text(page.fetchedAt);
    if (!eventId || page.statusCode !== 200 || !collectedAt || Number.isNaN(Date.parse(collectedAt))) continue;
    const links = Array.isArray(page.links) ? page.links.filter((v): v is string => typeof v === 'string') : [];
    if (page.archwayOrganizers !== undefined) {
      // New captures associate these values within the actual Hosted By block.
      // Resolve by publisher ID, then verify exact URL/name consistency. An
      // empty or invalid scoped capture must never use the legacy fallback.
      for (const organizer of rows(page.archwayOrganizers)) {
        const groupId = numericId(organizer.groupId);
        const matches = groups.get(groupId) || [];
        const name = text(organizer.name); const url = canonicalClubUrl(organizer.groupUrl);
        const names = new Set(matches.map(r => text(r.name)));
        const urls = new Set(matches.map(r => canonicalClubUrl(r.websiteUrl)));
        if (!groupId || !name || !url || names.size !== 1 || urls.size !== 1 || !names.has(name) || !urls.has(url)) continue;
        for (const row of snapshot.events || []) {
          if (archwayEventId(row.event_url) !== eventId || !UUID.test(text(row.id))) continue;
          events.push({ source_key: text(row.source_key), source_record_key: text(row.source_record_key), source_record_id: text(row.id), event_url: text(row.event_url), organizer_group_id: groupId, organizer_url: url, organizer_name: name, collected_at: collectedAt, source_url: text(page.url) });
        }
      }
      continue;
    }
    const ids = new Set(links.flatMap(link => {
      try { const url = new URL(link); const id = numericId(url.searchParams.get('group_ids')); return url.hostname === 'archway.ramapo.edu' && url.pathname === '/events' && id ? [id] : []; } catch { return []; }
    }));
    if (ids.size !== 1) continue;
    const groupId = [...ids][0]; const matches = groups.get(groupId) || [];
    // Duplicate raw versions of the same group are harmless only when their
    // exact subject name and URL agree; no arbitrary last-row choice.
    const names = new Set(matches.map(r => text(r.name))); const urls = new Set(matches.map(r => canonicalClubUrl(r.websiteUrl)));
    if (names.size !== 1 || urls.size !== 1 || ![...urls][0]) continue;
    const name = [...names][0]; const url = [...urls][0];
    const byline = rows(page.sections).some(section => text(section.text) === `by ${name}` || text(section.text).startsWith(`by ${name} `));
    if (!byline || !links.some(link => canonicalClubUrl(link) === url)) continue;
    for (const row of snapshot.events || []) {
      if (archwayEventId(row.event_url) !== eventId || !UUID.test(text(row.id))) continue;
      events.push({ source_key: text(row.source_key), source_record_key: text(row.source_record_key), source_record_id: text(row.id), event_url: text(row.event_url), organizer_group_id: groupId, organizer_url: url, organizer_name: name, collected_at: collectedAt, source_url: text(page.url) });
    }
  }
  return { schema_version: 1, events: [...new Map(events.map(e => [JSON.stringify(e), e])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

/** `reserved` holds normalized names and aliases of reviewed identities, and the
 * departments their own contact records publish. A non-club group with one of
 * those names is most likely the same office, so it needs a reviewed link
 * instead of a second identity that would make that name ambiguous. */
export function compileArchwayIdentities(snapshot: IdentitySnapshot, inputs: ArchwayIdentityInputs = {}, reserved: ReadonlySet<string> = new Set(), owned: ReadonlySet<string> = new Set()): { entities: CampusIdentity[]; unresolved: IdentityCoverageIssue[]; organizers: EventOrganizersArtifact } {
  const entities: CampusIdentity[] = []; const unresolved: IdentityCoverageIssue[] = [];
  const sources = clubSources(snapshot, inputs);
  const sourcesByUrl = uniqueBy(sources, r => canonicalClubUrl(r.websiteUrl));
  const publishedByUrl = uniqueBy(snapshot.clubs || [], r => canonicalClubUrl(r.website_url));
  const approved: { row: Row; groupId: string; kind: 'club' | 'organization' }[] = [];
  for (const row of snapshot.clubs || []) {
    // A group a reviewed identity links explicitly (a school's Archway page) is not a second identity.
    if (owned.has(text(row.source_record_key))) continue;
    const issue = (reason: string) => unresolved.push({ entity: text(row.name), collection: 'clubs', record: text(row.source_record_key), reason });
    // Student groups are clubs; departments, residence halls, teams, schools and
    // seminars are other campus organizations. The published category decides.
    const kind = groupCategories.has(text(row.category).split(' - ')[0]) ? 'club' : 'organization';
    if (kind === 'organization' && reserved.has(normalizeName(text(row.name)))) { issue('An Archway group named like a reviewed campus identity or its published department needs a reviewed link; no duplicate identity is created. Existing search remains available.'); continue; }
    const url = canonicalClubUrl(row.website_url);
    const matches = url ? sourcesByUrl.get(url) || [] : [];
    const ids = new Set(matches.map(r => numericId(r.clubId)).filter(Boolean));
    if (!url || (publishedByUrl.get(url)?.length || 0) !== 1 || ids.size !== 1 || !UUID.test(text(row.id))) { issue('No unique explicit Archway group ID can be attached through the original published website URL; a matching name alone is insufficient.'); continue; }
    approved.push({ row, groupId: [...ids][0], kind });
  }
  const byGroup = uniqueBy(approved, item => item.groupId);
  const groupEntities = new Map<string, CampusIdentity>();
  for (const { row, groupId, kind } of approved) {
    if (byGroup.get(groupId)?.length !== 1) { unresolved.push({ entity: text(row.name), collection: 'clubs', record: text(row.source_record_key), reason: 'Several original club records claim the same external group ID; identity is ambiguous.' }); continue; }
    const entity: CampusIdentity = { id: archwayIdentityId('club', groupId), kind, name: text(row.name).slice(0, 240), aliases: [], links: [{ collection: 'clubs', source_key: text(row.source_key), source_record_keys: [text(row.source_record_key)], source_record_ids: [text(row.id)] }] };
    entities.push(entity); groupEntities.set(groupId, entity);
  }
  const eventRows = snapshot.events || []; const byEventId = uniqueBy(eventRows, row => archwayEventId(row.event_url));
  const organizers = eventOrganizersArtifact(snapshot, inputs);
  for (const row of eventRows) {
    const eventId = archwayEventId(row.event_url); const date = campusDate(row.starts_at);
    const issue = (reason: string) => unresolved.push({ entity: text(row.title), collection: 'events', record: text(row.source_record_key), reason });
    if (!eventId || byEventId.get(eventId)?.length !== 1 || !UUID.test(text(row.id))) { issue('Missing or nonunique explicit Archway event occurrence ID; title similarity and date alone cannot establish a stable identity.'); continue; }
    const title = text(row.title);
    const entity: CampusIdentity = { id: archwayIdentityId('event', eventId), kind: 'event', name: `${title.slice(0, 215)} (${date || 'date not published'})`, aliases: title.length <= 240 ? [title] : [], links: [{ collection: 'events', source_key: text(row.source_key), source_record_keys: [text(row.source_record_key)], source_record_ids: [text(row.id)] }] };
    if (!date) issue('Event occurrence identity is explicit but its date is not published; the profile must keep the date unknown.');
    const assertions = organizers.events.filter(e => e.source_record_id === row.id);
    const groupIds = new Set(assertions.map(e => e.organizer_group_id));
    if (groupIds.size !== 1) issue(assertions.length ? 'Explicit captured organizer assertions conflict; no organizer identity relationship is approved.' : 'No captured explicit organizer group ID and linked group page; organizer and location names remain source text, not identity links.');
    else {
      const assertion = assertions[0]; const target = groupEntities.get(assertion.organizer_group_id);
      if (!target) issue('Explicit organizer group ID has no Archway group identity; directory groups are never merged with offices by name.');
      else if (text(row.organizer) !== assertion.organizer_name || assertions.some(a => a.organizer_name !== assertion.organizer_name || a.organizer_url !== assertion.organizer_url)) issue('Current event organizer text conflicts with the captured explicitly identified organizer; both source assertions are retained without choosing authority.');
      else entity.relationships = [{ type: 'organized_by', target_entity_id: target.id, evidence: [{ collection: 'events', source_key: text(row.source_key), source_record_key: text(row.source_record_key), source_record_id: text(row.id), field: 'organizer_group_id', source_url: assertion.source_url }] }];
    }
    entities.push(entity);
  }
  entities.sort((a, b) => a.id.localeCompare(b.id));
  return { entities, unresolved, organizers };
}
