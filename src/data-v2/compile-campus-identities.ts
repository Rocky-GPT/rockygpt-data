import { load } from 'cheerio';
import type { PoolClient } from 'pg';
import { CURRENT_MENU_VENUE_NAME } from './dining-venues';
import profileUrlAliases from '../reference/campus-identity-url-aliases.json';
import { compileArchwayIdentities, normalizeName, type ArchwayIdentityInputs, type EventOrganizersArtifact } from './archway-identities';
import { validateCampusIdentities, type CampusIdentities, type CampusIdentity, type CampusIdentityLink, type IdentityCollection } from './campus-identities';
import { campusBuildingsArtifact, compileBuildingIdentities, type CampusBuildingsArtifact } from './campus-buildings';
import { campusSchoolsArtifact, compileSchoolIdentities, type CampusSchoolsArtifact, type ReviewedSchools } from './campus-schools';
import { aliasRecords, applyPublishedAliases, applyReviewedAliases, noteAlias, type AliasLedger, type AliasRecord, type ReviewedAlias } from './identity-aliases';
import type { ReviewedBuilding } from './campus-buildings';
import { compileCourseIdentities, type CourseIdentitiesArtifact } from './course-identities';
import { compileSubjectIdentities, courseSubjectsArtifact, type CourseSubjectsArtifact, type CourseSubjectsInput } from './course-subjects';
import { GRADUATION_PLANS_SOURCE_KEY, graduationPlansInput } from './graduation-plans';
import { MAJOR_PAGES_SOURCE_KEY, majorPagesInput } from './major-pages';
import { compileRequirementGroups, type RequirementGroupsArtifact } from './requirement-groups';
import { legacyProgramRecordKey, programRecordKey } from './program-records';

type Row = Record<string, unknown>;
export interface IdentitySnapshot {
  campus_contacts: Row[]; campus_hours: Row[]; dining_hours: Row[]; menu_items: Row[]; programs: Row[];
  clubs?: Row[]; events?: Row[];
  artifacts: Record<string, unknown>;
}
/** What a coverage issue means for lookups: `unlinked_record`, an original record no identity
 * links; `missing_connection`, an identity missing one of its links, relationships or
 * references; `no_records`, a reviewed or listed entry with no record in this release;
 * `note`, a naming or interpretation note. The reason says why. */
export type CoverageKind = 'unlinked_record' | 'missing_connection' | 'no_records' | 'note';
export interface IdentityCoverageIssue { entity?: string; collection: string; record?: string; reason: string; kind: CoverageKind }
export interface IdentityCoverageReport {
  identity_count: number; identities_by_kind: Record<string, number>; linked_records: Record<string, number>;
  relationships: Record<string, number>; unresolved: IdentityCoverageIssue[];
  /** Aliases a person approved, kept apart from source-derived evidence. */
  human_reviewed_aliases?: { entity_id: string; entity: string; alias: string; basis: 'human_reviewed'; reviewed_at: string }[];
  /** Every alias in the registry, with the rule and evidence that put it there. */
  alias_sources: AliasRecord[];
}
interface Candidate { collection: IdentityCollection; source: string; key: string; row: Row; anchors: string[] }
export const canonicalProfileUrl = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
const string = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const email = (v: unknown): string => string(v).toLowerCase();
export function facultyRecordKey(row: Row): string {
  const url = canonicalProfileUrl(row.profileUrl);
  return `${url}${email(row.email) ? `#email=${email(row.email)}` : `#name=${encodeURIComponent(string(row.name))}`}`;
}
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Row[] : [];
export function programArtifactRows(value: unknown): Row[] {
  return list((value as Row)?.schools).flatMap(school => list(school.majors).map(p => ({ ...p, school: school.school, source_record_key: programRecordKey(p, school.school) })));
}
function slug(value: unknown): string { return string(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

export function identityCandidates(snapshot: IdentitySnapshot): Candidate[] {
  const faculty = list(snapshot.artifacts.faculty);
  const urlCounts = new Map<string, number>();
  const emailCounts = new Map<string, number>();
  for (const row of faculty) {
    const url = canonicalProfileUrl(row.profileUrl); if (url) urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
    const e = email(row.email); if (e) emailCounts.set(e, (emailCounts.get(e) || 0) + 1);
  }
  const personAnchors = (row: Row): string[] => [
    ...(email(row.email) && emailCounts.get(email(row.email)) === 1 ? [`email:${email(row.email)}`] : []),
    ...(urlCounts.get(canonicalProfileUrl(row.profileUrl)) === 1 ? [`url:${canonicalProfileUrl(row.profileUrl)}`] : []),
  ];
  const result: Candidate[] = faculty.map(row => ({ collection: 'faculty', source: 'faculty', key: facultyRecordKey(row), row, anchors: personAnchors(row) }));
  // A faculty contact is derived by the publisher from this precise original
  // profile row. Matching the derivation key plus email is provenance, not a
  // runtime name guess; conflicts on other fields remain in their source rows.
  for (const row of snapshot.campus_contacts) {
    const source = string(row.source_key);
    const originals = source === 'faculty' ? faculty.filter(f =>
      row.source_record_key === `faculty:${slug(f.name)}:${slug(f.school) || 'unknown-school'}` &&
      (!email(row.email) || !email(f.email) || email(row.email) === email(f.email))
    ) : [];
    result.push({ collection: 'contacts', source, key: string(row.source_record_key), row,
      anchors: source === 'faculty' && originals.length === 1 ? personAnchors(originals[0]) : [
        `key:${row.source_record_key}`,
        ...(email(row.email) && snapshot.campus_contacts.filter(c => c.source_key === source && email(c.email) === email(row.email)).length === 1 ? [`email:${email(row.email)}`] : []),
      ] });
  }
  for (const [collection, rows] of [['campus_hours', snapshot.campus_hours], ['dining_hours', snapshot.dining_hours], ['menu', snapshot.menu_items], ['programs', snapshot.programs]] as const) {
    for (const row of rows) result.push({ collection, source: string(row.source_key), key: string(row.source_record_key), row, anchors: [] });
  }
  const programs = programArtifactRows(snapshot.artifacts.programs);
  for (const candidate of result.filter(r => r.collection === 'programs')) {
    const artifacts = programs.filter(p => p.source_record_key === candidate.key || legacyProgramRecordKey(p, p.school) === candidate.key);
    // Preserve historical display keys only when unique. New publication keys
    // carry the catalog code and distinguish same-name degree paths.
    if (artifacts.length === 1) candidate.row = { ...candidate.row, ...artifacts[0] };
  }
  return result;
}
function matches(candidate: Candidate, link: CampusIdentityLink): boolean {
  if (candidate.collection !== link.collection || candidate.source !== link.source_key) return false;
  const selector = link.selector;
  if (!selector) return link.source_record_keys.includes(candidate.key);
  switch (selector.field) {
    case 'faculty_identity': case 'contact_identity': return selector.values.some(value => candidate.anchors.includes(value));
    case 'name': return selector.values.includes(string(candidate.row.name));
    case 'catalog_code': return selector.values.includes(string(candidate.row.catalogCode));
    case 'menu_venue': return candidate.collection === 'menu' && selector.values.includes(CURRENT_MENU_VENUE_NAME);
  }
}
/** rJQmj is the catalog's Convener field, distinct from xiQxl Program Faculty.
 * The reviewed field mapping is documented in docs/campus-identities.md. Never
 * scan other custom fields or accept the old first-faculty fallback as evidence.
 */
const CATALOG_PERSON_FIELDS = ['rJQmj', 'xiQxl'] as const;
export const explicitCatalogConveners = (raw: unknown) => explicitCatalogProfileLinks(raw, 'rJQmj');
export const explicitCatalogProgramFaculty = (raw: unknown) => explicitCatalogProfileLinks(raw, 'xiQxl');
function explicitCatalogProfileLinks(raw: unknown, field: typeof CATALOG_PERSON_FIELDS[number]): Map<string, { profileUrl: string; name: string }[]> {
  const result = new Map<string, { profileUrl: string; name: string }[]>();
  for (const program of list((raw as Row)?.programs)) {
    const value = (program.customFields as Row)?.[field];
    if (typeof value !== 'string') continue;
    const $ = load(value); const found: { profileUrl: string; name: string }[] = [];
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href') || '';
      try {
        const url = new URL(href, 'https://www.ramapo.edu');
        if (url.hostname !== 'www.ramapo.edu' || !url.pathname.includes('/faculty/')) return;
        const profileUrl = canonicalProfileUrl(url.toString());
        if (!found.some(p => p.profileUrl === profileUrl)) found.push({ profileUrl, name: $(element).text().trim() });
      } catch { /* Unsupported URLs do not establish a person relationship. */ }
    });
    result.set(string(program.code), found);
  }
  return result;
}
export function catalogConvenersArtifact(raw: unknown): Record<string, unknown> {
  const capture = raw as Row | undefined;
  return {
    collected_at: string(capture?.scrapedAt) || null,
    source_url: 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos/programs/search/%24filters',
    programs: list(capture?.programs).flatMap(program => {
      // Only the reviewed person fields, verbatim; other custom fields are not evidence.
      const fields = program.customFields as Row | undefined;
      const customFields = Object.fromEntries(CATALOG_PERSON_FIELDS.flatMap(field => typeof fields?.[field] === 'string' ? [[field, fields[field]]] : []));
      return Object.keys(customFields).length ? [{ catalogCode: string(program.code), catalogUrl: `https://catalog.ramapo.edu/programs/${program.code}`, customFields }] : [];
    }),
  };
}
/** Compile a curated map against exactly the candidate release, never a stale
 * export. Selectors remain in Git; consumers receive concrete record references.
 * A lost selector is reported, not replaced by a similarity/phone-number guess.
 */
export interface CompiledIdentityArtifacts {
  registry: CampusIdentities; report: IdentityCoverageReport; eventOrganizers: EventOrganizersArtifact;
  courseIdentities: CourseIdentitiesArtifact; requirementGroups: RequirementGroupsArtifact;
  campusBuildings: CampusBuildingsArtifact; campusSchools: CampusSchoolsArtifact; courseSubjects: CourseSubjectsArtifact;
}
/** Inputs outside the release snapshot: Archway captures, the committed campus map, the reviewed schools and the catalog's subject list. */
export interface IdentityInputs extends ArchwayIdentityInputs {
  campusMap?: unknown; campusSchools?: ReviewedSchools; courseSubjects?: CourseSubjectsInput;
  identityReviews?: { aliases?: ReviewedAlias[]; buildings?: ReviewedBuilding[] };
  /** The published graduation plans artifact, whose plans name their programs' catalog codes. */
  graduationPlans?: unknown;
  /** The published program pages artifact, whose pages name their own programs' catalog codes. */
  majorPages?: unknown;
}
export function compileCampusIdentities(seed: CampusIdentities, snapshot: IdentitySnapshot, rawPrograms?: unknown, inputs: IdentityInputs = {}): CompiledIdentityArtifacts {
  validateCampusIdentities(seed);
  const candidates = identityCandidates(snapshot);
  const unresolved: IdentityCoverageIssue[] = [];
  const entities: CampusIdentity[] = [];
  const owners = new Map<string, string>();
  // Names a reviewed place already answers to, including the department its own
  // contact record publishes (the Library's is "Potter Library"). An Archway group
  // with one of these names needs a reviewed link rather than a second identity.
  const reserved = new Set<string>();
  const ledger: AliasLedger = new Map();
  for (const entity of seed.entities) {
    const links: CampusIdentityLink[] = [];
    const displayNames = new Set(entity.aliases);
    for (const alias of entity.aliases) noteAlias(ledger, entity.id, alias, { basis: 'identity_map' });
    for (const link of entity.links) {
      const found = candidates.filter(candidate => matches(candidate, link));
      if (link.selector && ['faculty_identity', 'contact_identity'].includes(link.selector.field) && new Set(found.map(row => row.key)).size > 1) {
        unresolved.push({ entity: entity.name, collection: link.collection, reason: 'Identity anchors resolve to multiple distinct subjects (for example a reused email and retained profile URL); no link is approved.', kind: 'missing_connection' });
        continue;
      }
      if (!found.length) {
        unresolved.push({ entity: entity.name, collection: link.collection, reason: 'No current source row satisfies the reviewed selector. The seed is retained, but an identity is published only if another verified record link resolves.', kind: 'no_records' });
        continue;
      }
      if (!link.selector) for (const key of link.source_record_keys) if (!found.some(c => c.key === key)) {
        unresolved.push({ entity: entity.name, collection: link.collection, record: key, reason: 'Broken original record link in this release.', kind: 'no_records' });
      }
      for (const row of found) {
        const key = `${row.collection}:${row.source}:${row.key}`;
        if (owners.has(key) && owners.get(key) !== entity.id) throw new Error(`Conflicting identity ownership of ${key}.`);
        owners.set(key, entity.id);
        if (row.collection !== 'menu' && string(row.row.name) !== entity.name && string(row.row.name)) {
          displayNames.add(string(row.row.name));
          noteAlias(ledger, entity.id, string(row.row.name), { basis: 'record_name', evidence: { collection: row.collection, source_key: row.source, source_record_key: row.key, field: 'name' } });
        }
        if (row.collection === 'contacts' && ['office', 'facility', 'venue'].includes(entity.kind) && string(row.row.department)) reserved.add(normalizeName(string(row.row.department)));
      }
      links.push({ collection: link.collection, source_key: link.source_key, source_record_keys: [...new Set(found.map(r => r.key))].sort() });
    }
    if (links.length) entities.push({ id: entity.id, kind: entity.kind, name: entity.name, aliases: [...displayNames].slice(0, 32), links });
  }
  // Records that name their programs by catalog code: a recommended graduation plan names its
  // major's code, and a public program page the codes it links as its own. A program links
  // every record that names one of its own catalog codes, and a record no program takes is
  // reported. The publisher passes what it publishes; an offline compile reads the release's own.
  const artifacts = snapshot.artifacts as Record<string, unknown> | undefined;
  // A linked program record's catalog code, which older releases do not carry in its key.
  const programCodes = new Map(candidates.filter(candidate => candidate.collection === 'programs')
    .map(candidate => [candidate.key, string(candidate.row.catalogCode)]));
  const linkByCatalogCode = (collection: IdentityCollection, sourceKey: string,
    records: Array<{ id: string; programCodes: string[]; limitations: string[] }>, noun: string, unlinked: string) => {
    const byCode = new Map<string, string[]>();
    for (const record of records) for (const code of record.programCodes) byCode.set(code, [...(byCode.get(code) ?? []), record.id]);
    const linked = new Set<string>();
    for (const entity of entities.filter(candidate => candidate.kind === 'program')) {
      const codes = entity.links.filter(link => link.collection === 'programs').flatMap(link => link.source_record_keys)
        .map(key => programCodes.get(key)).filter((code): code is string => Boolean(code));
      const ids = [...new Set(codes.flatMap(code => byCode.get(code) ?? []))].sort();
      if (!ids.length) continue;
      entity.links.push({ collection, source_key: sourceKey, source_record_keys: ids });
      for (const id of ids) linked.add(id);
    }
    for (const record of records.filter(candidate => !linked.has(candidate.id))) {
      unresolved.push({ collection, record: record.id, reason: record.programCodes.length
        ? `No program identity has the catalog code ${record.programCodes.join(', ')} this ${noun} names.`
        : record.limitations.join(' ') || unlinked, kind: 'unlinked_record' });
    }
  };
  linkByCatalogCode('graduation_plans', GRADUATION_PLANS_SOURCE_KEY,
    graduationPlansInput(inputs.graduationPlans ?? artifacts?.['graduation-plans']), 'plan',
    'The plan index links this plan to no catalog program.');
  linkByCatalogCode('major_pages', MAJOR_PAGES_SOURCE_KEY,
    majorPagesInput(inputs.majorPages ?? artifacts?.['major-pages']), 'page',
    'The page links no catalog program of its own.');
  const registry: CampusIdentities = { schema_version: 1, entities };
  const courses = snapshot.artifacts.courses as Record<string, unknown> || {};
  const facultyByKey = new Map(candidates.filter(c => c.collection === 'faculty').map(c => [c.key, c]));
  const personByUrl = new Map<string, Set<string>>();
  for (const entity of entities.filter(e => e.kind === 'person')) {
    for (const key of entity.links.filter(l => l.collection === 'faculty').flatMap(l => l.source_record_keys)) {
      const faculty = facultyByKey.get(key); if (!faculty) continue;
      const url = canonicalProfileUrl(faculty.row.profileUrl);
      const ids = personByUrl.get(url) || new Set<string>(); ids.add(entity.id); personByUrl.set(url, ids);
      for (const course of listStrings(faculty.row.courses)) {
        const codes = [...course.matchAll(/\b([A-Z]{3,5})\s*-?\s*(\d{3})\b/g)].map(m => `${m[1]} ${m[2]}`);
        if (!codes.length) {
          unresolved.push({ entity: entity.name, collection: 'courses', record: course, reason: 'Undated profile course title has no explicit catalog code; title similarity does not establish a catalog link.', kind: 'missing_connection' });
        }
        for (const code of codes) {
          if (!(code in courses)) {
            unresolved.push({ entity: entity.name, collection: 'courses', record: course, reason: `Explicit code ${code} is absent from this release catalog.`, kind: 'missing_connection' }); continue;
          }
          entity.relationships ||= [];
          if (entity.relationships.some(r => r.type === 'profile_course' && r.target_record.source_record_key === code)) continue;
          entity.relationships.push({ type: 'profile_course', target_record: { collection: 'courses', source_key: 'academic-programs', source_record_key: code }, evidence: [{ collection: 'faculty', source_key: 'faculty', source_record_key: key, field: 'courses', source_url: string(faculty.row.profileUrl) }] });
        }
      }
    }
  }
  const conveners = explicitCatalogConveners(rawPrograms);
  const programFaculty = explicitCatalogProgramFaculty(rawPrograms);
  const reviewedUrl = (url: string) => profileUrlAliases.aliases.find(alias => alias.from === url)?.to || url;
  const programCandidates = candidates.filter(c => c.collection === 'programs');
  for (const entity of entities.filter(e => e.kind === 'program')) {
    for (const key of entity.links.filter(l => l.collection === 'programs').flatMap(l => l.source_record_keys)) {
      const candidate = programCandidates.find(p => p.key === key); if (!candidate) continue;
      const code = string(candidate.row.catalogCode); const explicit = conveners.get(code) || [];
      const sourceUrl = string(candidate.row.catalogUrl) || `https://catalog.ramapo.edu/programs/${code}`;
      if (!explicit.length) unresolved.push({ entity: entity.name, collection: 'programs', record: key, reason: 'No explicit catalog Convener-field profile link; normalized convener may be a legacy first-faculty fallback and is not approved.', kind: 'missing_connection' });
      for (const convener of explicit) {
        const ids = personByUrl.get(reviewedUrl(convener.profileUrl));
        if (ids?.size !== 1) {
          unresolved.push({ entity: entity.name, collection: 'programs', record: key, reason: `Explicit convener profile URL ${convener.profileUrl} resolves to ${ids?.size || 0} person identities.`, kind: 'missing_connection' }); continue;
        }
        entity.relationships ||= [];
        entity.relationships.push({ type: 'convener', target_entity_id: [...ids][0], evidence: [{ collection: 'programs', source_key: 'academic-programs', source_record_key: key, field: 'customFields.rJQmj', source_url: sourceUrl }] });
      }
      // The published faculty array mixes these fields with name matches and a scraper
      // fallback; only the explicit Program Faculty field is evidence of a listing.
      const listed = programFaculty.get(code) || [];
      if (!listed.length) unresolved.push({ entity: entity.name, collection: 'programs', record: key, reason: 'No explicit catalog Program Faculty-field profile link.', kind: 'missing_connection' });
      for (const person of listed) {
        const ids = personByUrl.get(reviewedUrl(person.profileUrl));
        if (ids?.size !== 1) {
          unresolved.push({ entity: entity.name, collection: 'programs', record: key, reason: `Explicit Program Faculty profile URL ${person.profileUrl} resolves to ${ids?.size || 0} person identities.`, kind: 'missing_connection' }); continue;
        }
        const target = [...ids][0];
        entity.relationships ||= [];
        // An old and a current URL for one person are one listing.
        if (entity.relationships.some(r => r.type === 'listed_faculty' && r.target_entity_id === target)) continue;
        entity.relationships.push({ type: 'listed_faculty', target_entity_id: target, evidence: [{ collection: 'programs', source_key: 'academic-programs', source_record_key: key, field: 'customFields.xiQxl', source_url: sourceUrl }] });
      }
    }
  }
  for (const candidate of candidates) if (!owners.has(`${candidate.collection}:${candidate.source}:${candidate.key}`)) {
    unresolved.push({ collection: candidate.collection, record: candidate.key, reason: 'No reviewed persistent identity selector covers this original record; existing search remains available.', kind: 'unlinked_record' });
  }
  const recordRows = new Map(candidates.map(c => [`${c.collection}:${c.source}:${c.key}`, c.row]));
  const schools = compileSchoolIdentities(entities, recordRows, snapshot.clubs || [], inputs.campusSchools, ledger);
  entities.push(...schools.schools);
  unresolved.push(...schools.unresolved);
  for (const name of entities.flatMap(entity => [entity.name, ...entity.aliases])) reserved.add(normalizeName(name));
  const archway = compileArchwayIdentities(snapshot, inputs, reserved, schools.ownedClubs, ledger);
  entities.push(...archway.entities);
  unresolved.push(...archway.unresolved);
  const campusBuildings = campusBuildingsArtifact(inputs.campusMap, inputs.identityReviews?.buildings);
  const contactRows = new Map(candidates.filter(c => c.collection === 'contacts').map(c => [`${c.source}:${c.key}`, c.row]));
  const places = compileBuildingIdentities(campusBuildings, entities, contactRows);
  entities.push(...places.buildings);
  unresolved.push(...places.unresolved);
  const subjects = courseSubjectsArtifact(snapshot.artifacts.courses, inputs.courseSubjects);
  entities.push(...compileSubjectIdentities(subjects.artifact, snapshot.artifacts.courses, ledger));
  unresolved.push(...subjects.unresolved);
  applyPublishedAliases(entities, recordRows, ledger);
  const reviewedAliases = applyReviewedAliases(entities, inputs.identityReviews?.aliases ?? [], ledger);
  unresolved.push(...reviewedAliases.unresolved);
  validateCampusIdentities(registry);
  unresolved.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const report: IdentityCoverageReport = { identity_count: entities.length, identities_by_kind: {}, linked_records: {}, relationships: {}, unresolved, alias_sources: aliasRecords(entities, ledger) };
  if (reviewedAliases.applied.length) report.human_reviewed_aliases = reviewedAliases.applied;
  for (const entity of entities) {
    report.identities_by_kind[entity.kind] = (report.identities_by_kind[entity.kind] || 0) + 1;
    for (const link of entity.links) report.linked_records[link.collection] = (report.linked_records[link.collection] || 0) + link.source_record_keys.length;
    for (const relation of entity.relationships || []) report.relationships[relation.type] = (report.relationships[relation.type] || 0) + 1;
  }
  const courseIdentities = compileCourseIdentities(snapshot.artifacts.courses);
  const requirementGroups = compileRequirementGroups(snapshot.artifacts.programs, registry, courseIdentities);
  return { registry, report, eventOrganizers: archway.organizers, courseIdentities, requirementGroups, campusBuildings, campusSchools: campusSchoolsArtifact(inputs.campusSchools), courseSubjects: subjects.artifact };
}
function listStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; }

/** Use inside the publisher transaction after original rows/artifacts exist. */
export async function loadIdentitySnapshot(client: Pick<PoolClient, 'query'>, datasetId: string): Promise<IdentitySnapshot> {
  const snapshot: IdentitySnapshot = { campus_contacts: [], campus_hours: [], dining_hours: [], menu_items: [], programs: [], clubs: [], events: [], artifacts: {} };
  for (const table of ['campus_contacts', 'campus_hours', 'dining_hours', 'menu_items', 'programs'] as const) {
    const result = await client.query(`SELECT t.*, s.source_key FROM rockygpt_v2.${table} t JOIN rockygpt_v2.sources s ON s.id=t.source_id WHERE t.dataset_version_id=$1::uuid`, [datasetId]);
    snapshot[table] = result.rows;
  }
  for (const [collection, table] of [['clubs', 'clubs'], ['events', 'campus_events']] as const) {
    const result = await client.query(`SELECT t.*, s.source_key FROM rockygpt_v2.${table} t JOIN rockygpt_v2.sources s ON s.id=t.source_id WHERE t.dataset_version_id=$1::uuid`, [datasetId]);
    snapshot[collection] = result.rows;
  }
  const artifacts = await client.query('SELECT artifact_key,payload FROM rockygpt_v2.release_artifacts WHERE dataset_version_id=$1::uuid', [datasetId]);
  snapshot.artifacts = Object.fromEntries(artifacts.rows.map((r: Row) => [r.artifact_key, r.payload]));
  return snapshot;
}
