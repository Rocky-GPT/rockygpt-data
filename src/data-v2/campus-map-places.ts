import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import { CAMPUS_MAP_SOURCE_KEY, buildingIdentityId, campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';

/**
 * @module data-v2/campus-map-places
 * The places Ramapo's campus map lists inside each building (the Registrar in Academic Building
 * D, the Auxiliary Gym in the Bill Bradley Center, the York Room in Birch Mansion), joined to the
 * graph by `located_at`.
 *
 * A map place is the node the registry already has for it when one is named the same (after
 * dropping "(CSI)", "Office of", a trailing "Office", "the", and "&" for "and"), or when the
 * committed match list (src/reference/campus-map-places.json) pairs them. Otherwise it is a new
 * `facility` node of its own. A name two nodes share links neither and adds none; a place named
 * like its own building is the building. Each link's evidence is the map entry, read on the map.
 *
 * Offices named for a building (the Pine Hall desk, The Overlook) are placed in it the same way:
 * by the same name, or by the list's `buildings` pairs (Mackin Hall in Nancy Mackin Hall).
 */

const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
type Row = Record<string, unknown>;

/** Map places matched to registry nodes whose names differ, and offices placed in a building named differently. */
export interface CampusMapMatches {
  places?: Array<{ map_key: string; map_name: string; entity_ids: string[]; entities: string[]; note: string }>;
  buildings?: Array<{ entity_id: string; entity: string; building_key: string; building: string; note: string }>;
}

/** Kinds a map place can be: the places the registry already holds. */
const PLACE_KINDS = ['office', 'venue', 'facility', 'organization', 'club', 'school'];
/** Kinds that can be placed in a building because they are named for it. */
const NAMED_FOR_BUILDING = ['office', 'venue', 'facility', 'organization'];

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const decode = (value: string): string => value.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
/** The name with the words that differ between the map and the directory taken off. */
export const placeName = (value: string): string => decode(value).toLowerCase()
  .replace(/\s*\([^)]*\)/g, '').replace(/&/g, ' and ').replace(/[’']/g, '')
  .replace(/^(the|office of( the)?)\s+/, '').replace(/\s+office$/, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

export function facilityIdentityId(mapKey: string): string {
  return uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'facility', CAMPUS_MAP_SOURCE_KEY, mapKey]));
}

export interface MapPlacesGraph {
  /** New facility nodes, for map places no registry node is. */
  entities: CampusIdentity[];
  places: GraphRecordCollectionData;
  buildings: GraphRecordCollectionData;
  unresolved: IdentityCoverageIssue[];
}

function place(entity: CampusIdentity, building: string, evidence: IdentityEvidence): void {
  entity.relationships ||= [];
  const held = entity.relationships.find(r => r.type === 'located_at' && r.target_entity_id === building);
  if (held) {
    if (!held.evidence.some(e => JSON.stringify(e) === JSON.stringify(evidence))) held.evidence.push(evidence);
  } else {
    entity.relationships.push({ type: 'located_at', target_entity_id: building, evidence: [evidence] });
  }
}

function linkRecord(entity: CampusIdentity, key: string): void {
  const link = entity.links.find(l => l.collection === 'map_places' && l.source_key === CAMPUS_MAP_SOURCE_KEY);
  if (link) { if (!link.source_record_keys.includes(key)) link.source_record_keys = [...link.source_record_keys, key].sort(); }
  else entity.links.push({ collection: 'map_places', source_key: CAMPUS_MAP_SOURCE_KEY, source_record_keys: [key] });
}

/** Map places and the buildings' own records, placed against the release's registry. */
export function compileMapPlaces(map: unknown, artifact: CampusBuildingsArtifact, entities: CampusIdentity[],
  matches: CampusMapMatches = {}, collectedAt = ''): MapPlacesGraph {
  const unresolved: IdentityCoverageIssue[] = [];
  const byMapKey = new Map(artifact.buildings.map(b => [b.map_key, b]));
  const buildingRows: GraphRecordRow[] = [
    ...artifact.buildings.map(b => ({
      source_record_key: b.record_key, name: b.name, category: b.category, map_key: b.map_key,
      concept3d_id: b.concept3d_id, room_prefixes: b.room_prefixes, part_of: b.complex ?? null, search_names: b.search_names ?? [], source_url: b.map_url,
    })),
    ...(artifact.complexes ?? []).map(c => ({
      source_record_key: c.record_key, name: c.name, concept3d_id: c.concept3d_id,
      buildings: c.members.map(key => byMapKey.get(key)?.name ?? key), source_url: c.map_url,
    })),
  ];
  const byId = new Map(entities.map(e => [e.id, e]));
  const named = new Map<string, CampusIdentity[]>();
  for (const entity of entities.filter(e => PLACE_KINDS.includes(e.kind))) {
    for (const name of new Set([entity.name, ...entity.aliases].map(placeName))) {
      if (name) named.set(name, [...named.get(name) ?? [], entity]);
    }
  }
  const listed = new Map((matches.places ?? []).map(m => [m.map_key, m]));
  const rows: GraphRecordRow[] = [];
  const created: CampusIdentity[] = [];
  for (const row of (Array.isArray((map as Row)?.offices) ? (map as Row).offices as Row[] : [])) {
    const key = text(row.key);
    const name = decode(text(row.name));
    const building = byMapKey.get(text(row.buildingKey));
    if (!key || !name || !building) {
      unresolved.push({ entity: name || key, collection: 'map_places', record: key || undefined, reason: 'The map place names no building on the map; it is not placed.', kind: 'unlinked_record' });
      continue;
    }
    const mapUrl = text(row.mapUrl);
    const sourceUrl = /^https:\/\//.test(mapUrl) ? mapUrl : building.map_url;
    rows.push({ source_record_key: key, name, building: building.name, building_key: building.map_key, category: decode(text(row.category)) || null,
      website: text(row.officeUrl) || null, source_url: sourceUrl });
    const evidence: IdentityEvidence = { collection: 'map_places', source_key: CAMPUS_MAP_SOURCE_KEY, source_record_key: key, field: 'building', source_url: sourceUrl };
    const target = campusBuildingId(building);
    const match = listed.get(key);
    if (match) {
      const found = match.entity_ids.map(id => byId.get(id));
      if (match.map_name !== name || found.some((e, i) => !e || e.name !== match.entities[i])) {
        unresolved.push({ entity: name, collection: 'map_places', record: key, reason: 'The match list names a map place or node that is not in this release under that name; nothing is placed.', kind: 'missing_connection' });
        continue;
      }
      for (const entity of found as CampusIdentity[]) { linkRecord(entity, key); place(entity, target, evidence); }
      continue;
    }
    const same = named.get(placeName(name)) ?? [];
    if (same.length === 1) { linkRecord(same[0], key); place(same[0], target, evidence); continue; }
    if (same.length > 1) {
      unresolved.push({ entity: name, collection: 'map_places', record: key, reason: `Named like ${same.map(e => `${e.kind} "${e.name}"`).join(' and ')}; the match list must say which, so nothing is placed.`, kind: 'missing_connection' });
      continue;
    }
    if (placeName(name) === placeName(building.name)) continue; // "Lodge" in The Lodge (CPA) is the building itself.
    const facility: CampusIdentity = { id: facilityIdentityId(key), kind: 'facility', name, aliases: [],
      links: [{ collection: 'map_places', source_key: CAMPUS_MAP_SOURCE_KEY, source_record_keys: [key] }] };
    place(facility, target, evidence);
    created.push(facility);
  }
  // Offices and venues named for a building, or for a group of buildings, are in it.
  type Placeable = { record_key: string; concept3d_id: string | null; map_url: string; id: string };
  const buildingNames = new Map<string, Placeable[]>();
  for (const b of [...artifact.buildings.map(b => ({ ...b, id: campusBuildingId(b) })),
    ...(artifact.complexes ?? []).map(c => ({ ...c, id: buildingIdentityId(c.concept3d_id) }))]) {
    buildingNames.set(placeName(b.name), [...buildingNames.get(placeName(b.name)) ?? [], b]);
  }
  const pairs = new Map<string, Array<{ building: string; note: string }>>();
  for (const pair of matches.buildings ?? []) {
    const entity = byId.get(pair.entity_id);
    const building = byMapKey.get(pair.building_key);
    if (!entity || entity.name !== pair.entity || !building || building.name !== pair.building) {
      unresolved.push({ entity: pair.entity, collection: 'buildings', record: pair.building_key, reason: 'The match list places a node or names a building that is not in this release under that name; nothing is placed.', kind: 'missing_connection' });
      continue;
    }
    pairs.set(entity.id, [...pairs.get(entity.id) ?? [], { building: building.map_key, note: pair.note }]);
  }
  for (const entity of entities.filter(e => NAMED_FOR_BUILDING.includes(e.kind))) {
    const own = buildingNames.get(placeName(entity.name)) ?? [];
    const listedPairs = (pairs.get(entity.id) ?? []).map(p => byMapKey.get(p.building)!).map(b => ({ ...b, id: campusBuildingId(b) }));
    const chosen: Placeable[] = [...(own.length === 1 ? [own[0]] : []), ...listedPairs];
    for (const building of chosen) {
      place(entity, building.id, { collection: 'buildings', source_key: CAMPUS_MAP_SOURCE_KEY,
        source_record_key: building.record_key, field: 'name', source_url: building.map_url });
    }
  }
  return {
    entities: created,
    places: { source_key: CAMPUS_MAP_SOURCE_KEY, collected_at: collectedAt, rows },
    buildings: { source_key: CAMPUS_MAP_SOURCE_KEY, collected_at: collectedAt, rows: buildingRows },
    unresolved,
  };
}
