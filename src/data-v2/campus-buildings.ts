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
 * mapping (approved September 22, 2026).
 *
 * Every building on the map is an identity (since November 2, 2026; before, only
 * those with room prefixes were). A building with a Concept3D location of its own
 * takes its ID from that location ID, so a rename keeps it. Buildings that share one
 * map pin (the 14 College Park Apartments buildings, the Village's 12, the two Laurel
 * Hall buildings) or have none (Visitor's Circle) take theirs from the map entry's key.
 * Room prefixes count only for a building with its own pin.
 *
 * A published room places its holder in a building only when the whole value
 * is one or more `PREFIX-NUMBER` rooms separated by "/" and each prefix belongs
 * to one building, or when a person reviewed that exact published value as
 * naming a building, such as "Learning Commons 204A". Map aliases, building
 * names and other free text never do. On September 24, 2026, "LC" was added for
 * the Peter P. Mercer Learning Commons, where the Library staff's LC rooms are,
 * and "SS" for the Sculpture Studios by a person's review: the one SS room is a
 * sculpture professor's, and no Ramapo source spells SS out.
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
  /** The Concept3D location the map pins it at; several buildings can share one, and a few have none. */
  concept3d_id: string | null; name: string; category: string | null; map_url: string; room_prefixes: string[];
  /** The map entry's own key (`building_pine-hall`). */
  map_key: string;
  /** Its key in the `buildings` records: its Concept3D ID when it has a pin of its own, else its map key. */
  record_key: string;
  /** Why it is a building identity: its reviewed room prefixes, a human review, or the campus map alone. */
  basis: 'room_prefixes' | 'human_reviewed' | 'campus_map';
  /** Identities placed here by a reviewed official statement; the evidence for their located_at. */
  reviewed_locations?: BuildingLocation[];
  /** Exact published room values a person reviewed as naming this building. */
  reviewed_rooms?: string[];
  /** The group this building is part of: the record key of the map pin it shares with its neighbours. */
  complex?: string;
}
/** Buildings the map pins as one place under a shared name: "College Park Apartments" for its 14 buildings. */
export interface BuildingComplex { concept3d_id: string; record_key: string; name: string; map_url: string; members: string[] }
/** A map location a person approved as its own building identity. */
export interface ReviewedBuilding { concept3d_id: string; name: string; reviewed_at: string; note: string }
/** An official page's statement that places an identity in a building, as a person approved it. */
export interface ReviewedLocation {
  entity_id: string; entity: string; concept3d_id: string; building: string;
  statement: string; source_url: string; reviewed_at: string; note: string;
}
export type BuildingLocation = Pick<ReviewedLocation, 'entity_id' | 'entity' | 'statement' | 'source_url' | 'reviewed_at'>;
/** A published room value that is not a `PREFIX-NUMBER` room, read by a person as naming a building. */
export interface ReviewedRoom { room: string; concept3d_id: string; building: string; reviewed_at: string; note: string }
export interface CampusBuildingsArtifact {
  schema_version: 1;
  /** The published source these records belong to, as the publisher seeds it. */
  source: { source_key: string; title: string; canonical_url: string; trust_tier: string; freshness_sla_hours: number; domain: string };
  map_source_url: string | null;
  map_generated_at: string | null;
  buildings: CampusBuilding[];
  /** Groups of buildings at one shared map pin, each a building identity its members are part_of. */
  complexes: BuildingComplex[];
  unresolved: { name: string; reason: string; kind: CoverageKind }[];
}

export const buildingIdentityId = (concept3dId: string): string => uuid5(BUILDING_NAMESPACE, `concept3d:location:${concept3dId}`);
/** A building's ID: from its own Concept3D location, or from its map key when it has no pin of its own. */
export const campusBuildingId = (building: Pick<CampusBuilding, 'concept3d_id' | 'record_key'>): string =>
  building.record_key === building.concept3d_id ? buildingIdentityId(building.record_key) : uuid5(BUILDING_NAMESPACE, `campus-map:building:${building.record_key}`);
const decode = (value: string): string => value.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Row[] : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Every building on the map; room prefixes count only for one at a Concept3D location no other map entry shares. */
export function campusBuildingsArtifact(map: unknown, reviewed: ReviewedBuilding[] = [], locations: ReviewedLocation[] = [], rooms: ReviewedRoom[] = []): CampusBuildingsArtifact {
  const seed = SOURCES.find(source => source.key === CAMPUS_MAP_SOURCE_KEY);
  if (!seed) throw new Error('The campus-map source seed is missing.');
  // The map lists a few places twice (Multipurpose Field): one name at one pin is one building.
  const seen = new Set<string>();
  const entries = rows((map as Row)?.buildings).map(row => ({
    row, id: /#!m\/(\d+)/.exec(text(row.mapUrl))?.[1] ?? null,
    prefixes: Array.isArray(row.roomPrefixes) ? row.roomPrefixes.map(text).filter(Boolean) : [],
  })).filter(entry => {
    const place = `${decode(text(entry.row.name))}@${entry.id ?? text(entry.row.key)}`;
    if (seen.has(place)) return false;
    seen.add(place);
    return Boolean(text(entry.row.name));
  });
  const shared = new Map<string, number>();
  for (const entry of entries) if (entry.id) shared.set(entry.id, (shared.get(entry.id) || 0) + 1);
  const owners = new Map<string, number>();
  for (const entry of entries) for (const prefix of entry.prefixes) owners.set(prefix, (owners.get(prefix) || 0) + 1);
  const buildings: CampusBuilding[] = [];
  const unresolved: CampusBuildingsArtifact['unresolved'] = [];
  const approved = new Map(reviewed.map(building => [building.concept3d_id, building]));
  for (const { row, id, prefixes } of entries) {
    const review = id ? approved.get(id) : undefined;
    const name = decode(text(row.name));
    if (review && review.name !== name) { unresolved.push({ name, reason: `The reviewed building "${review.name}" is named "${name}" on the map; it is not published until the review matches.`, kind: 'unlinked_record' }); continue; }
    const ownPin = Boolean(id) && shared.get(id!) === 1;
    if (!ownPin && !text(row.key)) { unresolved.push({ name, reason: 'The map entry has no map pin of its own and no key, so it has no persistent building identity.', kind: 'unlinked_record' }); continue; }
    let kept = prefixes;
    if (prefixes.length && !ownPin) { unresolved.push({ name, reason: 'Its map pin is shared or missing, so its room prefixes place nothing.', kind: 'note' }); kept = []; }
    else if (prefixes.some(prefix => owners.get(prefix) !== 1 || !/^[A-Z]+$/.test(prefix))) { unresolved.push({ name, reason: 'A room prefix is claimed by another building or is not an uppercase code; its prefixes place nothing.', kind: 'note' }); kept = []; }
    buildings.push({ concept3d_id: id, name, category: decode(text(row.category)) || null, map_url: text(row.mapUrl), room_prefixes: kept,
      map_key: text(row.key), record_key: ownPin ? id! : text(row.key),
      basis: kept.length ? 'room_prefixes' : review ? 'human_reviewed' : 'campus_map' });
  }
  for (const building of reviewed) {
    if (!entries.some(entry => entry.id === building.concept3d_id)) unresolved.push({ name: building.name, reason: `The reviewed Concept3D location ${building.concept3d_id} is not on the committed map.`, kind: 'no_records' });
  }
  for (const location of locations) {
    const building = buildings.find(item => item.record_key === location.concept3d_id);
    if (!building || building.name !== location.building) { unresolved.push({ name: location.building, reason: `The reviewed location of "${location.entity}" names a building that is not published under that name; nothing is placed.`, kind: 'no_records' }); continue; }
    const { entity_id, entity, statement, source_url, reviewed_at } = location;
    building.reviewed_locations = [...(building.reviewed_locations ?? []), { entity_id, entity, statement, source_url, reviewed_at }];
  }
  // Buildings at one shared pin whose names begin alike ("College Park Apartments - Elm", "The
  // Village - Building 4", "Laurel Hall North Building") are one group, named by those words.
  const complexes: BuildingComplex[] = [];
  const atPin = new Map<string, CampusBuilding[]>();
  for (const building of buildings) if (building.concept3d_id && building.record_key !== building.concept3d_id) atPin.set(building.concept3d_id, [...atPin.get(building.concept3d_id) ?? [], building]);
  for (const [pin, members] of atPin) {
    const words = members.map(member => member.name.split(' '));
    const common: string[] = [];
    for (let index = 0; words.every(w => index < w.length - 1 && w[index] === words[0][index]); index++) common.push(words[0][index]);
    const name = common.join(' ').replace(/\s*-$/, '').trim();
    if (members.length < 2 || common.length < 2) continue;
    complexes.push({ concept3d_id: pin, record_key: pin, name, map_url: `https://map.ramapo.edu/?id=2292#!m/${pin}?sbc/`, members: members.map(m => m.map_key).sort() });
    for (const member of members) member.complex = pin;
  }
  const readings = new Map<string, number>();
  for (const reading of rooms) readings.set(reading.room, (readings.get(reading.room) || 0) + 1);
  for (const reading of rooms) {
    const building = buildings.find(item => item.record_key === reading.concept3d_id);
    if (!building || building.name !== reading.building || readings.get(reading.room) !== 1) { unresolved.push({ name: reading.building, reason: `The reviewed room "${reading.room}" does not name exactly one building published under that name; nothing is placed.`, kind: 'no_records' }); continue; }
    building.reviewed_rooms = [...(building.reviewed_rooms ?? []), reading.room];
  }
  return {
    schema_version: 1,
    source: { source_key: seed.key, title: seed.title, canonical_url: seed.url, trust_tier: seed.trustTier, freshness_sla_hours: seed.freshnessHours, domain: seed.domain },
    map_source_url: text((map as Row)?.source) || null,
    map_generated_at: text((map as Row)?.generatedAt) || null,
    buildings: buildings.sort((a, b) => (a.record_key < b.record_key ? -1 : 1)),
    complexes: complexes.sort((a, b) => (a.record_key < b.record_key ? -1 : 1)),
    unresolved,
  };
}

/** The buildings a published room value names, or why it names none. */
export function roomBuildings(value: unknown, byPrefix: Map<string, string>, byReading: Map<string, string> = new Map()): { buildings: string[] } | { reason: string } | null {
  const room = text(value);
  if (!room) return null;
  // A reviewed reading names its building for this exact published value only.
  const read = byReading.get(room);
  if (read) return { buildings: [read] };
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
    if (other) unresolved.push({ entity: building.name, collection: 'buildings', record: building.record_key, reason: `Shares its name with the ${other}; a name lookup asks which one is meant.`, kind: 'note' });
    return { id: campusBuildingId(building), kind: 'building', name: building.name, aliases: [], links: [
      { collection: 'buildings', source_key: artifact.source.source_key, source_record_keys: [building.record_key] },
    ] };
  });
  // A group of buildings at one pin is a building identity too, keyed by that pin; its members are part_of it.
  for (const complex of artifact.complexes ?? []) {
    buildings.push({ id: buildingIdentityId(complex.concept3d_id), kind: 'building', name: complex.name, aliases: [], links: [
      { collection: 'buildings', source_key: artifact.source.source_key, source_record_keys: [complex.record_key] },
    ] });
  }
  artifact.buildings.forEach((building, index) => {
    if (!building.complex) return;
    buildings[index].relationships = [{ type: 'part_of', target_entity_id: buildingIdentityId(building.complex), evidence: [
      { collection: 'buildings', source_key: artifact.source.source_key, source_record_key: building.record_key, field: 'concept3d_id', source_url: building.map_url },
    ] }];
  });
  const byPrefix = new Map(artifact.buildings.flatMap((building, index) => building.room_prefixes.map(prefix => [prefix, buildings[index].id] as const)));
  const byReading = new Map(artifact.buildings.flatMap((building, index) => (building.reviewed_rooms ?? []).map(room => [room, buildings[index].id] as const)));
  for (const unlisted of artifact.unresolved) unresolved.push({ entity: unlisted.name, collection: 'buildings', reason: unlisted.reason, kind: unlisted.kind });
  // A reviewed location places only the identity it names by ID, and only one that
  // has no room of its own to be placed by: an office, facility or venue.
  const placements = new Map<string, { building: string; evidence: IdentityEvidence }[]>();
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  for (const building of artifact.buildings) {
    for (const location of building.reviewed_locations ?? []) {
      const entity = byId.get(location.entity_id);
      if (!entity || entity.name !== location.entity || !['office', 'facility', 'venue'].includes(entity.kind)) {
        unresolved.push({ entity: location.entity, collection: 'buildings', record: building.record_key, reason: 'The reviewed location names no office, facility or venue in this release under that name; nothing is placed.', kind: 'no_records' });
        continue;
      }
      placements.set(entity.id, [...(placements.get(entity.id) ?? []), { building: campusBuildingId(building), evidence: {
        collection: 'buildings', source_key: artifact.source.source_key, source_record_key: building.record_key, field: 'reviewed_locations', source_url: location.source_url,
      } }]);
    }
  }
  for (const entity of entities) {
    // An Archway group with a reviewed contact (a residence hall desk) is placed by that contact's room too.
    const placed = ['office', 'facility', 'venue'].includes(entity.kind)
      || (['club', 'organization'].includes(entity.kind) && entity.links.some(link => link.collection === 'contacts'));
    const type = entity.kind === 'person' ? 'office_at' : placed ? 'located_at' : null;
    if (!type) continue;
    const evidence = new Map<string, IdentityEvidence[]>();
    for (const placement of placements.get(entity.id) ?? []) evidence.set(placement.building, [...(evidence.get(placement.building) ?? []), placement.evidence]);
    for (const link of entity.links.filter(l => l.collection === 'contacts')) {
      for (const key of link.source_record_keys) {
        const placed = roomBuildings(contacts.get(`${link.source_key}:${key}`)?.office, byPrefix, byReading);
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
