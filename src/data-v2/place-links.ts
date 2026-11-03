import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import { campusBuildingId, roomBuildings, type CampusBuildingsArtifact } from './campus-buildings';
import type { IdentityCoverageIssue } from './compile-campus-identities';

/**
 * @module data-v2/place-links
 * Groups and places joined where this run's own records already say how.
 *
 * - `listed_by`, by website: an Archway club or group whose website (its Archway record's
 *   `website_url`) is a page inside exactly one office's own reviewed website is listed by that
 *   office. RCNJ Baseball's ramapoathletics.com/sports/baseball is a page of Athletics'
 *   ramapoathletics.com; Transfer Connection's /studentsuccess/transfer-connection/ is a page of
 *   the Center for Student Success's /studentsuccess/. A page inside two offices' sites links
 *   neither. A website that is an office's own website, not a page inside it, is the same unit
 *   under a second name (the Cahill Career Center group and the Cahill Career Development Center):
 *   it is reported as a possible duplicate, never linked or merged.
 * - `listed_by`, by the campus map: a facility (a place the campus map lists that no office or
 *   venue is) whose map entry gives an office's own website, or a page inside exactly one office's
 *   site, is listed by that office. The map gives the Arena ramapoathletics.com (Athletics), the
 *   Board Room /president/ (the Office of the President), the Global Financial Markets Trading Lab
 *   /asb/tradinglab/ (the Anisfield School of Business). Unlike a group's, a map place's website
 *   being an office's own is no sign of a second name for the office: the map files rooms,
 *   theaters and labs under the site of the office whose space they are. Where offices' sites
 *   nest, the one holding the page most closely lists it (a hall's lounge is listed by the hall's
 *   own /reslife/<hall>/ site, not Housing's /reslife/); two offices with that same site list
 *   neither, and a place named like its office is left alone.
 * - `located_at`, by a reviewed placement (src/reference/reviewed-listings.json `placements`): an
 *   official page's section gives a node's room ("Location: C-216" on the Office of Violence
 *   Prevention's page). It holds only while this run's capture of that section still says the
 *   reviewed words, the words still give the room, and the room's reviewed prefix is the named
 *   building's. The building's published record keeps the statement as one of its
 *   `reviewed_locations`, which the link cites, as a reviewed location's does.
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const words = (value: string): string => text(value).toLowerCase();
const pageKeyOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Kinds a website places under an office: Archway clubs and groups. */
const GROUP_KINDS = ['club', 'organization'];
/** Kinds a reviewed placement can place: the kinds the campus map places in buildings. */
const PLACED_KINDS = ['office', 'venue', 'facility', 'organization', 'club', 'school'];

interface Site { host: string; path: string; url: string }

/** A web address as host and path, so one page can be read as inside another's site: lowercased, no "www.", the path ending in "/". */
export function websiteOf(value: unknown): Site | null {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase().replace(/\/{2,}/g, '/');
    return { host: parsed.hostname.toLowerCase().replace(/^www\./, ''), path: path.endsWith('/') ? path : `${path}/`, url };
  } catch {
    return null;
  }
}

function relate(entity: CampusIdentity, type: 'listed_by' | 'located_at', target: string, evidence: IdentityEvidence): boolean {
  entity.relationships ||= [];
  const held = entity.relationships.find(r => r.type === type && 'target_entity_id' in r && r.target_entity_id === target);
  if (entity.id === target) return false;
  if (held) {
    if (!held.evidence.some(e => JSON.stringify(e) === JSON.stringify(evidence))) held.evidence.push(evidence);
    return false;
  }
  entity.relationships.push({ type, target_entity_id: target, evidence: [evidence] });
  return true;
}

/** Each office's own reviewed websites: its directory contacts' evidence.website.url, the college's home page aside. */
function officeSites(entities: CampusIdentity[], contacts: Map<string, Row>): Array<{ entity: CampusIdentity; site: Site }> {
  const sites: Array<{ entity: CampusIdentity; site: Site }> = [];
  for (const entity of entities.filter(e => e.kind === 'office')) {
    const seen = new Set<string>();
    for (const link of entity.links.filter(l => l.collection === 'contacts')) {
      for (const key of link.source_record_keys) {
        const metadata = contacts.get(`${link.source_key}:${key}`)?.normalization_metadata as { evidence?: { website?: { url?: unknown } } } | undefined;
        const site = websiteOf(metadata?.evidence?.website?.url);
        // The college's own home page is every office's site; it lists no group in particular.
        if (!site || (site.path === '/' && /(^|\.)ramapo\.edu$/.test(site.host)) || seen.has(`${site.host}${site.path}`)) continue;
        seen.add(`${site.host}${site.path}`);
        sites.push({ entity, site });
      }
    }
  }
  return sites;
}

/**
 * listed_by for every Archway club or group whose website is a page inside one office's own reviewed
 * website (its directory contact's evidence.website.url). `contacts` maps `${source_key}:${source_record_key}`
 * to the contact row in this release; `clubs` are the Archway rows.
 */
export function linkGroupWebsites(entities: CampusIdentity[], clubs: Row[], contacts: Map<string, Row>): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const sites = officeSites(entities, contacts);
  const rows = new Map(clubs.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  let linked = 0;
  for (const group of entities.filter(e => GROUP_KINDS.includes(e.kind))) {
    for (const link of group.links.filter(l => l.collection === 'clubs')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`${link.source_key}:${key}`);
        const own = websiteOf(row?.website_url);
        if (!row || !own) continue;
        const others = sites.filter(s => s.entity.id !== group.id && s.site.host === own.host);
        const same = [...new Set(others.filter(s => s.site.path === own.path).map(s => s.entity.name))];
        if (same.length) {
          unresolved.push({ entity: group.name, collection: 'clubs', record: key, kind: 'note',
            reason: `Its website is the own website of ${same.map(name => `"${name}"`).join(' and ')}, so it may be the same unit under a second name; nothing is linked or merged.` });
          continue;
        }
        const inside = [...new Map(others.filter(s => own.path.startsWith(s.site.path)).map(s => [s.entity.id, s.entity])).values()];
        if (inside.length > 1) {
          unresolved.push({ entity: group.name, collection: 'clubs', record: key, kind: 'missing_connection',
            reason: `Its website is a page inside the websites of ${inside.length} offices; nothing is linked.` });
          continue;
        }
        if (inside.length !== 1) continue;
        const evidence: IdentityEvidence = { collection: 'clubs', source_key: link.source_key, source_record_key: key,
          ...(typeof row.id === 'string' && UUID.test(row.id) ? { source_record_id: row.id.toLowerCase() } : {}),
          field: 'website_url', ...(/^https:\/\//i.test(own.url) ? { source_url: own.url } : {}) };
        if (relate(group, 'listed_by', inside[0].id, evidence)) linked++;
      }
    }
  }
  return { linked, unresolved };
}

/** An official page's section placing a node in a building by the room it gives, as a person read it. */
export interface ReviewedPlacement { node: string; building: string; room: string; url: string; section: string; quote: string; reviewed_at: string; note: string }
export interface ReviewedPlacements { placements?: ReviewedPlacement[] }

/** located_at for each reviewed placement this run's capture still says, cited to the building's reviewed_locations. */
/**
 * listed_by for every map facility whose campus-map entry (its `map_places` record's `website`, the
 * map's own office link) is an office's own website or a page inside exactly one office's site.
 * `mapPlaces` are this release's map place records.
 */
export function linkFacilityWebsites(entities: CampusIdentity[], mapPlaces: Row[], contacts: Map<string, Row>): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const sites = officeSites(entities, contacts);
  const rows = new Map(mapPlaces.map(row => [text(row.source_record_key), row]));
  let linked = 0;
  for (const facility of entities.filter(e => e.kind === 'facility')) {
    for (const link of facility.links.filter(l => l.collection === 'map_places')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(key);
        const own = websiteOf(row?.website);
        if (!row || !own) continue;
        // The office whose site holds the page most closely: Bischoff Hall's /reslife/bischoff-hall/
        // over Housing & Residence Life's /reslife/.
        const holding = sites.filter(s => s.site.host === own.host && own.path.startsWith(s.site.path));
        const deepest = Math.max(0, ...holding.map(s => s.site.path.length));
        const holders = [...new Map(holding.filter(s => s.site.path.length === deepest).map(s => [s.entity.id, s.entity])).values()];
        if (holders.length > 1) {
          unresolved.push({ entity: facility.name, collection: 'map_places', record: key, kind: 'missing_connection',
            reason: `Its campus-map website is the site of ${holders.length} offices (${holders.map(e => `"${e.name}"`).join(', ')}); nothing is linked.` });
          continue;
        }
        const [office] = holders;
        if (!office || words(office.name) === words(facility.name)) continue;
        const url = text(row.source_url);
        if (relate(facility, 'listed_by', office.id, { collection: 'map_places', source_key: link.source_key, source_record_key: key,
          field: 'website', ...(/^https:\/\//.test(url) ? { source_url: url } : {}) })) linked++;
      }
    }
  }
  return { linked, unresolved };
}

export function linkReviewedPlacements(entities: CampusIdentity[], pages: Row[], reviewed: ReviewedPlacements, artifact: CampusBuildingsArtifact): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const named = new Map<string, CampusIdentity[]>();
  for (const entity of entities) named.set(entity.name, [...named.get(entity.name) ?? [], entity]);
  const byKey = new Map(pages.map(page => [text(page.source_record_key), page]));
  const byPrefix = new Map(artifact.buildings.flatMap(building => building.room_prefixes.map(prefix => [prefix, campusBuildingId(building)] as const)));
  const unresolved: IdentityCoverageIssue[] = [];
  let linked = 0;
  for (const placement of reviewed.placements ?? []) {
    const key = pageKeyOf(placement.url);
    const issue = (reason: string) => unresolved.push({ entity: placement.node, collection: 'office_sections', record: key, reason, kind: 'missing_connection' });
    const node = named.get(placement.node) ?? [];
    const buildings = artifact.buildings.filter(building => building.name === placement.building);
    if (node.length !== 1 || !PLACED_KINDS.includes(node[0].kind) || buildings.length !== 1) {
      issue(`The reviewed placement names ${placement.node} in ${placement.building}; each must be exactly one place and one building. Nothing is placed.`);
      continue;
    }
    const page = byKey.get(key);
    const sections = Array.isArray(page?.sections) ? page.sections as Row[] : [];
    if (!sections.some(section => text(section.heading) === placement.section && words(text(section.text)).includes(words(placement.quote)))) {
      issue(`The section "${placement.section}" of ${placement.url} is not in this capture or no longer says what was reviewed; the placement is withheld.`);
      continue;
    }
    // The reviewed words give the room, and the room's reviewed prefix is the named building's.
    const building = buildings[0];
    const target = campusBuildingId(building);
    const room = new RegExp(`(?<![\\w-])${placement.room.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text(placement.quote));
    const placed = roomBuildings(placement.room, byPrefix);
    if (!room || !placed || 'reason' in placed || placed.buildings.length !== 1 || placed.buildings[0] !== target) {
      issue(`The reviewed words do not give room ${placement.room}, or its prefix is not ${placement.building}'s; nothing is placed.`);
      continue;
    }
    building.reviewed_locations = [...(building.reviewed_locations ?? []),
      { entity_id: node[0].id, entity: node[0].name, statement: placement.quote, source_url: placement.url, reviewed_at: placement.reviewed_at }];
    if (relate(node[0], 'located_at', target, { collection: 'buildings', source_key: artifact.source.source_key, source_record_key: building.record_key,
      field: 'reviewed_locations', source_url: placement.url })) linked++;
  }
  return { linked, unresolved };
}

/** Both, as the compile runs them once every office, group and building is in the registry. */
export function linkPlaces(entities: CampusIdentity[], clubs: Row[], contacts: Map<string, Row>, pages: Row[], reviewed: ReviewedPlacements,
  artifact: CampusBuildingsArtifact, mapPlaces: Row[] = []): { listed_by: number; located_at: number; unresolved: IdentityCoverageIssue[] } {
  const websites = linkGroupWebsites(entities, clubs, contacts);
  const facilities = linkFacilityWebsites(entities, mapPlaces, contacts);
  const placements = linkReviewedPlacements(entities, pages, reviewed, artifact);
  return { listed_by: websites.linked + facilities.linked, located_at: placements.linked,
    unresolved: [...websites.unresolved, ...facilities.unresolved, ...placements.unresolved] };
}
