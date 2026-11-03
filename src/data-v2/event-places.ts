import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import { buildingIdentityId, campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import { placeName } from './campus-map-places';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { canonicalArchwayEventUrl } from '../archway-event-url';
import eventPlaceReadings from '../reference/event-places.json';

/**
 * @module data-v2/event-places
 * Where each event is held: `held_at` the place or building its Archway listing's location names.
 *
 * A location names a building by a room with a reviewed prefix ("BC 125", "E-216", "SC219"), or
 * names a place or building outright ("York Room", "Thomases Commons", "The Lodge"), compared the
 * way map places are (campus-map-places.ts). A named place wins over the building its room is in,
 * since the place is already located_at that building. A name two places share links neither.
 * "Online Event", "-" and private locations name nothing.
 *
 * Words that only say where inside a building are set aside when what is left is that one
 * building's name: a floor ("2nd Floor Student Center Lobby", "Laurel Hall 1st Floor Movie
 * Theatre"), a lounge or lobby ("Thomases Commons Lounge", "The Lodge Main Lobby") and a room
 * number ("Trustees Pavilion 1-3"). A name no node carries ("Friends Hall", "Mackin", the misspelled
 * "Trustees Pavillion") places an event only by a reviewed reading (src/reference/event-places.json),
 * and only while the captured page section it quotes still says so; the link cites that page too.
 * A spot beside a place ("Outside of Atrium") and places off campus are not linked.
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const ROOMS = /\b([A-Z]{1,4})[- ]?(\d{2,4}[A-Z]?)\b/g;
/** Kinds an event can be held at: buildings, and the places the campus map lists in them. */
const PLACE_KINDS = ['facility', 'office', 'venue'];

/** A floor of a building: "1st Floor", "second floor", "1st FL". */
const FLOOR = String.raw`(?:\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|ground|main|lower|upper)\s+(?:floor|fl)\.?`;
const WHERE_BEFORE = new RegExp(String.raw`^${FLOOR}\s+(?:of\s+)?(?:the\s+)?`, 'i');
const WHERE_AFTER = [
  // A floor and whatever is on it: "... 1st Floor Lounge", "... 1st Floor Movie Theatre".
  new RegExp(String.raw`\s+${FLOOR}(?:\s.*)?$`, 'i'),
  /\s+(?:main\s+|front\s+)?(?:lounges?|lobby)$/i,
  // A room number: "Trustees Pavilion 3", "Trustees Pavilion 1-3".
  /\s+\d{1,4}[A-Z]?(?:\s*[-–&]\s*\d{1,4}[A-Z]?)?$/,
];

/** The name left once the words saying where inside it (a floor, a lounge or lobby, a room number) are set aside. */
export function withoutWhereInside(value: string): string {
  let name = value.trim().replace(WHERE_BEFORE, '');
  for (let previous = ''; previous !== name;) {
    previous = name;
    for (const pattern of WHERE_AFTER) name = name.replace(pattern, '').trim();
  }
  return name;
}

export function eventLocation(row: Row | undefined): string {
  const listing = row?.listing && typeof row.listing === 'object' ? row.listing as Row : {};
  return text(listing.location) || text(row?.location);
}

/** A name listings give a place no node carries, as a person read it on a captured page (event-places.json). */
export interface ReviewedEventPlace {
  /** The listing's words for the place, compared as placeName compares them. */
  names: string[];
  /** The room the quote gives the place, in the building whose reviewed room prefix it has; or */
  room?: string;
  /** the building or campus-map place it is, by that node's exact name. */
  place?: string;
  url: string; section: string; quote: string; reviewed_at: string; note: string;
}
export interface ReviewedEventPlaces { schema_version: 1; places: ReviewedEventPlace[] }

interface Reading { id: string; evidence: IdentityEvidence }
/** A page's record key, the way office sections name pages ("www.ramapo.edu/csi/"). */
const pageKeyOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
const words = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
const ROOM = /^([A-Z]+)-\d{1,4}[A-Z]?$/;

/** The reviewed readings this run's captured pages still back, by name; the rest are reported and unused. */
function readPlaces(reviewed: ReviewedEventPlaces, pages: Row[], byPrefix: Map<string, string>, placeNodes: Map<string, string[]>): { readings: Map<string, Reading[]>; unresolved: IdentityCoverageIssue[] } {
  const byKey = new Map(pages.map(page => [text(page.source_record_key), page]));
  const readings = new Map<string, Reading[]>();
  const unresolved: IdentityCoverageIssue[] = [];
  for (const entry of reviewed.places) {
    const key = pageKeyOf(entry.url);
    const issue = (reason: string) => unresolved.push({ entity: entry.names.join(' / '), collection: 'office_sections', record: key, reason, kind: 'missing_connection' });
    const page = byKey.get(key);
    const sections = Array.isArray(page?.sections) ? page.sections as Row[] : [];
    if (!sections.some(section => text(section.heading) === entry.section && words(text(section.text)).includes(words(entry.quote)))) {
      issue(`The section "${entry.section}" of ${entry.url} is not in this capture or no longer says what was reviewed; no event is placed by this reading.`);
      continue;
    }
    let id: string | undefined;
    if (entry.room && !entry.place) {
      const prefix = ROOM.exec(entry.room)?.[1];
      id = prefix && words(entry.quote).includes(words(entry.room)) ? byPrefix.get(prefix) : undefined;
      if (!id) { issue(`The reviewed room ${entry.room} is not in the quote or has no reviewed building prefix; no event is placed by this reading.`); continue; }
    } else if (entry.place && !entry.room) {
      const found = placeNodes.get(entry.place) ?? [];
      if (found.length !== 1) { issue(`The reviewed place "${entry.place}" is not exactly one building or map place in this release; no event is placed by this reading.`); continue; }
      id = found[0];
    } else {
      issue('A reviewed reading names a room or a place, one of the two; no event is placed by it.');
      continue;
    }
    const evidence: IdentityEvidence = { collection: 'office_sections', source_key: text(page?.source_key) || 'office-pages', source_record_key: key, field: 'sections', source_url: entry.url };
    for (const name of entry.names) { const k = placeName(name); if (k) readings.set(k, [...readings.get(k) ?? [], { id, evidence }]); }
  }
  return { readings, unresolved };
}

/**
 * Adds held_at links to the events whose listed location names a building or a map place, by
 * name, by room, or by a reviewed reading `pages` (this run's office_sections rows) still back.
 */
export function linkEventPlaces(entities: CampusIdentity[], events: Row[], artifact: CampusBuildingsArtifact, listings: Row[] = [], pages: Row[] = [],
  reviewed: ReviewedEventPlaces = eventPlaceReadings as ReviewedEventPlaces): { linked: number; unresolved: IdentityCoverageIssue[] } {
  // A stored event row has no location column: the location is on the release's events listing
  // (the `events` artifact), found by the event's own Archway URL.
  const listed = new Map<string, Row>();
  for (const listing of listings) { const url = canonicalArchwayEventUrl(listing.url); if (url) listed.set(url, listing); }
  const withListing = (row: Row | undefined): Row | undefined => {
    if (!row || (row.listing && typeof row.listing === 'object')) return row;
    const listing = listed.get(canonicalArchwayEventUrl(row.event_url) ?? '');
    return listing ? { ...row, listing } : row;
  };
  const byPrefix = new Map<string, string>();
  for (const building of artifact.buildings) for (const prefix of building.room_prefixes) byPrefix.set(prefix, campusBuildingId(building));
  const buildingIds = new Set([...artifact.buildings.map(campusBuildingId), ...(artifact.complexes ?? []).map(c => buildingIdentityId(c.concept3d_id))]);
  // Places by name: buildings by their names and aliases, and the nodes the campus map lists as places.
  const named = new Map<string, Set<string>>();
  const add = (name: string, id: string) => { const key = placeName(name); if (key) named.set(key, new Set([...named.get(key) ?? [], id])); };
  const placesIn = new Map<string, Set<string>>();
  // The same nodes by exact name, for the reviewed readings that name one.
  const placeNodes = new Map<string, string[]>();
  for (const entity of entities) {
    const isBuilding = buildingIds.has(entity.id);
    const isPlace = PLACE_KINDS.includes(entity.kind) && entity.links.some(link => link.collection === 'map_places');
    if (!isBuilding && !isPlace) continue;
    for (const name of [entity.name, ...entity.aliases]) add(name, entity.id);
    placeNodes.set(entity.name, [...placeNodes.get(entity.name) ?? [], entity.id]);
    if (isPlace) placesIn.set(entity.id, new Set((entity.relationships ?? []).flatMap(r => r.type === 'located_at' && 'target_entity_id' in r ? [r.target_entity_id] : [])));
  }
  const { readings, unresolved } = readPlaces(reviewed, pages, byPrefix, placeNodes);
  // The one node, or else the one reviewed reading, a name stands for. Once words saying where
  // inside were set aside, a node must be a building: "Alumni Lounge" is not the Alumni Office.
  const lookup = (name: string, inside: boolean): { id: string; evidence?: IdentityEvidence } | null => {
    const key = placeName(name);
    if (!key) return null;
    const found = named.get(key);
    if (found?.size) { const [id] = found; return found.size === 1 && (!inside || buildingIds.has(id)) ? { id } : null; }
    const read = readings.get(key) ?? [];
    return new Set(read.map(r => r.id)).size === 1 ? read[0] : null;
  };
  const rows = new Map(events.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  let linked = 0;
  for (const entity of entities.filter(e => e.kind === 'event')) {
    for (const link of entity.links.filter(l => l.collection === 'events')) {
      for (const key of link.source_record_keys) {
        const row = withListing(rows.get(`${link.source_key}:${key}`));
        const location = eventLocation(row);
        if (!row || !location) continue;
        const places = new Set<string>();
        const buildings = new Set<string>();
        // Targets the listing places without a reviewed reading, and the page each reading cites.
        const plain = new Set<string>();
        const read = new Map<string, IdentityEvidence>();
        for (const part of [location, ...location.split(/[,;()]|\s[-–]\s/)]) {
          const inside = withoutWhereInside(part);
          const found = lookup(part, false) ?? (inside && inside !== part.trim() ? lookup(inside, true) : null);
          if (!found) continue;
          (buildingIds.has(found.id) ? buildings : places).add(found.id);
          if (found.evidence) read.set(found.id, found.evidence); else plain.add(found.id);
        }
        for (const [, prefix] of location.matchAll(ROOMS)) { const id = byPrefix.get(prefix); if (id) { buildings.add(id); plain.add(id); } }
        // A place stands for the building it is located in.
        for (const place of places) for (const building of placesIn.get(place) ?? []) buildings.delete(building);
        const targets = [...places, ...buildings];
        if (!targets.length) continue;
        const evidence: IdentityEvidence = { collection: 'events', source_key: link.source_key, source_record_key: key,
          ...(typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id) ? { source_record_id: row.id } : {}),
          field: 'location', ...(/^https:\/\//.test(text(row.event_url)) ? { source_url: text(row.event_url) } : {}) };
        entity.relationships ||= [];
        for (const target of targets) {
          if (entity.relationships.some(r => r.type === 'held_at' && 'target_entity_id' in r && r.target_entity_id === target)) continue;
          const page = plain.has(target) ? undefined : read.get(target);
          entity.relationships.push({ type: 'held_at', target_entity_id: target, evidence: page ? [evidence, page] : [evidence] });
        }
        linked++;
      }
    }
  }
  return { linked, unresolved };
}

/** Kinds that can host an event. */
const HOST_KINDS = ['office', 'venue', 'organization', 'club', 'school', 'facility'];
/** A name as it is written: case, spacing, "&" and punctuation aside, and no word dropped. */
const writtenName = (value: string): string => value.toLowerCase().replace(/&amp;/g, '&').replace(/&/g, ' and ')
  .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * organized_by for an event Archway names no organizer group node for: the one office, club,
 * organization or school named like the listing's organizer text. A node named as the organizer
 * is written (case and punctuation aside) wins over one that matches only as placeName compares,
 * which drops "Office of" and a trailing "Office": "School of Arts. Humanities, and Education" is
 * the school, not the School of Arts, Humanities, and Education Office. An Archway group ID, when
 * its group is a node, already decided it; a name two nodes share links neither.
 */
export function linkEventOrganizers(entities: CampusIdentity[], events: Row[]): { linked: number } {
  const written = new Map<string, Set<string>>();
  const named = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => { if (key) map.set(key, new Set([...map.get(key) ?? [], id])); };
  for (const entity of entities.filter(e => HOST_KINDS.includes(e.kind))) {
    for (const name of [entity.name, ...entity.aliases]) { add(written, writtenName(name), entity.id); add(named, placeName(name), entity.id); }
  }
  const rows = new Map(events.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  let linked = 0;
  for (const entity of entities.filter(e => e.kind === 'event' && !(e.relationships ?? []).some(r => r.type === 'organized_by'))) {
    const link = entity.links.find(l => l.collection === 'events');
    const key = link?.source_record_keys[0];
    const row = link && key ? rows.get(`${link.source_key}:${key}`) : undefined;
    const organizer = text(row?.organizer);
    const found = written.get(writtenName(organizer)) ?? named.get(placeName(organizer));
    if (!link || !key || !row || found?.size !== 1) continue;
    const [host] = found;
    entity.relationships ||= [];
    entity.relationships.push({ type: 'organized_by', target_entity_id: host, evidence: [{ collection: 'events', source_key: link.source_key, source_record_key: key,
      ...(typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id) ? { source_record_id: row.id } : {}),
      field: 'organizer', ...(/^https:\/\//.test(text(row.event_url)) ? { source_url: text(row.event_url) } : {}) }] });
    linked++;
  }
  return { linked };
}
