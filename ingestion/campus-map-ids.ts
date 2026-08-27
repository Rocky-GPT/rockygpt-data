/**
 * @module ingestion/campus-map-ids
 * Points every campus-map link at the map Ramapo actually runs.
 *
 * The college rebuilt the map on Concept3D and left `www.ramapo.edu/map/` as a
 * 429-byte stub whose whole body is a meta-refresh — to one fixed URL. It
 * discards the query string, so all 207 of our links, every building and every
 * layer, landed on the identical default view. The map drew, so nothing looked
 * broken; it simply stopped answering the question that was asked.
 *
 * The new scheme addresses a place by id rather than by name:
 *
 *     #!m/<locationId>     one place        (Birch Tree Inn Dining = 1218379)
 *     #!ce/<categoryId>    a whole category (Food and Dining      =  108795)
 *
 * Resolution is exact name, then an alias the data owns, and nothing else.
 * No fuzzy matching and no taking whichever result a search ranked first:
 * their search answers "Running Track and Stadium Field" with the softball
 * field, and a pin on the wrong field is worse than the plain campus map,
 * because it looks like an answer. Anything unresolved keeps the plain map.
 */

import fs from 'fs';
import path from 'path';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import aliasData from '../src/reference/campus-map-aliases.json';

const MAP_ID = '2292';
/** Public read key, served in the map's own client bundle. */
const API_KEY = '0001085cc708b9cef47080f064612ca5';
const API = 'https://api.concept3d.com';
const MAP_BASE = `https://map.ramapo.edu/?id=${MAP_ID}`;
const DATA_FILE = path.join(process.cwd(), 'data', 'map', 'campus-map-data.json');
const RAW_OUT = path.join(process.cwd(), 'data', 'raw', 'campus-map-concept3d.raw.json');

/** Category holding building geometry rather than a place worth pinning. */
const GEOMETRY_CATEGORY = 100767;

/** Layers whose content the new map no longer carries at all. */
const RETIRED_LAYERS = new Set(['layer_emergency_phones', 'layer_aed', 'layer_pabc']);

/** The whole-campus view. The plain map is the destination, not a shortfall. */
const BASE_MAP_LAYER = 'layer_campus_map';

interface Concept3dLocation {
  id: number;
  name?: string;
  catId?: number;
  lat?: number;
  lng?: number;
}
interface Concept3dCategory {
  catId?: number;
  id?: number;
  name?: string;
}

interface MapRecord {
  key: string;
  name: string;
  mapUrl: string;
  [more: string]: unknown;
}
interface MapDataFile {
  generatedAt?: string;
  source?: string;
  counts?: Record<string, number>;
  buildings: MapRecord[];
  offices: (MapRecord & { buildingName?: string })[];
  parking: MapRecord[];
  layers: MapRecord[];
}

/** `$comment` keys carry the reasoning; they are notes, not mappings. */
function mappings(section: unknown): Record<string, string> {
  const entries = Object.entries((section ?? {}) as Record<string, unknown>);
  return Object.fromEntries(
    entries.filter(([key, value]) => key !== '$comment' && typeof value === 'string')
  ) as Record<string, string>;
}

const alias = aliasData as { locations?: unknown; categories?: unknown };
const aliases = {
  locations: mappings(alias.locations),
  categories: mappings(alias.categories),
};

const STOPWORDS = new Set(['the', 'of', 'and', 'at', 'for']);

/** Compares names the way a person would: case, spacing and filler ignored. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !STOPWORDS.has(word))
    .join(' ');
}

async function get<T>(path: string): Promise<T> {
  const response = await fetchWithPolicy(
    `${API}/${path}${path.includes('?') ? '&' : '?'}key=${API_KEY}`,
    { headers: { accept: 'application/json' } },
    { expectedContentTypes: ['application/json'], maxResponseBytes: 16 * 1024 * 1024 }
  );
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json() as T;
}

/**
 * One id per name, or none.
 *
 * Most places appear more than once — as building geometry, and again as the
 * pin each category it belongs to shows. The pin is what the map's own
 * navigation opens, so pins win over geometry.
 *
 * Several pins sharing a name is usually one place cross-listed rather than
 * two places confused: the Public Safety Booth is filed under both
 * Administrative and Campus Services at one set of coordinates, and either id
 * opens the same card. Standing on the same spot is what says so, and the
 * lowest id then picks between them so the answer never drifts between runs.
 * Pins that share a name at *different* coordinates are two real places and
 * resolve to nothing, because there is no way to tell which was meant.
 */
function indexByName(locations: Concept3dLocation[]): Map<string, number> {
  const grouped = new Map<string, Concept3dLocation[]>();
  for (const location of locations) {
    const key = normalize(location.name ?? '');
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), location]);
  }
  const index = new Map<string, number>();
  for (const [key, rows] of grouped) {
    const pins = rows.filter((row) => row.catId !== GEOMETRY_CATEGORY);
    const chosen = pins.length ? pins : rows;
    const places = new Set(chosen.map((row) => `${row.lat},${row.lng}`));
    if (places.size === 1) {
      index.set(key, Math.min(...chosen.map((row) => row.id)));
    }
  }
  return index;
}

function indexCategories(categories: Concept3dCategory[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const category of categories) {
    const key = normalize(category.name ?? '');
    const id = category.catId ?? category.id;
    if (key && id && !index.has(key)) index.set(key, id);
  }
  return index;
}

export interface Resolution {
  url: string;
  how: 'exact' | 'alias' | 'category' | 'unresolved';
}

/** The URL a record should carry, and why it carries it. */
export function resolve(
  name: string,
  locations: Map<string, number>,
  categories: Map<string, number>
): Resolution {
  const exact = locations.get(normalize(name));
  if (exact) return { url: `${MAP_BASE}#!m/${exact}`, how: 'exact' };

  const aliased = aliases.locations[name];
  if (aliased) {
    const id = locations.get(normalize(aliased));
    if (id) return { url: `${MAP_BASE}#!m/${id}`, how: 'alias' };
  }

  const category = aliases.categories[name];
  if (category) {
    const id = categories.get(normalize(category));
    if (id) return { url: `${MAP_BASE}#!ce/${id}`, how: 'category' };
  }

  return { url: MAP_BASE, how: 'unresolved' };
}

async function main(): Promise<void> {
  const [locations, categories] = await Promise.all([
    get<Concept3dLocation[]>(`locations?map=${MAP_ID}`),
    get<Concept3dCategory[]>(`categories?map=${MAP_ID}`),
  ]);
  writeJsonFile(RAW_OUT, { locations, categories });
  writeRawProvenance('campus-map-concept3d', {
    sourceUrl: `${API}/locations?map=${MAP_ID}`,
    payload: { locationCount: locations.length, categoryCount: categories.length },
  });

  const byName = indexByName(locations);
  const byCategory = indexCategories(categories);
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as MapDataFile;
  const tally: Record<Resolution['how'], number> = {
    exact: 0,
    alias: 0,
    category: 0,
    unresolved: 0,
  };
  const unresolved: string[] = [];

  // An office was never its own pin: its link has always opened the building
  // that holds it, which is the question "where is this office" really asks.
  data.layers = data.layers.filter((layer) => !RETIRED_LAYERS.has(layer.key));
  for (const group of [data.buildings, data.parking, data.layers] as MapRecord[][]) {
    for (const record of group) {
      if (record.key === BASE_MAP_LAYER) {
        record.mapUrl = MAP_BASE;
        continue;
      }
      const { url, how } = resolve(record.name, byName, byCategory);
      record.mapUrl = url;
      tally[how] += 1;
      if (how === 'unresolved') unresolved.push(record.name);
    }
  }
  for (const office of data.offices) {
    const { url, how } = resolve(office.buildingName ?? office.name, byName, byCategory);
    office.mapUrl = url;
    tally[how] += 1;
    if (how === 'unresolved') unresolved.push(`${office.name} (via ${office.buildingName})`);
  }

  data.source = `${API}/locations?map=${MAP_ID}`;
  data.generatedAt = new Date().toISOString();
  data.counts = {
    buildings: data.buildings.length,
    offices: data.offices.length,
    parking: data.parking.length,
    layers: data.layers.length,
  };
  writeJsonFile(DATA_FILE, data);

  const total = Object.values(tally).reduce((sum, count) => sum + count, 0);
  console.log(
    `Resolved ${total - tally.unresolved} of ${total} map links ` +
      `(${tally.exact} by name, ${tally.alias} by alias, ${tally.category} to a category).`
  );
  if (unresolved.length) {
    console.log(`Keeping the plain campus map for ${unresolved.length}:`);
    for (const name of unresolved) console.log(`  ${name}`);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
