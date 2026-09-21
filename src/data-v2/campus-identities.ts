/** Curated identity links. Names locate identities; they never generate their IDs. */

export interface CampusIdentityLink {
  collection: 'contacts' | 'campus_hours';
  source_key: string;
  source_record_keys: string[];
}

export interface CampusIdentity {
  id: string;
  kind: 'office' | 'person' | 'facility' | 'venue';
  name: string;
  aliases: string[];
  links: CampusIdentityLink[];
}

export interface CampusIdentities {
  schema_version: 1;
  entities: CampusIdentity[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !(key in record))) {
    throw new Error(`${label} must contain only: ${keys.join(', ')}.`);
  }
  return record;
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 240) {
    throw new Error(`${label} must be trimmed nonempty text of at most 240 characters.`);
  }
}

function array(value: unknown, limit: number, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${label} must be an array of at most ${limit} entries.`);
  }
}

/**
 * Fail publication on malformed or multiply owned identity links, without
 * deriving matches or resolving conflicting facts. Shared aliases are allowed:
 * a consumer must report ambiguity rather than pick the first identity.
 * No collection/verification timestamps are manufactured by this artifact.
 */
export function validateCampusIdentities(value: unknown): asserts value is CampusIdentities {
  const registry = object(value, ['schema_version', 'entities'], 'Identity registry');
  if (registry.schema_version !== 1) throw new Error('Unsupported identity schema version.');
  array(registry.entities, 1000, 'entities');
  const ids = new Set<string>();
  const records = new Set<string>();
  for (const entry of registry.entities) {
    const entity = object(entry, ['id', 'kind', 'name', 'aliases', 'links'], 'Identity');
    text(entity.id, 'Identity id');
    if (!UUID.test(entity.id) || ids.has(entity.id)) {
      throw new Error('Identity IDs must be unique, persistent lowercase UUIDs.');
    }
    ids.add(entity.id);
    if (typeof entity.kind !== 'string' || !['office', 'person', 'facility', 'venue'].includes(entity.kind)) {
      throw new Error('Unsupported identity kind.');
    }
    text(entity.name, 'Identity name');
    array(entity.aliases, 32, 'aliases');
    for (const alias of entity.aliases) text(alias, 'Identity alias');
    array(entity.links, 16, 'links');
    if (!entity.links.length) throw new Error('An identity needs at least one verified record link.');
    for (const entry of entity.links) {
      const link = object(entry, ['collection', 'source_key', 'source_record_keys'], 'Identity link');
      if (link.collection !== 'contacts' && link.collection !== 'campus_hours') {
        throw new Error('Unsupported identity link collection.');
      }
      text(link.source_key, 'Source key');
      array(link.source_record_keys, 64, 'source_record_keys');
      if (!link.source_record_keys.length) throw new Error('An identity link needs record keys.');
      for (const key of link.source_record_keys) {
        text(key, 'Source record key');
        const target = JSON.stringify([link.collection, link.source_key, key]);
        if (records.has(target)) throw new Error('A source record must have exactly one identity link.');
        records.add(target);
      }
    }
  }
}
