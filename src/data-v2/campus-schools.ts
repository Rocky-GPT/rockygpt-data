import type { CampusIdentity, CampusIdentityLink } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { normalizeName } from './archway-identities';
import { SOURCES } from './source-seeds';
import { noteAlias, type AliasLedger } from './identity-aliases';

/**
 * @module data-v2/campus-schools
 * Ramapo's schools, as its current official schools page lists them.
 *
 * `src/reference/campus-schools.json` is the reviewed list: each current school
 * with a persistent ID, its official page, its published abbreviation and the
 * former names it succeeded, each with evidence. Programs are linked through the
 * catalog's (former) school name only when that name has exactly one successor;
 * the School of Social Science and Human Services was split, so its programs are
 * not placed. People are linked through the current school name their own faculty
 * profile publishes; a retired profile is not placed in a school.
 */

type Row = Record<string, unknown>;
export const RAMAPO_SCHOOLS_SOURCE_KEY = 'ramapo-schools';
// The faculty directory's own status suffixes on the school field.
const STATUS_SUFFIX = / \((Retired|Adjunct)\)$/;

export interface LegacySchoolName { name: string; evidence: string }
export interface CampusSchool { section: string; name: string; abbreviation: string; url: string; legacy_names: LegacySchoolName[] }
export interface CampusSchoolsArtifact {
  schema_version: 1;
  source: { source_key: string; title: string; canonical_url: string; trust_tier: string; freshness_sla_hours: number; domain: string };
  source_url: string;
  captured_at: string;
  schools: CampusSchool[];
}
interface ReviewedSchool extends CampusSchool { id: string; archway_groups: string[] }
export interface ReviewedSchools { source_url: string; captured_at: string; schools: ReviewedSchool[] }

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** The reviewed schools file, when the caller provides it; otherwise no schools. */
export function campusSchoolsArtifact(reference?: ReviewedSchools): CampusSchoolsArtifact {
  const seed = SOURCES.find(source => source.key === RAMAPO_SCHOOLS_SOURCE_KEY);
  if (!seed) throw new Error('The ramapo-schools source seed is missing.');
  return {
    schema_version: 1,
    source: { source_key: seed.key, title: seed.title, canonical_url: seed.url, trust_tier: seed.trustTier, freshness_sla_hours: seed.freshnessHours, domain: seed.domain },
    source_url: reference?.source_url ?? seed.url,
    captured_at: reference?.captured_at ?? '',
    schools: (reference?.schools ?? []).map(({ section, name, abbreviation, url, legacy_names }) => ({ section, name, abbreviation, url, legacy_names })),
  };
}

/**
 * School identities, and part_of relationships for programs (through their
 * catalog school name) and people (through their faculty profile's current
 * school). `rows` maps `${collection}:${source_key}:${source_record_key}` to the
 * original record in this release; `clubs` are this release's Archway rows.
 */
export function compileSchoolIdentities(entities: CampusIdentity[], rows: Map<string, Row>, clubs: Row[], reference?: ReviewedSchools, ledger: AliasLedger = new Map()): { schools: CampusIdentity[]; unresolved: IdentityCoverageIssue[]; ownedClubs: Set<string> } {
  const unresolved: IdentityCoverageIssue[] = [];
  const ownedClubs = new Set<string>();
  if (!reference) return { schools: [], unresolved, ownedClubs };
  const names = new Map<string, string>();
  for (const entity of entities) for (const name of [entity.name, ...entity.aliases]) names.set(normalizeName(name), `${entity.kind} "${entity.name}"`);
  const schools: CampusIdentity[] = reference.schools.map(school => {
    const links: CampusIdentityLink[] = [{ collection: 'schools', source_key: RAMAPO_SCHOOLS_SOURCE_KEY, source_record_keys: [school.section] }];
    const groups = clubs.filter(row => school.archway_groups.includes(text(row.source_record_key)));
    for (const key of school.archway_groups) {
      const matches = groups.filter(row => text(row.source_record_key) === key);
      if (matches.length !== 1) unresolved.push({ entity: school.name, collection: 'clubs', record: key, reason: `The reviewed Archway group ${key} has ${matches.length} records in this release; it is not linked.` });
    }
    const linked = groups.filter(row => groups.filter(other => text(other.source_record_key) === text(row.source_record_key)).length === 1);
    if (linked.length) {
      links.push({ collection: 'clubs', source_key: text(linked[0].source_key), source_record_keys: linked.map(row => text(row.source_record_key)), source_record_ids: linked.map(row => text(row.id)) });
      for (const row of linked) ownedClubs.add(text(row.source_record_key));
    }
    const other = names.get(normalizeName(school.name));
    // A shared name is kept for an ambiguous lookup, never merged by name.
    if (other) unresolved.push({ entity: school.name, collection: 'schools', record: school.section, reason: `Shares its name with the ${other}; a name lookup asks which one is meant.` });
    const aliases = [...new Set([school.abbreviation, ...school.legacy_names.map(legacy => legacy.name)])];
    noteAlias(ledger, school.id, school.abbreviation, { basis: 'school_abbreviation', source_url: school.url });
    for (const legacy of school.legacy_names) noteAlias(ledger, school.id, legacy.name, { basis: 'school_former_name', note: legacy.evidence });
    return { id: school.id, kind: 'school', name: school.name, aliases, links };
  });
  const successors = new Map<string, string[]>();
  for (const [index, school] of reference.schools.entries()) {
    for (const name of [school.name, ...school.legacy_names.map(legacy => legacy.name)]) successors.set(name, [...(successors.get(name) || []), schools[index].id]);
  }
  const byName = new Map(reference.schools.map((school, index) => [school.name, schools[index].id]));
  for (const entity of entities) {
    if (entity.kind !== 'program' && entity.kind !== 'person') continue;
    const collection = entity.kind === 'program' ? 'programs' : 'faculty';
    const evidence = new Map<string, { collection: 'programs' | 'faculty'; source_key: string; source_record_key: string; field: string }[]>();
    for (const link of entity.links.filter(l => l.collection === collection)) {
      for (const key of link.source_record_keys) {
        const value = text(rows.get(`${collection}:${link.source_key}:${key}`)?.school);
        if (!value) continue;
        let targets: string[];
        if (entity.kind === 'program') {
          targets = successors.get(value) || [];
          if (targets.length > 1) { unresolved.push({ entity: entity.name, collection, record: key, reason: `Catalog school "${value}" was split between current schools; the program is not placed in one.` }); continue; }
        } else {
          const status = STATUS_SUFFIX.exec(value)?.[1];
          if (status === 'Retired') { unresolved.push({ entity: entity.name, collection, record: key, reason: 'The faculty profile marks this person retired; no current school is linked.' }); continue; }
          const school = byName.get(value.replace(STATUS_SUFFIX, ''));
          targets = school ? [school] : [];
        }
        if (!targets.length) { unresolved.push({ entity: entity.name, collection, record: key, reason: `Published school "${value}" is not a current official school or a reviewed legacy name of one.` }); continue; }
        const references = evidence.get(targets[0]) || [];
        references.push({ collection, source_key: link.source_key, source_record_key: key, field: 'school' });
        evidence.set(targets[0], references);
      }
    }
    for (const [school, references] of evidence) {
      entity.relationships ||= [];
      entity.relationships.push({ type: 'part_of', target_entity_id: school, evidence: references });
    }
  }
  return { schools, unresolved, ownedClubs };
}
