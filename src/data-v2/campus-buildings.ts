import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { CoverageKind, IdentityCoverageIssue } from './compile-campus-identities';
import { uuid5 } from './course-identities';
import { normalizeName } from './archway-identities';
import { SOURCES } from './source-seeds';

/**
 * @module data-v2/campus-buildings
 * Buildings that published room numbers place people and offices in.
 *
 * The committed campus map (`data/map/campus-map-data.json`, collected from
 * Ramapo's Concept3D map) names each building and, for some, the room-number
 * prefixes that belong to it: "D" for Academic Building D, "ASB" for the
 * Anisfield School of Business. That prefix table is the reviewed room-prefix
 * mapping (approved September 22, 2026). A building becomes an identity only
 * when it has room prefixes and a Concept3D location of its own; its ID derives
 * from that location ID, so a rename keeps it.
 *
 * A published room places its holder in a building only when the whole value
 * is one or more `PREFIX-NUMBER` rooms separated by "/" and each prefix belongs
 * to one building. Map aliases, building names and free text such as
 * "Learning Commons 204A" or "The Lodge" never do. "LC" was added for the
 * Peter P. Mercer Learning Commons on September 24, 2026, where the Library
 * staff's LC rooms are.
 *
 * An office, facility or venue with no published room can still be placed by a
 * reviewed location: a person confirms an official page's statement, such as the
 * campus-hours page's "Library in the Peter P. Mercer Learning Commons". The
 * statement and its source stay on the building's published record, which is
 * the relationship's evidence, so a reader can recheck it there.
 */

type Row = Record<string, unknown>;

// Fixed namespace for building IDs; a persistence contract, do not change.
const BUILDING_NAMESPACE = Buffer.from('a71a7a72d4f04525850ae873efa2224f', 'hex');
export const CAMPUS_MAP_SOURCE_KEY = 'campus-map';
const ROOM = /^([A-Z]+)-(\d{1,4}[A-Z]?)$/;

export interface CampusBuilding {
  concept3d_id: string; name: string; category: string | null; map_url: string; room_prefixes: string[];
  /** Why it is a building identity: its reviewed room prefixes, or a human review. */
  basis: 'room_prefixes' | 'human_reviewed';
  /** Identities placed here by a reviewed official statement; the evidence for their located_at. */
  reviewed_locations?: BuildingLocation[];
}
/** A map location a person approved as its own building identity. */
export interface ReviewedBuilding { concept3d_id: string; name: string; reviewed_at: string; note: string }
/** An official page's statement that places an identity in a building, as a person approved it. */
export interface ReviewedLocation {
  entity_id: string; entity: string; concept3d_id: string; building: string;
  statement: string; source_url: string; reviewed_at: string; note: string;
}
export type BuildingLocation = Pick<ReviewedLocation, 'entity_id' | 'entity' | 'statement' | 'source_url' | 'reviewed_at'>;
export interface CampusBuildingsArtifact {
  schema_version: 1;
  /** The published source these records belong to, as the publisher seeds it. */
  source: { source_key: string; title: string; canonical_url: string; trust_tier: string; freshness_sla_hours: number; domain: string };
  map_source_url: string | null;
  map_generated_at: string | null;
  buildings: CampusBuilding[];
  unresolved: { name: string; reason: string; kind: CoverageKind }[];
}

export const buildingIdentityId = (concept3dId: string): string => uuid5(BUILDING_NAMESPACE, `concept3d:location:${concept3dId}`);

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Row[] : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Buildings with reviewed room prefixes, or approved by a human review, at a Concept3D location no other map entry shares. */
export function campusBuildingsArtifact(map: unknown, reviewed: ReviewedBuilding[] = [], locations: ReviewedLocation[] = []): CampusBuildingsArtifact {
  const seed = SOURCES.find(source => source.key === CAMPUS_MAP_SOURCE_KEY);
  if (!seed) throw new Error('The campus-map source seed is missing.');
  const entries = rows((map as Row)?.buildings).map(row => ({
    row, id: /#!m\/(\d+)/.exec(text(row.mapUrl))?.[1] ?? null,
    prefixes: Array.isArray(row.roomPrefixes) ? row.roomPrefixes.map(text).filter(Boolean) : [],
  }));
  const shared = new Map<string, number>();
  for (const entry of entries) if (entry.id) shared.set(entry.id, (shared.get(entry.id) || 0) + 1);
  const owners = new Map<string, number>();
  for (const entry of entries) for (const prefix of entry.prefixes) owners.set(prefix, (owners.get(prefix) || 0) + 1);
  const buildings: CampusBuilding[] = [];
  const unresolved: CampusBuildingsArtifact['unresolved'] = [];
  const approved = new Map(reviewed.map(building => [building.concept3d_id, building]));
  for (const { row, id, prefixes } of entries) {
    const review = id ? approved.get(id) : undefined;
    if (!prefixes.length && !review) continue;
    const name = text(row.name);
    if (review && review.name !== name) { unresolved.push({ name, reason: `The reviewed building "${review.name}" is named "${name}" on the map; it is not published until the review matches.`, kind: 'unlinked_record' }); continue; }
    if (!id) unresolved.push({ name, reason: 'The map entry has no Concept3D location ID, so it has no persistent building identity.', kind: 'unlinked_record' });
    else if (shared.get(id) !== 1) unresolved.push({ name, reason: `Concept3D location ${id} is shared by several map entries; no single building identity.`, kind: 'unlinked_record' });
    else if (prefixes.some(prefix => owners.get(prefix) !== 1 || !/^[A-Z]+$/.test(prefix))) unresolved.push({ name, reason: 'A room prefix is claimed by another building or is not an uppercase code.', kind: 'unlinked_record' });
    else buildings.push({ concept3d_id: id, name, category: text(row.category) || null, map_url: text(row.mapUrl), room_prefixes: prefixes, basis: prefixes.length ? 'room_prefixes' : 'human_reviewed' });
  }
  for (const building of reviewed) {
    if (!entries.some(entry => entry.id === building.concept3d_id)) unresolved.push({ name: building.name, reason: `The reviewed Concept3D location ${building.concept3d_id} is not on the committed map.`, kind: 'no_records' });
  }
  for (const location of locations) {
    const building = buildings.find(item => item.concept3d_id === location.concept3d_id);
    if (!building || building.name !== location.building) { unresolved.push({ name: location.building, reason: `The reviewed location of "${location.entity}" names a building that is not published under that name; nothing is placed.`, kind: 'no_records' }); continue; }
    const { entity_id, entity, statement, source_url, reviewed_at } = location;
    building.reviewed_locations = [...(building.reviewed_locations ?? []), { entity_id, entity, statement, source_url, reviewed_at }];
  }
  return {
    schema_version: 1,
    source: { source_key: seed.key, title: seed.title, canonical_url: seed.url, trust_tier: seed.trustTier, freshness_sla_hours: seed.freshnessHours, domain: seed.domain },
    map_source_url: text((map as Row)?.source) || null,
    map_generated_at: text((map as Row)?.generatedAt) || null,
    buildings: buildings.sort((a, b) => (a.concept3d_id < b.concept3d_id ? -1 : 1)),
    unresolved,
  };
}

/** The buildings a published room value names, or why it names none. */
export function roomBuildings(value: unknown, byPrefix: Map<string, string>): { buildings: string[] } | { reason: string } | null {
  const room = text(value);
  if (!room) return null;
  const found: string[] = [];
  for (const part of room.split('/').map(p => p.trim())) {
    const prefix = ROOM.exec(part)?.[1];
    const building = prefix ? byPrefix.get(prefix) : undefined;
    if (!building) return { reason: `Published room "${room}" is not one or more PREFIX-NUMBER rooms with reviewed building prefixes; no building is inferred.` };
    if (!found.includes(building)) found.push(building);
  }
  return { buildings: found };
}

/**
 * Building identities, and office_at (people) / located_at (offices, facilities,
 * venues) relationships from each identity's own linked contact rooms or a
 * reviewed location. `contacts` maps `${source_key}:${source_record_key}` to the
 * contact row in this release.
 */
export function compileBuildingIdentities(artifact: CampusBuildingsArtifact, entities: CampusIdentity[], contacts: Map<string, Row>): { buildings: CampusIdentity[]; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const names = new Map<string, string>();
  for (const entity of entities) for (const name of [entity.name, ...entity.aliases]) names.set(normalizeName(name), `${entity.kind} "${entity.name}"`);
  const buildings: CampusIdentity[] = artifact.buildings.map(building => {
    const other = names.get(normalizeName(building.name));
    // A shared name is kept for an ambiguous lookup, never merged by name.
    if (other) unresolved.push({ entity: building.name, collection: 'buildings', record: building.concept3d_id, reason: `Shares its name with the ${other}; a name lookup asks which one is meant.`, kind: 'note' });
    return { id: buildingIdentityId(building.concept3d_id), kind: 'building', name: building.name, aliases: [], links: [
      { collection: 'buildings', source_key: artifact.source.source_key, source_record_keys: [building.concept3d_id] },
    ] };
  });
  const byPrefix = new Map(artifact.buildings.flatMap((building, index) => building.room_prefixes.map(prefix => [prefix, buildings[index].id] as const)));
  for (const unlisted of artifact.unresolved) unresolved.push({ entity: unlisted.name, collection: 'buildings', reason: unlisted.reason, kind: unlisted.kind });
  // A reviewed location places only the identity it names by ID, and only one that
  // has no room of its own to be placed by: an office, facility or venue.
  const placements = new Map<string, { building: string; evidence: IdentityEvidence }[]>();
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  for (const building of artifact.buildings) {
    for (const location of building.reviewed_locations ?? []) {
      const entity = byId.get(location.entity_id);
      if (!entity || entity.name !== location.entity || !['office', 'facility', 'venue'].includes(entity.kind)) {
        unresolved.push({ entity: location.entity, collection: 'buildings', record: building.concept3d_id, reason: 'The reviewed location names no office, facility or venue in this release under that name; nothing is placed.', kind: 'no_records' });
        continue;
      }
      placements.set(entity.id, [...(placements.get(entity.id) ?? []), { building: buildingIdentityId(building.concept3d_id), evidence: {
        collection: 'buildings', source_key: artifact.source.source_key, source_record_key: building.concept3d_id, field: 'reviewed_locations', source_url: location.source_url,
      } }]);
    }
  }
  for (const entity of entities) {
    const type = entity.kind === 'person' ? 'office_at' : ['office', 'facility', 'venue'].includes(entity.kind) ? 'located_at' : null;
    if (!type) continue;
    const evidence = new Map<string, IdentityEvidence[]>();
    for (const placement of placements.get(entity.id) ?? []) evidence.set(placement.building, [...(evidence.get(placement.building) ?? []), placement.evidence]);
    for (const link of entity.links.filter(l => l.collection === 'contacts')) {
      for (const key of link.source_record_keys) {
        const placed = roomBuildings(contacts.get(`${link.source_key}:${key}`)?.office, byPrefix);
        if (placed === null) continue;
        if ('reason' in placed) { unresolved.push({ entity: entity.name, collection: 'contacts', record: key, reason: placed.reason, kind: 'missing_connection' }); continue; }
        for (const building of placed.buildings) {
          const references = evidence.get(building) || [];
          references.push({ collection: 'contacts', source_key: link.source_key, source_record_key: key, field: 'office' });
          evidence.set(building, references);
        }
      }
    }
    for (const [building, references] of evidence) {
      entity.relationships ||= [];
      entity.relationships.push({ type, target_entity_id: building, evidence: references });
    }
  }
  return { buildings, unresolved };
}
