import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import { buildingIdentityId, campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';

/**
 * @module data-v2/parking-lots
 * Campus parking lots as `parking_lot` nodes: who may park in each, and where it is.
 *
 * The lots and their facts are a reviewed list (src/reference/parking-lots.json) read from the
 * Public Safety parking pages. Each fact quotes the page; a build keeps a fact only when this
 * run's capture of that page still says the quote word for word, and reports the rest. A lot is
 * `listed_by` the office whose pages they are, and `near` the building its quote names.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export interface ReviewedParkingFact { group?: string; note?: string; page: string; quote: string }
export interface ReviewedParkingLot { name: string; aliases: string[]; facts: ReviewedParkingFact[]; near?: Array<{ building: string; page: string; quote: string }> }
export interface ReviewedParking { office: string; pages: Record<string, string>; lots: ReviewedParkingLot[] }

export const parkingLotId = (name: string): string => uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'parking_lot', 'office-pages', name]));

export function compileParkingLots(entities: CampusIdentity[], pages: Row[], reviewed: ReviewedParking, artifact: CampusBuildingsArtifact, collectedAt = ''):
  { entities: CampusIdentity[]; records: GraphRecordCollectionData; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const captured = new Map(pages.map(page => [text(page.source_record_key), page]));
  const pageText = (key: string) => {
    const page = captured.get(key);
    return page ? (Array.isArray(page.sections) ? page.sections as Row[] : []).map(s => `${text(s.heading)} ${text(s.text)}`).join(' ').replace(/\s+/g, ' ') : null;
  };
  const office = entities.filter(e => e.kind === 'office' && e.name === reviewed.office);
  const buildings = new Map<string, string>([
    ...artifact.buildings.map(b => [b.map_key, campusBuildingId(b)] as [string, string]),
    ...(artifact.complexes ?? []).map(c => [c.name, buildingIdentityId(c.concept3d_id)] as [string, string]),
  ]);
  const nodes: CampusIdentity[] = [];
  const rows: GraphRecordRow[] = [];
  for (const lot of reviewed.lots) {
    const said = (fact: { page: string; quote: string }) => {
      const key = reviewed.pages[fact.page] ?? '';
      const body = pageText(key);
      const ok = body !== null && body.includes(fact.quote.replace(/\s+/g, ' '));
      if (!ok) unresolved.push({ entity: lot.name, collection: 'office_sections', record: key,
        reason: body === null ? 'The parking page this fact quotes was not captured; the fact is left out.' : 'The parking page no longer says this; the fact is left out.', kind: 'missing_connection' });
      return ok ? { key, url: text(captured.get(key)?.url) } : null;
    };
    const facts = lot.facts.flatMap(fact => { const at = said(fact); return at ? [{ ...fact.group ? { group: fact.group } : {}, ...fact.note ? { note: fact.note } : {}, quote: fact.quote, source_url: at.url, page: at.key }] : []; });
    if (!facts.length) continue;
    const node: CampusIdentity = { id: parkingLotId(lot.name), kind: 'parking_lot', name: lot.name, aliases: [...lot.aliases].sort(),
      links: [{ collection: 'parking_lots', source_key: 'office-pages', source_record_keys: [lot.name] }] };
    const evidenceAt = (key: string, url: string, field: string): IdentityEvidence => ({ collection: 'office_sections', source_key: 'office-pages', source_record_key: key, field, ...(/^https:\/\//.test(url) ? { source_url: url } : {}) });
    node.relationships = [];
    if (office.length === 1) {
      const pagesSaid = [...new Map(facts.map(fact => [fact.page, fact.source_url])).entries()];
      node.relationships.push({ type: 'listed_by', target_entity_id: office[0].id, evidence: pagesSaid.map(([key, url]) => evidenceAt(key, url, 'sections')) });
    }
    for (const near of lot.near ?? []) {
      const at = said(near);
      const building = buildings.get(near.building);
      if (!at) continue;
      if (!building) { unresolved.push({ entity: lot.name, collection: 'buildings', record: near.building, reason: 'The building this lot is near is not on the campus map.', kind: 'missing_connection' }); continue; }
      if (!node.relationships.some(r => r.type === 'near' && 'target_entity_id' in r && r.target_entity_id === building)) {
        node.relationships.push({ type: 'near', target_entity_id: building, evidence: [evidenceAt(at.key, at.url, 'sections')] });
      }
    }
    if (!node.relationships.length) delete node.relationships;
    nodes.push(node);
    rows.push({ source_record_key: lot.name, name: lot.name, aliases: node.aliases,
      open_to: [...new Set(facts.flatMap(fact => fact.group ? [fact.group] : []))],
      facts: facts.map(({ page: _page, ...fact }) => fact), source_url: facts[0].source_url });
  }
  const capturedAt = collectedAt || Object.values(reviewed.pages).map(key => text(captured.get(key)?.collected_at)).filter(Boolean).sort().pop() || '';
  return { entities: nodes, records: { source_key: 'office-pages', collected_at: capturedAt, rows }, unresolved };
}
