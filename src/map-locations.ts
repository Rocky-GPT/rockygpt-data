/**
 * @module map-locations
 * Campus map search index and natural-language location inference.
 *
 * Loads building, office, parking, and layer records from the generated
 * campus-map-data JSON, normalises them into a unified {@link MapLocation}
 * list, and provides scored search and intent-based location inference
 * consumed by the chat renderer and the interactive map modal.
 */

import campusMapData from '../data/map/campus-map-data.json';

/**
 * Stable identifier used by map UI actions and location lookups.
 */
export type MapLocationKey = string;

/**
 * Supported campus map location categories.
 */
export type MapLocationType = 'building' | 'office' | 'parking' | 'layer';

/**
 * Filter option for map search results.
 */
export type MapLocationFilter = 'all' | MapLocationType;

interface RawBuildingLocation {
  key: string;
  name: string;
  category: string;
  mapUrl: string;
  aliases: string[];
  roomPrefixes: string[];
}

interface RawOfficeLocation {
  key: string;
  name: string;
  buildingKey: string;
  buildingName: string;
  category: string;
  mapUrl: string;
  officeUrl: string | null;
  room?: string | null;
  aliases: string[];
}

interface RawSimpleLocation {
  key: string;
  name: string;
  mapUrl: string;
  aliases: string[];
}

interface RawLayerLocation extends RawSimpleLocation {
  description: string;
}

interface CampusMapDataset {
  buildings: RawBuildingLocation[];
  offices: RawOfficeLocation[];
  parking: RawSimpleLocation[];
  layers: RawLayerLocation[];
}

/**
 * Normalized campus map entry derived from the raw map data file.
 */
export interface MapLocation {
  key: MapLocationKey;
  name: string;
  type: MapLocationType;
  mapUrl: string;
  aliases: string[];
  roomPrefixes: string[];
  category?: string;
  description?: string;
  buildingKey?: string;
  buildingName?: string;
  officeUrl?: string | null;
  room?: string | null;
}

/**
 * Fallback key for opening the general campus map layer.
 */
export const CAMPUS_MAP_KEY = 'layer_campus_map';

const data = campusMapData as CampusMapDataset;

/**
 * Building locations available in the campus map search index.
 */
export const MAP_BUILDINGS: MapLocation[] = data.buildings.map((building) => ({
  key: building.key,
  name: building.name,
  type: 'building',
  mapUrl: building.mapUrl,
  aliases: building.aliases,
  roomPrefixes: building.roomPrefixes,
  category: building.category,
}));

/**
 * Office locations available in the campus map search index.
 */
export const MAP_OFFICES: MapLocation[] = data.offices.map((office) => ({
  key: office.key,
  name: office.name,
  type: 'office',
  mapUrl: office.mapUrl,
  aliases: office.aliases,
  roomPrefixes: [],
  category: office.category,
  buildingKey: office.buildingKey,
  buildingName: office.buildingName,
  officeUrl: office.officeUrl,
  room: office.room ?? null,
}));

/**
 * Parking locations available in the campus map search index.
 */
export const MAP_PARKING: MapLocation[] = data.parking.map((parking) => ({
  key: parking.key,
  name: parking.name,
  type: 'parking',
  mapUrl: parking.mapUrl,
  aliases: parking.aliases,
  roomPrefixes: [],
}));

/**
 * Non-place map layers such as the full campus map.
 */
export const MAP_LAYERS: MapLocation[] = data.layers.map((layer) => ({
  key: layer.key,
  name: layer.name,
  type: 'layer',
  mapUrl: layer.mapUrl,
  aliases: layer.aliases,
  roomPrefixes: [],
  description: layer.description,
}));

/**
 * Complete campus map search index.
 */
export const MAP_LOCATIONS: MapLocation[] = [
  ...MAP_BUILDINGS,
  ...MAP_OFFICES,
  ...MAP_PARKING,
  ...MAP_LAYERS,
];

const MAP_LOCATION_BY_KEY = new Map(MAP_LOCATIONS.map((location) => [location.key, location]));
const BUILDINGS_BY_ROOM_PREFIX = new Map<string, MapLocation>();
const QUERY_STOP_WORDS = new Set([
  'where',
  'what',
  'is',
  'are',
  'the',
  'a',
  'an',
  'can',
  'i',
  'find',
  'get',
  'to',
  'of',
  'for',
  'on',
  'at',
  'in',
  'map',
  'show',
  'me',
  'location',
  'locations',
  'directions',
  'how',
  'do',
  'office',
  'offices',
  'room',
  'rooms',
  'building',
  'center',
  'hall',
]);

for (const building of MAP_BUILDINGS) {
  for (const prefix of building.roomPrefixes) {
    BUILDINGS_BY_ROOM_PREFIX.set(prefix.toUpperCase(), building);
  }
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractQueryTokens(query: string): string[] {
  return query
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => {
      if (!token) return false;
      if (/^\d+$/.test(token)) return true;
      if (token.length < 3) return false;
      return !QUERY_STOP_WORDS.has(token);
    });
}

function countTokenHits(tokens: string[], location: MapLocation): number {
  if (tokens.length === 0) return 0;
  const searchable = [
    location.name,
    location.buildingName ?? '',
    location.room ?? '',
    ...location.aliases,
  ]
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  let hits = 0;
  for (const token of tokens) {
    const boundaryMatch = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (boundaryMatch.test(searchable)) {
      hits += 1;
      continue;
    }

    if (token.endsWith('ing')) {
      const stem = token.slice(0, -3);
      if (stem.length >= 3) {
        const stemMatch = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        if (stemMatch.test(searchable)) hits += 1;
      }
    }
  }
  return hits;
}

function scoreAliasMatch(query: string, location: MapLocation): number {
  const normalizedName = normalizeQuery(location.name);
  if (query === normalizedName) return 500 + normalizedName.length;
  if (query.includes(normalizedName) && normalizedName.length >= 3) return 350 + normalizedName.length;

  let bestScore = 0;
  for (const alias of location.aliases) {
    const normalizedAlias = normalizeQuery(alias);
    if (!normalizedAlias) continue;
    if (query === normalizedAlias) {
      bestScore = Math.max(bestScore, 450 + normalizedAlias.length);
      continue;
    }

    if (normalizedAlias.length >= 3 && query.includes(normalizedAlias)) {
      bestScore = Math.max(bestScore, 300 + normalizedAlias.length);
    }
  }
  return bestScore;
}

/**
 * Resolves a room number, building prefix, office name, or raw key into a MapLocation.
 */
export function resolveMapLocation(queryOrKey?: string | null): MapLocation | null {
  if (!queryOrKey) return null;
  const raw = queryOrKey.trim();

  // 1. Exact key match
  if (MAP_LOCATION_BY_KEY.has(raw)) {
    return MAP_LOCATION_BY_KEY.get(raw) ?? null;
  }

  // 2. Direct room match in offices (e.g. C-102 matching 'Ground floor, C-Wing, C-102')
  const cleanCode = raw.toUpperCase().replace(/\s+/g, '');
  const officeRoomMatch = MAP_OFFICES.find((o) => {
    if (!o.room) return false;
    const cleanOfficeRoom = o.room.toUpperCase().replace(/\s+/g, '');
    return cleanOfficeRoom.includes(cleanCode) || cleanOfficeRoom.includes(raw.toUpperCase());
  });
  if (officeRoomMatch) return officeRoomMatch;

  // 3. Room prefix to building (e.g. C-102 -> C -> Building C, ASB-333 -> ASB, D-207 -> D)
  const roomPrefixMatch = raw.match(/^([A-Z]{1,4})-?(\d{2,4}[A-Z]?)$/i);
  if (roomPrefixMatch) {
    const prefix = roomPrefixMatch[1].toUpperCase();
    if (BUILDINGS_BY_ROOM_PREFIX.has(prefix)) {
      return BUILDINGS_BY_ROOM_PREFIX.get(prefix) ?? null;
    }
  }

  // 4. Exact building / office alias or name match
  const norm = normalizeQuery(raw);
  const directMatch = MAP_LOCATIONS.find(
    (l) => normalizeQuery(l.name) === norm || l.aliases.some((a) => normalizeQuery(a) === norm)
  );
  if (directMatch) return directMatch;

  // 5. Scored filter fallback
  const filtered = filterMapLocations(raw);
  if (filtered.length > 0) return filtered[0];

  return null;
}

/**
 * Searches map locations by name, alias, building, room, and optional location type.
 */
export function filterMapLocations(query: string, filter: MapLocationFilter = 'all'): MapLocation[] {
  const normalized = normalizeQuery(query);
  const tokens = extractQueryTokens(normalized);
  const base = filter === 'all' ? MAP_LOCATIONS : MAP_LOCATIONS.filter((location) => location.type === filter);

  if (!normalized) {
    return base;
  }

  const ranked = base
    .map((location) => {
      const aliasScore = scoreAliasMatch(normalized, location);
      const tokenHits = countTokenHits(tokens, location);

      // Require meaningful match: for multi-token queries, single-token partial matches without alias are noise
      if (tokens.length >= 2 && tokenHits < 2 && aliasScore === 0) {
        return { location, score: 0 };
      }

      let score = aliasScore;
      if (tokenHits > 0) score += tokenHits * 95;
      if (tokens.length > 0 && tokenHits === tokens.length) score += 110;
      if (location.buildingName && normalized.includes(normalizeQuery(location.buildingName))) {
        score += 80;
      }
      return { location, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.location.name.localeCompare(b.location.name))
    .map((entry) => entry.location);

  return ranked;
}
