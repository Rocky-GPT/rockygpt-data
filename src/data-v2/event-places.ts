import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import { buildingIdentityId, campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import { placeName } from './campus-map-places';
import type { IdentityCoverageIssue } from './compile-campus-identities';

/**
 * @module data-v2/event-places
 * Where each event is held: `held_at` the place or building its Archway listing's location names.
 *
 * A location names a building by a room with a reviewed prefix ("BC 125", "E-216", "SC219"), or
 * names a place or building outright ("York Room", "Thomases Commons", "The Lodge"), compared the
 * way map places are (campus-map-places.ts). A named place wins over the building its room is in,
 * since the place is already located_at that building. A name two places share links neither.
 * "Online Event", "-" and private locations name nothing.
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const ROOMS = /\b([A-Z]{1,4})[- ]?(\d{2,4}[A-Z]?)\b/g;
/** Kinds an event can be held at: buildings, and the places the campus map lists in them. */
const PLACE_KINDS = ['facility', 'office', 'venue'];

export function eventLocation(row: Row | undefined): string {
  const listing = row?.listing && typeof row.listing === 'object' ? row.listing as Row : {};
  return text(listing.location) || text(row?.location);
}

/** Adds held_at links to the events whose listed location names a building or a map place. */
export function linkEventPlaces(entities: CampusIdentity[], events: Row[], artifact: CampusBuildingsArtifact): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const byPrefix = new Map<string, string>();
  for (const building of artifact.buildings) for (const prefix of building.room_prefixes) byPrefix.set(prefix, campusBuildingId(building));
  const buildingIds = new Set([...artifact.buildings.map(campusBuildingId), ...(artifact.complexes ?? []).map(c => buildingIdentityId(c.concept3d_id))]);
  // Places by name: buildings by their names and aliases, and the nodes the campus map lists as places.
  const named = new Map<string, Set<string>>();
  const add = (name: string, id: string) => { const key = placeName(name); if (key) named.set(key, new Set([...named.get(key) ?? [], id])); };
  const placesIn = new Map<string, Set<string>>();
  for (const entity of entities) {
    const isBuilding = buildingIds.has(entity.id);
    const isPlace = PLACE_KINDS.includes(entity.kind) && entity.links.some(link => link.collection === 'map_places');
    if (!isBuilding && !isPlace) continue;
    for (const name of [entity.name, ...entity.aliases]) add(name, entity.id);
    if (isPlace) placesIn.set(entity.id, new Set((entity.relationships ?? []).flatMap(r => r.type === 'located_at' && 'target_entity_id' in r ? [r.target_entity_id] : [])));
  }
  const rows = new Map(events.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  let linked = 0;
  for (const entity of entities.filter(e => e.kind === 'event')) {
    for (const link of entity.links.filter(l => l.collection === 'events')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`${link.source_key}:${key}`);
        const location = eventLocation(row);
        if (!row || !location) continue;
        const places = new Set<string>();
        const buildings = new Set<string>();
        for (const part of [location, ...location.split(/[,;()]|\s[-–]\s/)]) {
          const found = named.get(placeName(part));
          if (found?.size === 1) { const [id] = found; (buildingIds.has(id) ? buildings : places).add(id); }
        }
        for (const [, prefix] of location.matchAll(ROOMS)) { const id = byPrefix.get(prefix); if (id) buildings.add(id); }
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
          entity.relationships.push({ type: 'held_at', target_entity_id: target, evidence: [evidence] });
        }
        linked++;
      }
    }
  }
  return { linked, unresolved };
}

/** Kinds that can host an event. */
const HOST_KINDS = ['office', 'venue', 'organization', 'club', 'school', 'facility'];

/**
 * organized_by for an event Archway names no organizer group ID for: the one office, club,
 * organization or school named exactly like the listing's organizer text (compared as placeName
 * compares). An Archway group ID, when there is one, already decided it; a name two nodes share
 * links neither.
 */
export function linkEventOrganizers(entities: CampusIdentity[], events: Row[]): { linked: number } {
  const named = new Map<string, Set<string>>();
  for (const entity of entities.filter(e => HOST_KINDS.includes(e.kind))) {
    for (const name of [entity.name, ...entity.aliases]) { const key = placeName(name); if (key) named.set(key, new Set([...named.get(key) ?? [], entity.id])); }
  }
  const rows = new Map(events.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  let linked = 0;
  for (const entity of entities.filter(e => e.kind === 'event' && !(e.relationships ?? []).some(r => r.type === 'organized_by'))) {
    const link = entity.links.find(l => l.collection === 'events');
    const key = link?.source_record_keys[0];
    const row = link && key ? rows.get(`${link.source_key}:${key}`) : undefined;
    const found = named.get(placeName(text(row?.organizer)));
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
