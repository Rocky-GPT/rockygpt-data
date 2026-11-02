import type { CampusIdentity } from './campus-identities';
import { buildingIdentityId, campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import { placeName } from './campus-map-places';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';
import { SOURCES } from './source-seeds';

/**
 * @module data-v2/graph-links
 * Links read from records the release already holds:
 *
 * - `handled_by`: a topic (Scholarships, Summer Session) to each office its reviewed row names in
 *   `handled_by`, by exact name.
 * - Shuttle stops as `stop` nodes: a route `stops_at` each stop its timetable page describes, and a
 *   campus stop ("Ramapo College (Bradley Center)") is `located_at` the building it names.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export const stopIdentityId = (name: string): string => uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'stop', 'transportation', name]));

/** handled_by from each topic's own row to the offices it names. */
export function linkTopicOffices(entities: CampusIdentity[], topics: Row[]): void {
  const offices = new Map<string, CampusIdentity[]>();
  for (const office of entities.filter(e => e.kind === 'office' || e.kind === 'venue')) offices.set(office.name, [...offices.get(office.name) ?? [], office]);
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
export function compileStops(entities: CampusIdentity[], stops: Row[], artifact: CampusBuildingsArtifact, map: unknown, collectedAt = ''): { entities: CampusIdentity[]; records: GraphRecordCollectionData } {
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
