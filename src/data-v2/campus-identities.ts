/** Curated identity links. Names locate identities; they never generate their IDs. */
export type IdentityCollection = 'contacts' | 'campus_hours' | 'dining_hours' | 'menu' | 'faculty' | 'programs' | 'courses' | 'clubs' | 'events' | 'buildings' | 'schools' | 'subjects';
export interface IdentityRecordReference {
  collection: IdentityCollection;
  source_key: string;
  source_record_key: string;
  source_record_id?: string;
}
export interface IdentityEvidence extends IdentityRecordReference { field: string; source_url?: string }
export interface CampusIdentityLink {
  collection: IdentityCollection;
  source_key: string;
  source_record_keys: string[];
  /** Exact original row IDs disambiguate legacy source keys within this release. */
  source_record_ids?: string[];
  /** Publication-only selectors. Compiled releases always contain exact current keys. */
  selector?: { field: 'faculty_identity' | 'contact_identity' | 'name' | 'catalog_code' | 'menu_venue'; values: string[]; evidence: string };
}
export type CampusIdentityRelationship =
  | { type: 'convener' | 'listed_faculty' | 'organized_by' | 'office_at' | 'located_at' | 'part_of'; target_entity_id: string; evidence: IdentityEvidence[] }
  | { type: 'profile_course' | 'includes_course'; target_record: IdentityRecordReference; evidence: IdentityEvidence[] };
export interface CampusIdentity {
  id: string;
  kind: 'office' | 'person' | 'facility' | 'venue' | 'program' | 'club' | 'organization' | 'event' | 'building' | 'school' | 'subject';
  name: string;
  aliases: string[];
  links: CampusIdentityLink[];
  relationships?: CampusIdentityRelationship[];
  /** A status the identity's own records publish; absent means none is published. */
  status?: { state: 'retired'; evidence: IdentityEvidence[] };
}
export interface CampusIdentities { schema_version: 1; entities: CampusIdentity[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLLECTIONS = ['contacts', 'campus_hours', 'dining_hours', 'menu', 'faculty', 'programs', 'courses', 'clubs', 'events', 'buildings', 'schools', 'subjects'];
// Relationships whose target is a catalog record, not an identity.
const RECORD_TARGETS = ['profile_course', 'includes_course'];
function object(value: unknown, keys: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (keys.some(key => !(key in record)) || Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) {
    throw new Error(`${label} must contain only: ${[...keys, ...optional].join(', ')}.`);
  }
  return record;
}
function text(value: unknown, label: string, limit = 500): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > limit) {
    throw new Error(`${label} must be trimmed nonempty text of at most ${limit} characters.`);
  }
}
function array(value: unknown, limit: number, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array of at most ${limit} entries.`);
}
function reference(value: unknown, evidence = false): void {
  const ref = object(value, ['collection', 'source_key', 'source_record_key', ...(evidence ? ['field'] : [])], 'Record reference', ['source_record_id', ...(evidence ? ['source_url'] : [])]);
  if (!COLLECTIONS.includes(ref.collection as string)) throw new Error('Unsupported reference collection.');
  text(ref.source_key, 'Source key'); text(ref.source_record_key, 'Source record key');
  if (ref.source_record_id !== undefined && (typeof ref.source_record_id !== 'string' || !UUID.test(ref.source_record_id))) throw new Error('Invalid original source record ID.');
  if (evidence) text(ref.field, 'Evidence field');
  if (ref.source_url !== undefined) text(ref.source_url, 'Evidence source URL');
}
/** Fail closed on malformed/multiply owned links. Shared aliases remain ambiguous. */
export function validateCampusIdentities(value: unknown): asserts value is CampusIdentities {
  const registry = object(value, ['schema_version', 'entities'], 'Identity registry');
  if (registry.schema_version !== 1) throw new Error('Unsupported identity schema version.');
  array(registry.entities, 5000, 'entities');
  const ids = new Set<string>(); const records = new Map<string, Set<string> | null>(); const rowIds = new Set<string>();
  for (const entry of registry.entities) {
    const entity = object(entry, ['id', 'kind', 'name', 'aliases', 'links'], 'Identity', ['relationships', 'status']);
    text(entity.id, 'Identity id');
    if (!UUID.test(entity.id) || ids.has(entity.id)) throw new Error('Identity IDs must be unique, persistent lowercase UUIDs.');
    ids.add(entity.id);
    if (!['office', 'person', 'facility', 'venue', 'program', 'club', 'organization', 'event', 'building', 'school', 'subject'].includes(entity.kind as string)) throw new Error('Unsupported identity kind.');
    text(entity.name, 'Identity name', 240); array(entity.aliases, 32, 'aliases');
    for (const alias of entity.aliases) text(alias, 'Identity alias', 240);
    array(entity.links, 32, 'links');
    if (!entity.links.length) throw new Error('An identity needs at least one verified record link.');
    for (const entry of entity.links) {
      const link = object(entry, ['collection', 'source_key', 'source_record_keys'], 'Identity link', ['selector', 'source_record_ids']);
      if (!COLLECTIONS.includes(link.collection as string)) throw new Error('Unsupported identity link collection.');
      text(link.source_key, 'Source key'); array(link.source_record_keys, 25000, 'source_record_keys');
      if (!link.source_record_keys.length && !link.selector) throw new Error('An identity link needs record keys.');
      let pinned: Set<string> | null = null;
      if (link.source_record_ids !== undefined) {
        array(link.source_record_ids, 25000, 'source_record_ids');
        if (!link.source_record_ids.length) throw new Error('Pinned record IDs cannot be empty.');
        pinned = new Set<string>();
        for (const id of link.source_record_ids) {
          if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid original source record ID.');
          const qualified = JSON.stringify([link.collection, link.source_key, id]);
          if (rowIds.has(qualified)) throw new Error('A source record must have exactly one identity link.');
          rowIds.add(qualified); pinned.add(id);
        }
      }
      for (const key of link.source_record_keys) {
        text(key, 'Source record key'); const target = JSON.stringify([link.collection, link.source_key, key]);
        if (records.has(target)) {
          const previous = records.get(target);
          if (!previous || !pinned || [...pinned].some(id => previous.has(id))) throw new Error('A source record must have exactly one identity link.');
          for (const id of pinned) previous.add(id);
        } else records.set(target, pinned ? new Set(pinned) : null);
      }
      if (link.selector !== undefined) {
        const selector = object(link.selector, ['field', 'values', 'evidence'], 'Identity selector');
        if (!['faculty_identity', 'contact_identity', 'name', 'catalog_code', 'menu_venue'].includes(selector.field as string)) throw new Error('Unsupported selector field.');
        array(selector.values, 32, 'Selector values'); if (!selector.values.length) throw new Error('Selector requires evidence-backed values.');
        for (const val of selector.values) text(val, 'Selector value'); text(selector.evidence, 'Selector evidence', 2000);
      }
    }
    if (entity.status !== undefined) {
      const status = object(entity.status, ['state', 'evidence'], 'Identity status');
      if (status.state !== 'retired') throw new Error('Unsupported identity status.');
      array(status.evidence, 32, 'Status evidence'); if (!status.evidence.length) throw new Error('A status needs evidence.');
      for (const ref of status.evidence) reference(ref, true);
    }
    if (entity.relationships !== undefined) {
      array(entity.relationships, 1000, 'relationships');
      for (const entry of entity.relationships) {
        const relation = object(entry, ['type', 'evidence'], 'Relationship', ['target_entity_id', 'target_record']);
        if (['convener', 'listed_faculty', 'organized_by', 'office_at', 'located_at', 'part_of'].includes(relation.type as string)) {
          text(relation.target_entity_id, 'Target identity');
          if (!UUID.test(relation.target_entity_id) || relation.target_record !== undefined) throw new Error('Invalid identity target.');
        } else if (RECORD_TARGETS.includes(relation.type as string)) {
          reference(relation.target_record); if (relation.target_entity_id !== undefined) throw new Error('Invalid course target.');
        } else throw new Error('Unsupported relationship type.');
        array(relation.evidence, 32, 'Relationship evidence'); if (!relation.evidence.length) throw new Error('Relationship needs evidence.');
        for (const ref of relation.evidence) reference(ref, true);
      }
    }
  }
  for (const entity of registry.entities as CampusIdentity[]) for (const relation of entity.relationships || []) {
    if (!RECORD_TARGETS.includes(relation.type) && 'target_entity_id' in relation && !ids.has(relation.target_entity_id)) throw new Error('Broken relationship identity target.');
  }
}
