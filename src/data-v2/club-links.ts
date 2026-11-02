import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import { placeName } from './campus-map-places';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';
import { SOURCES } from './source-seeds';

/**
 * @module data-v2/club-links
 * Clubs joined to the rest of the graph.
 *
 * - `in_category`: each Archway club or group is in the directory category Archway files it under
 *   ("Honor Society - Academic" is in "Honor Society"). A category is a `club_category` node.
 * - `listed_by`: a club whose page is in the Clubs & Organizations directory on ramapo.edu
 *   (/clubs/organization/<club>/) is listed by the office whose site that directory is (the Center
 *   for Student Involvement). The club links its page.
 * - status `inactive`: a page that says "THIS IS NOT CURRENTLY AN ACTIVE CLUB AT RAMAPO COLLEGE AS OF
 *   6/12/25" marks its club inactive as of that date. A page with no Archway club behind it is a
 *   club node of its own only when it is inactive, so a student asking about it hears it is not
 *   active; an active page no Archway club matches is reported, not made a second club.
 *
 * Pages and Archway clubs are matched by name the way map places are (placeName), uniquely.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const CLUB_PAGE = /\/clubs\/organization\/[^/]+\/$/;
const INACTIVE = /NOT CURRENTLY AN ACTIVE CLUB AT RAMAPO COLLEGE AS OF (\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;
const CLUB_KINDS = ['club', 'organization'];

export const clubCategoryId = (category: string): string =>
  uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'club_category', 'archway-clubs', category]));
export const clubPageIdentityId = (pageKey: string): string =>
  uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'club', 'office-pages', pageKey]));

function relate(entity: CampusIdentity, type: 'in_category' | 'listed_by', target: string, evidence: IdentityEvidence): void {
  entity.relationships ||= [];
  if (!entity.relationships.some(r => r.type === type && 'target_entity_id' in r && r.target_entity_id === target)) {
    entity.relationships.push({ type, target_entity_id: target, evidence: [evidence] });
  }
}

/** Category nodes and their records, and in_category for every Archway club and group with a filed category. */
export function linkClubCategories(entities: CampusIdentity[], clubs: Row[], collectedAt = ''): { entities: CampusIdentity[]; records: GraphRecordCollectionData } {
  const directory = SOURCES.find(source => source.key === 'archway-clubs')?.url ?? 'https://archway.ramapo.edu/club_signup';
  const filed = new Map<string, Set<string>>();
  const rows = new Map(clubs.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  const categories = new Map<string, CampusIdentity>();
  // Clubs and groups, and offices that are Archway groups too (Yearbook, Ramapo Green). A school's
  // clubs link lists the groups it owns, not one group of its own, so a school is never filed.
  for (const entity of entities.filter(e => [...CLUB_KINDS, 'office', 'facility'].includes(e.kind))) {
    for (const link of entity.links.filter(l => l.collection === 'clubs')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`${link.source_key}:${key}`);
        const category = text(row?.category).split(' - ')[0].trim();
        if (!row || !category) continue;
        const node = categories.get(category) ?? { id: clubCategoryId(category), kind: 'club_category', name: category, aliases: [],
          links: [{ collection: 'club_categories', source_key: 'archway-clubs', source_record_keys: [category] }] };
        categories.set(category, node);
        filed.set(category, new Set([...filed.get(category) ?? [], text(row.category)]));
        const url = text(row.website_url);
        relate(entity, 'in_category', node.id, { collection: 'clubs', source_key: link.source_key, source_record_key: key,
          ...(typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id) ? { source_record_id: row.id } : {}),
          field: 'category', ...(/^https:\/\//.test(url) ? { source_url: url } : {}) });
      }
    }
  }
  const nodes = [...categories.values()].sort((a, b) => a.name.localeCompare(b.name));
  const records: GraphRecordRow[] = nodes.map(node => ({ source_record_key: node.name, name: node.name,
    filed_as: [...filed.get(node.name) ?? []].sort(), source_url: directory }));
  return { entities: nodes, records: { source_key: 'archway-clubs', collected_at: collectedAt, rows: records } };
}

/** The ramapo.edu club directory's pages: listed_by, the page link, inactive status, and nodes for inactive clubs Archway no longer lists. */
export function linkClubPages(entities: CampusIdentity[], pages: Row[]): { entities: CampusIdentity[]; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const created: CampusIdentity[] = [];
  const named = new Map<string, CampusIdentity[]>();
  for (const entity of entities.filter(e => [...CLUB_KINDS, 'office', 'venue'].includes(e.kind))) {
    for (const name of new Set([entity.name, ...entity.aliases].map(placeName))) if (name) named.set(name, [...named.get(name) ?? [], entity]);
  }
  const owners = new Map<string, CampusIdentity[]>();
  for (const entity of entities.filter(e => e.kind === 'office')) {
    for (const link of entity.links.filter(l => l.collection === 'office_sections')) {
      for (const key of link.source_record_keys) owners.set(key, [...owners.get(key) ?? [], entity]);
    }
  }
  for (const page of pages) {
    const key = text(page.source_record_key);
    const url = text(page.url);
    if (!CLUB_PAGE.test(key) || !/^https:\/\//.test(url)) continue;
    const sections = Array.isArray(page.sections) ? page.sections as Row[] : [];
    const name = sections.map(s => text(s.heading)).find(h => h && h !== 'Related Resources')?.replace(/\*+$/, '').trim();
    if (!name) { unresolved.push({ collection: 'office_sections', record: key, reason: 'The club page names no club.', kind: 'unlinked_record' }); continue; }
    const said = INACTIVE.exec(sections.map(s => text(s.text)).join(' '));
    const asOf = said ? `${said[3].length === 2 ? `20${said[3]}` : said[3]}-${said[1].padStart(2, '0')}-${said[2].padStart(2, '0')}` : null;
    const evidence: IdentityEvidence = { collection: 'office_sections', source_key: text(page.source_key) || 'office-pages', source_record_key: key, field: said ? 'status' : 'name', source_url: url };
    const lister = owners.get(key) ?? [];
    const found = named.get(placeName(name)) ?? [];
    if (found.length > 1) { unresolved.push({ entity: name, collection: 'office_sections', record: key, reason: `The club page is named like ${found.length} nodes; nothing is linked.`, kind: 'missing_connection' }); continue; }
    // A page named like an office (SGA, Ramapo News) is that office's own; the office keeps its site.
    if (found.length === 1 && !CLUB_KINDS.includes(found[0].kind)) continue;
    let club = found[0];
    if (!club) {
      if (!asOf) { unresolved.push({ entity: name, collection: 'office_sections', record: key, reason: 'The club directory lists this club, but no Archway club has its name; no second club node is made.', kind: 'unlinked_record' }); continue; }
      club = { id: clubPageIdentityId(key), kind: 'club', name, aliases: [], links: [] };
      created.push(club);
    }
    const pageLink = club.links.find(l => l.collection === 'office_sections' && l.source_key === evidence.source_key);
    if (pageLink) { if (!pageLink.source_record_keys.includes(key)) pageLink.source_record_keys = [...pageLink.source_record_keys, key].sort(); }
    else club.links.push({ collection: 'office_sections', source_key: evidence.source_key, source_record_keys: [key] });
    if (lister.length === 1) relate(club, 'listed_by', lister[0].id, { ...evidence, field: 'name' });
    if (asOf) club.status = { state: 'inactive', as_of: asOf, evidence: [evidence] };
  }
  return { entities: created, unresolved };
}
