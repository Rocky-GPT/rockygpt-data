import type { CampusIdentity, IdentityEvidence } from './campus-identities';

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
 */

type Row = Record<string, unknown>;
const ABBREVIATED = /^(.+?) \(([A-Z][A-Z0-9&]{1,9})\)$/;
const DESIGNATIONS = [' BA', ' BS', ' BSN', ' BSW', ' MA', ' MS', ' MSN', ' MBA', ' MFA', ' MPP', ' MSW', ' DNP', ' Minor', ' 4+1', '-Graduate Certificate'];
const DANGLING = /\b(to|and|of|in|the|for)$|[&-]$/i;
const MAX_ALIASES = 32;

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** A name campus language uses that a person approved; not source-derived evidence. */
export interface ReviewedAlias { entity_id: string; entity: string; alias: string; reviewed_at: string; note: string }

/** Apply human-reviewed aliases by persistent ID; report any whose identity is absent. */
export function applyReviewedAliases(entities: CampusIdentity[], reviewed: ReviewedAlias[]): { applied: { entity_id: string; entity: string; alias: string; basis: 'human_reviewed'; reviewed_at: string }[]; unresolved: { entity: string; collection: string; reason: string }[] } {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const applied = []; const unresolved = [];
  for (const review of reviewed) {
    const entity = byId.get(review.entity_id);
    if (!entity || entity.name !== review.entity) { unresolved.push({ entity: review.entity, collection: 'aliases', reason: `The reviewed alias "${review.alias}" names an identity that is not in this release under that name; it is not applied.` }); continue; }
    if (!entity.aliases.includes(review.alias) && entity.aliases.length < MAX_ALIASES) entity.aliases = [...entity.aliases, review.alias];
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
export function applyPublishedAliases(entities: CampusIdentity[], rows: Map<string, Row>): void {
  for (const entity of entities) {
    const found: string[] = [];
    const abbreviated = ABBREVIATED.exec(entity.name);
    if (abbreviated && entity.kind !== 'person') found.push(abbreviated[2], abbreviated[1]);
    if (entity.kind === 'program') {
      const family = programFamily(entity.name);
      if (family) found.push(family);
    }
    const retired: IdentityEvidence[] = [];
    for (const link of entity.links.filter(l => l.collection === 'contacts')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`contacts:${link.source_key}:${key}`);
        if (['office', 'facility', 'venue'].includes(entity.kind) && key.startsWith('office:')) {
          const department = text(row?.department);
          if (department) found.push(department);
        }
        if (entity.kind === 'person' && text(row?.status).toLowerCase() === 'retired') {
          retired.push({ collection: 'contacts', source_key: link.source_key, source_record_key: key, field: 'status' });
        }
      }
    }
    const aliases = new Set(entity.aliases);
    for (const alias of found) if (alias !== entity.name && aliases.size < MAX_ALIASES) aliases.add(alias);
    entity.aliases = [...aliases];
    if (retired.length) entity.status = { state: 'retired', evidence: retired };
  }
}
