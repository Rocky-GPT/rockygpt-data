import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { buildingIdentityId, campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import { placeName } from './campus-map-places';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';
import { noteAlias, type AliasLedger } from './identity-aliases';
import { SOURCES } from './source-seeds';

/**
 * @module data-v2/graph-links
 * Links read from records the release already holds:
 *
 * - `handled_by`: a topic (Scholarships, Summer Session) to each office its reviewed row names in
 *   `handled_by`, by exact name. A student group with its own desk (Student Media's Yearbook,
 *   Ramapo News) is still an Archway club or organization when topics are linked, so it counts.
 * - `listed_by` for the nodes that only another office's page knows: a desk whose every schedule is
 *   on one office's own page (the Library's hours page lists the Game Lab), a person the directory
 *   files under one office (the President, under the Office of the President), each shuttle route
 *   under the office whose page publishes its timetable, and the reviewed listings of one office's
 *   page naming another office (reviewed-listings.json), while the page still says so.
 * - Shuttle stops as `stop` nodes: a route `stops_at` each stop its timetable page describes, and a
 *   campus stop ("Ramapo College (Bradley Center)") is `located_at` the building it names.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export const stopIdentityId = (name: string): string => uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'stop', 'transportation', name]));

/** Kinds a topic's reviewed row may name: offices, venues, and the student groups with desks. */
const TOPIC_HANDLERS: string[] = ['office', 'venue', 'club', 'organization'];

/** handled_by from each topic's own row to the offices it names. */
export function linkTopicOffices(entities: CampusIdentity[], topics: Row[]): void {
  const offices = new Map<string, CampusIdentity[]>();
  for (const office of entities.filter(e => TOPIC_HANDLERS.includes(e.kind))) offices.set(office.name, [...offices.get(office.name) ?? [], office]);
  const rows = new Map(topics.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  for (const topic of entities.filter(e => e.kind === 'topic')) {
    for (const link of topic.links.filter(l => l.collection === 'campus_topics')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`${link.source_key}:${key}`);
        const url = text(row?.url);
        for (const name of Array.isArray(row?.handled_by) ? row.handled_by.map(text) : []) {
          const found = offices.get(name) ?? [];
          if (found.length !== 1) continue;
          topic.relationships ||= [];
          if (topic.relationships.some(r => r.type === 'handled_by' && 'target_entity_id' in r && r.target_entity_id === found[0].id)) continue;
          topic.relationships.push({ type: 'handled_by', target_entity_id: found[0].id, evidence: [{ collection: 'campus_topics', source_key: link.source_key, source_record_key: key, field: 'handled_by', ...(/^https:\/\//.test(url) ? { source_url: url } : {}) }] });
        }
      }
    }
  }
}

/** Stop nodes and their records; routes stop at them, and a campus stop is in the building it names. */
export function compileStops(entities: CampusIdentity[], stops: Row[], artifact: CampusBuildingsArtifact, map: unknown, collectedAt = '', ledger: AliasLedger = new Map()): { entities: CampusIdentity[]; records: GraphRecordCollectionData } {
  const page = SOURCES.find(source => source.key === 'transportation')?.url ?? 'https://www.ramapo.edu/about/transportation-services/';
  const rows = new Map(stops.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  const buildings = new Map<string, string[]>();
  const addBuilding = (name: string, id: string) => { const key = placeName(name); if (key) buildings.set(key, [...new Set([...buildings.get(key) ?? [], id])]); };
  for (const b of artifact.buildings) addBuilding(b.name, campusBuildingId(b));
  for (const c of artifact.complexes ?? []) addBuilding(c.name, buildingIdentityId(c.concept3d_id));
  for (const e of entities.filter(e => e.kind === 'building')) for (const alias of e.aliases) addBuilding(alias, e.id);
  // The map's own search names for a building ("bradley center" for the Bill Bradley Center).
  const byKey = new Map(artifact.buildings.map(b => [b.map_key, campusBuildingId(b)]));
  for (const row of Array.isArray((map as Row)?.buildings) ? (map as Row).buildings as Row[] : []) {
    const id = byKey.get(text(row.key));
    if (id) for (const alias of Array.isArray(row.aliases) ? row.aliases : []) addBuilding(text(alias), id);
  }
  const nodes = new Map<string, CampusIdentity>();
  const records = new Map<string, GraphRecordRow>();
  for (const route of entities.filter(e => e.kind === 'route')) {
    for (const link of route.links.filter(l => l.collection === 'shuttle_stops')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`${link.source_key}:${key}`);
        const name = text(row?.name);
        if (!row || !name) continue;
        const stop = nodes.get(name) ?? { id: stopIdentityId(name), kind: 'stop', name, aliases: text(row.label) && text(row.label) !== name ? [text(row.label)] : [],
          links: [{ collection: 'stops', source_key: 'transportation', source_record_keys: [name] }] };
        // The stop's label on the timetable page ("CityMD Ramsey Urgent Care") is its other name.
        if (!nodes.has(name)) for (const alias of stop.aliases) noteAlias(ledger, stop.id, alias, { basis: 'record_name',
          evidence: { collection: 'shuttle_stops', source_key: link.source_key, source_record_key: key, field: 'label', source_url: page } });
        nodes.set(name, stop);
        if (!records.has(name)) records.set(name, { source_record_key: name, name, label: text(row.label) || null, pickup: text(row.pickup) || null, description: text(row.description) || null, source_url: page });
        route.relationships ||= [];
        const held = route.relationships.find(r => r.type === 'stops_at' && 'target_entity_id' in r && r.target_entity_id === stop.id);
        const evidence = { collection: 'shuttle_stops' as const, source_key: link.source_key, source_record_key: key, field: 'name', source_url: page };
        if (held) { if (held.evidence.length < 32) held.evidence.push(evidence); }
        else route.relationships.push({ type: 'stops_at', target_entity_id: stop.id, evidence: [evidence] });
        // "Ramapo College (Bradley Center)": the part in parentheses names the building.
        const named = /\(([^)]+)\)\s*$/.exec(name)?.[1];
        const found = named ? buildings.get(placeName(named)) ?? [] : [];
        if (found.length === 1 && !(stop.relationships ?? []).length) {
          stop.relationships = [{ type: 'located_at', target_entity_id: found[0], evidence: [{ collection: 'stops', source_key: 'transportation', source_record_key: name, field: 'name', source_url: page }] }];
        }
      }
    }
  }
  return { entities: [...nodes.values()], records: { source_key: 'transportation', collected_at: collectedAt, rows: [...records.values()] } };
}

/** A page's record key, the way office sections name pages ("www.ramapo.edu/library/library-hours/"). */
const pageKeyOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
const OWNER_KINDS = ['office', 'venue', 'facility', 'organization', 'club'];

/** Every captured page and the nodes that link it as their own. */
function pageOwners(entities: CampusIdentity[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const entity of entities.filter(e => OWNER_KINDS.includes(e.kind))) {
    for (const link of entity.links.filter(l => l.collection === 'office_sections')) {
      for (const key of link.source_record_keys) owners.set(key, new Set([...owners.get(key) ?? [], entity.id]));
    }
  }
  return owners;
}

function listedBy(entity: CampusIdentity, target: string, evidence: IdentityEvidence): boolean {
  entity.relationships ||= [];
  if (entity.id === target || entity.relationships.some(r => r.type === 'listed_by' && 'target_entity_id' in r && r.target_entity_id === target)) return false;
  entity.relationships.push({ type: 'listed_by', target_entity_id: target, evidence: [evidence] });
  return true;
}

/**
 * A desk the graph knows only by its schedules (the Game Lab, the Research Help Desk) is listed_by
 * the one office whose own page publishes all of them (the Library's hours page). A desk with a
 * contact, a map place or pages of its own is left alone, and a page no office or two offices
 * claim lists nothing.
 */
export function linkHoursDesks(entities: CampusIdentity[], hours: Row[]): number {
  const owners = pageOwners(entities);
  const rows = new Map(hours.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  let linked = 0;
  for (const desk of entities.filter(e => ['office', 'venue', 'facility'].includes(e.kind) && e.links.length && e.links.every(l => l.collection === 'campus_hours'))) {
    const found = desk.links.flatMap(link => link.source_record_keys.map(key => ({ link, key, row: rows.get(`${link.source_key}:${key}`) })));
    const urls = new Set(found.map(item => text(item.row?.source_url)));
    const [url] = urls;
    if (urls.size !== 1 || !/^https:\/\//.test(url) || found.some(item => !item.row)) continue;
    const office = [...owners.get(pageKeyOf(url)) ?? []].filter(id => id !== desk.id);
    if (office.length !== 1) continue;
    const { link, key } = found[0];
    if (listedBy(desk, office[0], { collection: 'campus_hours', source_key: link.source_key, source_record_key: key, field: 'source_url', source_url: url })) linked++;
  }
  return linked;
}

/**
 * A person the campus directory files under an office ("other" contacts: the President, the Vice
 * Provost, the President's special assistant) is listed_by the one office named exactly like the
 * contact's department (an office, or the Archway group that is that office). Faculty rows are left
 * alone: their school links them already.
 */
export function linkDirectoryPeople(entities: CampusIdentity[], contacts: Row[]): number {
  const offices = new Map<string, string[]>();
  // OWNER_KINDS: an office with an Archway group (the Office of the President) is still that group's
  // organization when people link; Brain shows it as an office.
  for (const office of entities.filter(e => OWNER_KINDS.includes(e.kind))) offices.set(office.name, [...offices.get(office.name) ?? [], office.id]);
  const rows = new Map(contacts.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  let linked = 0;
  for (const person of entities.filter(e => e.kind === 'person')) {
    for (const link of person.links.filter(l => l.collection === 'contacts')) {
      for (const key of link.source_record_keys.filter(k => k.startsWith('other:'))) {
        const row = rows.get(`${link.source_key}:${key}`);
        const found = offices.get(text(row?.department)) ?? [];
        if (!row || found.length !== 1) continue;
        const meta = row.normalization_metadata as { evidence?: { source_urls?: unknown } } | undefined;
        const urls = Array.isArray(meta?.evidence?.source_urls) ? meta.evidence.source_urls.map(text).filter(u => /^https:\/\//.test(u)) : [];
        if (listedBy(person, found[0], { collection: 'contacts', source_key: link.source_key, source_record_key: key, field: 'department', ...(urls[0] ? { source_url: urls[0] } : {}) })) linked++;
      }
    }
  }
  return linked;
}

/** Each shuttle route is listed_by the one office whose own pages include the timetable page it is read from. */
export function linkRouteOffice(entities: CampusIdentity[]): number {
  const page = SOURCES.find(source => source.key === 'transportation')?.url;
  const office = page ? [...pageOwners(entities).get(pageKeyOf(page)) ?? []] : [];
  if (!page || office.length !== 1) return 0;
  let linked = 0;
  for (const route of entities.filter(e => e.kind === 'route')) {
    const link = route.links.find(l => l.collection === 'shuttle_trips' && l.source_record_keys.length);
    if (link && listedBy(route, office[0], { collection: 'shuttle_trips', source_key: link.source_key, source_record_key: link.source_record_keys[0], field: 'route_name', source_url: page })) linked++;
  }
  return linked;
}

/** One office's page naming another office as part of it, reviewed with the words that say so. */
export interface ReviewedListing { node: string; listed_by: string; url: string; section: string; quote: string; reviewed_at: string; note: string }
export interface ReviewedListings { schema_version: 1; listings: ReviewedListing[] }

const words = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * listed_by for each reviewed listing whose page section is in this run's capture and still holds
 * the quoted words; the node and the office must each be the only node with its name. A listing
 * the page no longer backs is reported, never published from the older reading.
 */
export function linkReviewedListings(entities: CampusIdentity[], pages: Row[], reviewed: ReviewedListings): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const named = new Map<string, CampusIdentity[]>();
  for (const entity of entities) named.set(entity.name, [...named.get(entity.name) ?? [], entity]);
  const byKey = new Map(pages.map(page => [text(page.source_record_key), page]));
  const unresolved: IdentityCoverageIssue[] = [];
  let linked = 0;
  for (const listing of reviewed.listings) {
    const key = pageKeyOf(listing.url);
    const issue = (reason: string) => unresolved.push({ entity: listing.node, collection: 'office_sections', record: key, reason, kind: 'missing_connection' });
    const node = named.get(listing.node) ?? []; const office = named.get(listing.listed_by) ?? [];
    if (node.length !== 1 || office.length !== 1) { issue(`The reviewed listing names ${listing.node} and ${listing.listed_by}; each must be exactly one node. Nothing is linked.`); continue; }
    const page = byKey.get(key);
    const sections = Array.isArray(page?.sections) ? page.sections as Row[] : [];
    const said = sections.filter(section => text(section.heading) === listing.section).some(section => words(text(section.text)).includes(words(listing.quote)));
    if (!said) { issue(`The section "${listing.section}" of ${listing.url} is not in this capture or no longer says what was reviewed; the listing is withheld.`); continue; }
    if (listedBy(node[0], office[0].id, { collection: 'office_sections', source_key: text(page?.source_key) || 'office-pages', source_record_key: key, field: 'sections', source_url: listing.url })) linked++;
  }
  return { linked, unresolved };
}

/** A node reviewed to stay alone, with the reason a reader is shown (standalone-nodes.json). */
export interface ReviewedStandalone { kind: string; name: string; reason: string; reviewed_at: string; note: string }
export interface ReviewedStandaloneNodes { schema_version: 1; nodes: ReviewedStandalone[] }

const UNLINKED_REASONS: Record<string, string> = {
  building: 'The campus map lists it, but no captured page puts an office, event, parking lot or shuttle stop in or near it.',
  office: 'No room or building is published for it, and no captured page of another office lists it.',
  person: 'The directory files this person under no office or school that is in the graph.',
};

/**
 * Notes on every node with no link in or out, run once every link is made: why it is alone, and
 * whether it should stay so (a retired topic; a reviewed standalone node). A node that is reached
 * by nothing is otherwise unreachable from the graph's root, so readers list these through the note.
 */
export function markUnlinked(entities: CampusIdentity[], topics: Row[], reviewed: ReviewedStandaloneNodes): { total: number; on_purpose: number } {
  const courseOf = new Map<string, string>();
  for (const entity of entities) for (const link of entity.links) for (const key of link.source_record_keys) courseOf.set(`${link.collection}:${link.source_key}:${key}`, entity.id);
  const linked = new Set<string>();
  for (const entity of entities) {
    for (const relation of entity.relationships ?? []) {
      const target = 'target_entity_id' in relation ? relation.target_entity_id
        : courseOf.get(`${relation.target_record.collection}:${relation.target_record.source_key}:${relation.target_record.source_record_key}`);
      if (!target) continue;
      linked.add(entity.id); linked.add(target);
    }
  }
  const standalone = new Map(reviewed.nodes.map(node => [`${node.kind}:${node.name}`, node.reason]));
  const retired = new Map(topics.filter(row => text(row.status) === 'retired').map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  const count = { total: 0, on_purpose: 0 };
  for (const entity of entities) {
    delete entity.unlinked;
    if (linked.has(entity.id)) continue;
    const reviewedReason = standalone.get(`${entity.kind}:${entity.name}`);
    const ended = entity.kind === 'topic' && entity.links.some(link => link.collection === 'campus_topics'
      && link.source_record_keys.some(key => retired.has(`${link.source_key}:${key}`)));
    if (reviewedReason) entity.unlinked = { reason: reviewedReason, on_purpose: true };
    else if (ended) entity.unlinked = { reason: 'Its own page says it ended or left the college and sends people elsewhere, so no campus office handles it now.', on_purpose: true };
    else entity.unlinked = { reason: UNLINKED_REASONS[['venue', 'facility', 'organization', 'club'].includes(entity.kind) ? 'office' : entity.kind] ?? `No captured page connects this ${entity.kind.replace(/_/g, ' ')} to another node.`, on_purpose: false };
    count.total++;
    if (entity.unlinked.on_purpose) count.on_purpose++;
  }
  return count;
}
