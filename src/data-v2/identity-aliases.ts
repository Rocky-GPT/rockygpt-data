import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';

/**
 * @module data-v2/identity-aliases
 * Aliases and status that an identity's own published records establish.
 *
 * Every rule reads only the identity's own name and linked records; none matches
 * one entity's name against another's. An alias several identities share stays on
 * each of them, so a lookup by it asks which one is meant ("Public Safety" names
 * both directory entries; "Computer Science" names four programs).
 *
 * - Department: an office, facility or venue's own directory entry publishes a
 *   department name ("Potter Library" for the Library). The contact lookup has
 *   always treated it as an alternative name; a person's department never is.
 * - Abbreviation: a name ending in an uppercase abbreviation in parentheses gives
 *   the abbreviation and the name without it ("Student Center (SC)").
 * - Program family: a program name ending in a published degree designation gives
 *   the name without it ("Computer Science BS" → "Computer Science"). A remainder
 *   that ends mid-phrase ("Nursing RN to BSN") gives none.
 *
 * Status: a person whose own contact record publishes status "retired" is retired.
 *
 * Every rule that puts an alias on an identity, here or in the other compile
 * stages, notes why in an `AliasLedger`. The coverage report publishes the ledger
 * as `alias_sources`, so each alias can be traced to its rule and evidence.
 */

type Row = Record<string, unknown>;
const ABBREVIATED = /^(.+?) \(([A-Z][A-Z0-9&]{1,9})\)$/;
const DESIGNATIONS = [' BA', ' BS', ' BSN', ' BSW', ' MA', ' MS', ' MSN', ' MBA', ' MFA', ' MPP', ' MSW', ' DNP', ' Minor', ' 4+1', '-Graduate Certificate'];
const DANGLING = /\b(to|and|of|in|the|for)$|[&-]$/i;
const MAX_ALIASES = 32;

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Why an alias is on its identity. */
export type AliasBasis =
  | 'identity_map' // The reviewed identity map lists it.
  | 'record_name' // A linked source record publishes it as its name.
  | 'school_abbreviation' // The school's reviewed entry, from its official page.
  | 'school_former_name' // A former name the school succeeded, with recorded evidence.
  | 'event_title' // The event's published title, without its date.
  | 'department' // Its own directory entry publishes it as the department.
  | 'abbreviation' // The parenthesized abbreviation in its own name, or the name without it.
  | 'program_family' // Its program name without the degree designation.
  | 'subject_code' // A course subject's catalog code, the only name it answers to in lookup.
  | 'human_reviewed'; // A person approved it; no source publishes it.
export interface AliasSource {
  basis: AliasBasis;
  /** The published field a linked record states it in. */
  evidence?: IdentityEvidence;
  source_url?: string;
  reviewed_at?: string;
  /** A reviewer's note, or the recorded evidence of a former name. */
  note?: string;
}
export interface AliasRecord { entity_id: string; entity: string; kind: CampusIdentity['kind']; alias: string; sources: AliasSource[] }
/** The sources each rule noted, keyed by entity ID and alias. */
export type AliasLedger = Map<string, AliasSource[]>;

const ledgerKey = (entityId: string, alias: string) => `${entityId}\u0000${alias}`;

export function noteAlias(ledger: AliasLedger, entityId: string, alias: string, source: AliasSource): void {
  const sources = ledger.get(ledgerKey(entityId, alias)) || [];
  if (!sources.some(existing => JSON.stringify(existing) === JSON.stringify(source))) sources.push(source);
  ledger.set(ledgerKey(entityId, alias), sources);
}

/** Every alias in the registry with the sources that put it there. An alias no rule noted is a compiler error. */
export function aliasRecords(entities: CampusIdentity[], ledger: AliasLedger): AliasRecord[] {
  return entities.flatMap(entity => entity.aliases.map(alias => {
    const sources = ledger.get(ledgerKey(entity.id, alias));
    if (!sources?.length) throw new Error(`The alias "${alias}" of ${entity.kind} "${entity.name}" has no recorded source.`);
    return { entity_id: entity.id, entity: entity.name, kind: entity.kind, alias, sources };
  }));
}

/** A name campus language uses that a person approved; not source-derived evidence. */
export interface ReviewedAlias { entity_id: string; entity: string; alias: string; reviewed_at: string; note: string }

/** Apply human-reviewed aliases by persistent ID; report any whose identity is absent. */
export function applyReviewedAliases(entities: CampusIdentity[], reviewed: ReviewedAlias[], ledger: AliasLedger = new Map()): { applied: { entity_id: string; entity: string; alias: string; basis: 'human_reviewed'; reviewed_at: string }[]; unresolved: IdentityCoverageIssue[] } {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const applied = []; const unresolved: IdentityCoverageIssue[] = [];
  for (const review of reviewed) {
    const entity = byId.get(review.entity_id);
    if (!entity || entity.name !== review.entity) { unresolved.push({ entity: review.entity, collection: 'aliases', reason: `The reviewed alias "${review.alias}" names an identity that is not in this release under that name; it is not applied.`, kind: 'no_records' }); continue; }
    if (!entity.aliases.includes(review.alias) && entity.aliases.length < MAX_ALIASES) entity.aliases = [...entity.aliases, review.alias];
    if (!entity.aliases.includes(review.alias)) { unresolved.push({ entity: review.entity, collection: 'aliases', reason: `The reviewed alias "${review.alias}" does not fit: the identity already has ${MAX_ALIASES} aliases.`, kind: 'note' }); continue; }
    noteAlias(ledger, entity.id, review.alias, { basis: 'human_reviewed', reviewed_at: review.reviewed_at, note: review.note });
    applied.push({ entity_id: entity.id, entity: entity.name, alias: review.alias, basis: 'human_reviewed' as const, reviewed_at: review.reviewed_at });
  }
  return { applied, unresolved };
}

/** The program name without its degree designation, or null. */
export function programFamily(name: string): string | null {
  const designation = DESIGNATIONS.find(suffix => name.endsWith(suffix));
  const family = designation ? name.slice(0, -designation.length).trim() : '';
  return family && !DANGLING.test(family) ? family : null;
}

/**
 * Add published aliases and retired status in place. `rows` maps
 * `${collection}:${source_key}:${source_record_key}` to the original record.
 */
export function applyPublishedAliases(entities: CampusIdentity[], rows: Map<string, Row>, ledger: AliasLedger = new Map()): void {
  for (const entity of entities) {
    const found: [string, AliasSource][] = [];
    const abbreviated = ABBREVIATED.exec(entity.name);
    // A subject answers to its code only (reviewed September 23, 2026): its catalog
    // name, "Computer Science" in "Computer Science (CMPS)", keeps finding programs.
    if (abbreviated && entity.kind !== 'person' && entity.kind !== 'subject') found.push([abbreviated[2], { basis: 'abbreviation' }], [abbreviated[1], { basis: 'abbreviation' }]);
    if (entity.kind === 'program') {
      const family = programFamily(entity.name);
      if (family) found.push([family, { basis: 'program_family' }]);
    }
    const retired: IdentityEvidence[] = [];
    for (const link of entity.links.filter(l => l.collection === 'contacts')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`contacts:${link.source_key}:${key}`);
        if (['office', 'facility', 'venue'].includes(entity.kind) && key.startsWith('office:')) {
          const department = text(row?.department);
          if (department) found.push([department, { basis: 'department', evidence: { collection: 'contacts', source_key: link.source_key, source_record_key: key, field: 'department' } }]);
        }
        if (entity.kind === 'person' && text(row?.status).toLowerCase() === 'retired') {
          retired.push({ collection: 'contacts', source_key: link.source_key, source_record_key: key, field: 'status' });
        }
      }
    }
    const aliases = new Set(entity.aliases);
    for (const [alias, source] of found) {
      if (alias === entity.name || (!aliases.has(alias) && aliases.size >= MAX_ALIASES)) continue;
      aliases.add(alias);
      noteAlias(ledger, entity.id, alias, source);
    }
    entity.aliases = [...aliases];
    if (retired.length) entity.status = { state: 'retired', evidence: retired };
  }
}
