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
 *   for Student Involvement). The club links its page. A fraternity or sorority chapter whose page is
 *   on the Fraternity and Sorority Life site (/greek/chapters/<chapter>/) is listed by that office
 *   the same way, matched by the name the page gives before the chapter's Greek letters ("Alpha
 *   Kappa Alpha Sorority, Inc. - ΑΚΑ"), with "Inc." and "Incorporated" read alike. A chapter page
 *   no Archway chapter is named like is reported; its disciplinary history is not a status. A
 *   council's page there (/greek/chapters-councils/<council>/, "College Panhellenic Council (CPH)")
 *   is listed by that office too, joined to the Archway group named like the council, or else to
 *   the one whose Archway site is named by the council's abbreviation (archway.ramapo.edu/NPHC/ is
 *   the "National Pan-Hellenic Conference" group's). A council page is never joined by email: it
 *   gives its officers' own addresses, which may be a chapter's.
 * - status `inactive`: a page that says "THIS IS NOT CURRENTLY AN ACTIVE CLUB AT RAMAPO COLLEGE AS OF
 *   6/12/25" marks its club inactive as of that date. A page with no Archway club behind it is a
 *   club node of its own only when it is inactive, so a student asking about it hears it is not
 *   active; an active page no Archway club matches is reported, not made a second club.
 *
 * Pages and Archway clubs are matched by name the way map places are (placeName), uniquely. A page
 * no node is named like is matched by email: when an address the page gives is the one Archway
 * lists for exactly one group, the page is that group's ("Inter-Varsity Christian Fellowship
 * (IVCF)" and Archway's "InterVarsity Christian Fellowship" both give ivcf@ramapo.edu). An address
 * two Archway listings share (an adviser's own) names neither; a group that is an office keeps its
 * own site, as with a name.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const CLUB_PAGE = /\/clubs\/organization\/[^/]+\/$/;
// A fraternity or sorority chapter's page on the Fraternity and Sorority Life site, and a council's.
const CHAPTER_PAGE = /\/greek\/chapters\/[^/]+\/$/;
const COUNCIL_PAGE = /\/greek\/chapters-councils\/[^/]+\/$/;
// "College Panhellenic Council (CPH)": a council's name and the abbreviation its page gives it.
const ABBREVIATED = /^(.+?)\s*\(([A-Z]{2,6})\)$/;
// An Archway group's own site, "https://archway.ramapo.edu/NPHC/": the name of the site.
const ARCHWAY_SITE = /^https:\/\/archway\.ramapo\.edu\/([^/?#]+)\/?$/i;
// "Alpha Kappa Alpha Sorority, Inc. - ΑΚΑ": the chapter's Greek letters after its name.
const LETTERS = /\s+[-–]\s+\S*[\u0370-\u03ff\u1f00-\u1fff]\S*$/;
// "Inc", "Inc." and "Incorporated" end a chapter's name the same way.
const chapterName = (name: string): string => placeName(name).replace(/\s+(inc|incorporated)$/, '');
const INACTIVE = /NOT CURRENTLY AN ACTIVE CLUB AT RAMAPO COLLEGE AS OF (\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;
const CLUB_KINDS = ['club', 'organization'];
const EMAIL = /[\w.+-]+@ramapo\.edu\b/gi;

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

/**
 * The ramapo.edu club directory's pages: listed_by, the page link, inactive status, and nodes for
 * inactive clubs Archway no longer lists. `clubs` are the Archway directory rows, whose listings
 * give each group's email.
 */
export function linkClubPages(entities: CampusIdentity[], pages: Row[], clubs: Row[] = []): { entities: CampusIdentity[]; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const created: CampusIdentity[] = [];
  const named = new Map<string, CampusIdentity[]>();
  for (const entity of entities.filter(e => [...CLUB_KINDS, 'office', 'venue'].includes(e.kind))) {
    for (const name of new Set([entity.name, ...entity.aliases].map(placeName))) if (name) named.set(name, [...named.get(name) ?? [], entity]);
  }
  // Chapters by name, for the Fraternity and Sorority Life site's chapter pages.
  const chapters = new Map<string, CampusIdentity[]>();
  for (const entity of entities.filter(e => CLUB_KINDS.includes(e.kind))) {
    for (const name of new Set([entity.name, ...entity.aliases].map(chapterName))) if (name) chapters.set(name, [...chapters.get(name) ?? [], entity]);
  }
  // Each Archway group's own email: the node holding the listing, for an address one listing gives.
  const holder = new Map<string, CampusIdentity>();
  for (const entity of entities) {
    for (const link of entity.links.filter(l => l.collection === 'clubs')) for (const key of link.source_record_keys) holder.set(`${link.source_key}:${key}`, entity);
  }
  const listings = new Map<string, Row[]>();
  for (const row of clubs) {
    const email = text((row.listing as Row | undefined)?.email).toLowerCase();
    if (email) listings.set(email, [...listings.get(email) ?? [], row]);
  }
  // Each Archway group's own site name (lower case), with the club-kind nodes holding the listing.
  const sites = new Map<string, CampusIdentity[]>();
  for (const row of clubs) {
    const site = ARCHWAY_SITE.exec(text(row.website_url))?.[1]?.toLowerCase();
    const node = holder.get(`${text(row.source_key)}:${text(row.source_record_key)}`);
    if (site && node && CLUB_KINDS.includes(node.kind) && !(sites.get(site) ?? []).includes(node)) sites.set(site, [...sites.get(site) ?? [], node]);
  }
  const mailed = (email: string): CampusIdentity | undefined => {
    const rows = listings.get(email) ?? [];
    return rows.length === 1 ? holder.get(`${text(rows[0].source_key)}:${text(rows[0].source_record_key)}`) : undefined;
  };
  const owners = new Map<string, CampusIdentity[]>();
  for (const entity of entities.filter(e => e.kind === 'office')) {
    for (const link of entity.links.filter(l => l.collection === 'office_sections')) {
      for (const key of link.source_record_keys) owners.set(key, [...owners.get(key) ?? [], entity]);
    }
  }
  for (const page of pages) {
    const key = text(page.source_record_key);
    const url = text(page.url);
    const chapter = CHAPTER_PAGE.test(key);
    const council = COUNCIL_PAGE.test(key);
    if (!(CLUB_PAGE.test(key) || chapter || council) || !/^https:\/\//.test(url)) continue;
    const sections = Array.isArray(page.sections) ? page.sections as Row[] : [];
    const heading = sections.map(s => text(s.heading)).find(h => h && h !== 'Related Resources')?.replace(/\*+$/, '').trim();
    // A page of the councils section that names no one council (its list of inactive chapters) is none.
    const abbreviated = council && heading ? ABBREVIATED.exec(heading) : null;
    if (council && !abbreviated) continue;
    const name = abbreviated ? abbreviated[1] : chapter ? heading?.replace(LETTERS, '').trim() : heading;
    if (!name) { unresolved.push({ collection: 'office_sections', record: key, reason: chapter ? 'The chapter page names no chapter.' : 'The club page names no club.', kind: 'unlinked_record' }); continue; }
    const body = sections.map(s => text(s.text)).join(' ');
    // Only the club directory says a club is inactive; a chapter page's history is not a status.
    const said = CLUB_PAGE.test(key) ? INACTIVE.exec(body) : null;
    const asOf = said ? `${said[3].length === 2 ? `20${said[3]}` : said[3]}-${said[1].padStart(2, '0')}-${said[2].padStart(2, '0')}` : null;
    const evidence: IdentityEvidence = { collection: 'office_sections', source_key: text(page.source_key) || 'office-pages', source_record_key: key, field: said ? 'status' : 'name', source_url: url };
    const lister = owners.get(key) ?? [];
    let found = (chapter ? chapters.get(chapterName(name)) : named.get(placeName(name))) ?? [];
    let joined: 'name' | 'email' | 'website_url' = 'name';
    if (!found.length && abbreviated) {
      const bySite = sites.get(abbreviated[2].toLowerCase()) ?? [];
      if (bySite.length) { found = bySite; joined = 'website_url'; }
    } else if (!found.length) {
      const byEmail = [...new Set((body.match(EMAIL) ?? []).map(email => mailed(email.toLowerCase())).filter((e): e is CampusIdentity => !!e))];
      if (byEmail.length) { found = byEmail; joined = 'email'; }
    }
    if (found.length > 1) {
      unresolved.push({ entity: name, collection: 'office_sections', record: key, kind: 'missing_connection',
        reason: joined === 'email' ? `The club page gives the emails of ${found.length} Archway groups; nothing is linked.`
          : joined === 'website_url' ? `The council's abbreviation names the Archway sites of ${found.length} groups; nothing is linked.` : `The club page is named like ${found.length} nodes; nothing is linked.` });
      continue;
    }
    // A page named like an office, or giving an office's Archway email (SGA, Ramapo News), is that
    // office's own; the office keeps its site.
    if (found.length === 1 && !CLUB_KINDS.includes(found[0].kind)) continue;
    let club = found[0];
    if (!club) {
      if (chapter) { unresolved.push({ entity: name, collection: 'office_sections', record: key, reason: 'No Archway chapter has the name this chapter page gives; nothing is linked.', kind: 'unlinked_record' }); continue; }
      if (council) { unresolved.push({ entity: name, collection: 'office_sections', record: key, reason: `No Archway group has this council's name or an Archway site named ${abbreviated?.[2]}; nothing is linked.`, kind: 'unlinked_record' }); continue; }
      if (!asOf) { unresolved.push({ entity: name, collection: 'office_sections', record: key, reason: 'The club directory lists this club, but no Archway club has its name or its email; no second club node is made.', kind: 'unlinked_record' }); continue; }
      club = { id: clubPageIdentityId(key), kind: 'club', name, aliases: [], links: [] };
      created.push(club);
    }
    const pageLink = club.links.find(l => l.collection === 'office_sections' && l.source_key === evidence.source_key);
    if (pageLink) { if (!pageLink.source_record_keys.includes(key)) pageLink.source_record_keys = [...pageLink.source_record_keys, key].sort(); }
    else club.links.push({ collection: 'office_sections', source_key: evidence.source_key, source_record_keys: [key] });
    if (lister.length === 1) relate(club, 'listed_by', lister[0].id, { ...evidence, field: joined });
    if (asOf) club.status = { state: 'inactive', as_of: asOf, evidence: [evidence] };
  }
  return { entities: created, unresolved };
}
