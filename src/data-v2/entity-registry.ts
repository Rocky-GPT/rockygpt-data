import type { Pool } from 'pg';

/**
 * @module data-v2/entity-registry
 * The set of things a student can ask about, listed once.
 *
 * Lookups today match one human's guessed string against another human's typed
 * string: the vocabulary searched "Potter Library" while the dataset stored
 * "Library (Main Building)", and nothing connected the two until a person
 * noticed the library had been unanswerable for months.
 *
 * Every structured table already carries `source_record_key`, a stable handle
 * for the underlying record. This reads those keys and the names attached to
 * them, producing the closed set that resolution can eventually target instead
 * of free text. Read-only: nothing routes through it yet.
 *
 * The keys are derived from names upstream, so they are stable within a
 * dataset but not across a rename — "Ramapo Bookstore" becoming "Campus Store"
 * produces a new key. That is a real limit, and the reason a rename map is
 * needed before these can be treated as permanent identifiers.
 */

export type EntityKind =
  | 'campus_hours'
  | 'dining_hours'
  | 'campus_contacts'
  | 'clubs'
  | 'programs';

export interface RegistryEntity {
  kind: EntityKind;
  /** `source_record_key`, stable for as long as the upstream name is. */
  key: string;
  /** Every distinct display name the data carries for this key. */
  names: string[];
  /** Rows sharing the key — campus hours store one row per weekday. */
  rowCount: number;
}

export interface EntityRegistry {
  datasetVersion: string;
  generatedAt: string;
  entities: RegistryEntity[];
}

/**
 * How to read each table. `nameSql` is the human-readable label a student would
 * recognise; `keySql` is the handle. Both are fixed identifiers, never input.
 */
const SOURCES: ReadonlyArray<{ kind: EntityKind; table: string; nameSql: string }> = [
  { kind: 'campus_hours', table: 'campus_hours', nameSql: 'name' },
  { kind: 'dining_hours', table: 'dining_hours', nameSql: 'name' },
  { kind: 'campus_contacts', table: 'campus_contacts', nameSql: 'name' },
  { kind: 'clubs', table: 'clubs', nameSql: 'name' },
  { kind: 'programs', table: 'programs', nameSql: 'name' },
];

/**
 * Hours tables store one row per weekday, and dining adds a seasonal date:
 * "Library (Main Building):Monday", "Birch Tree Inn:Friday:2026-08-23". The
 * entity a student asks about is the venue, so everything after the first
 * separator is schedule detail rather than identity.
 */
function canonicalKey(kind: EntityKind, rawKey: string): string {
  if (kind !== 'campus_hours' && kind !== 'dining_hours') return rawKey;
  const separator = rawKey.indexOf(':');
  return separator === -1 ? rawKey : rawKey.slice(0, separator);
}

export async function buildEntityRegistry(
  pool: Pool,
  datasetVersionId: string,
  datasetVersion: string
): Promise<EntityRegistry> {
  const entities: RegistryEntity[] = [];

  for (const source of SOURCES) {
    const result = await pool.query<{ key: string; name: string; rows: string }>(
      `SELECT source_record_key AS key, ${source.nameSql} AS name, count(*)::text AS rows
         FROM rockygpt_v2.${source.table}
        WHERE dataset_version_id = $1::uuid
        GROUP BY source_record_key, ${source.nameSql}
        ORDER BY 1`,
      [datasetVersionId]
    );

    const byKey = new Map<string, RegistryEntity>();
    for (const row of result.rows) {
      const key = canonicalKey(source.kind, row.key);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.names.includes(row.name)) existing.names.push(row.name);
        existing.rowCount += Number(row.rows);
        continue;
      }
      byKey.set(key, {
        kind: source.kind,
        key,
        names: [row.name],
        rowCount: Number(row.rows),
      });
    }
    entities.push(...byKey.values());
  }

  return {
    datasetVersion,
    generatedAt: new Date().toISOString(),
    entities: entities.sort((left, right) =>
      left.kind === right.kind ? left.key.localeCompare(right.key) : left.kind.localeCompare(right.kind)
    ),
  };
}

/**
 * The columns worth showing for each kind, and how to find an entity's rows.
 *
 * Hours keys are truncated to the venue, so they are matched on the name
 * column; every other kind's key is the record key itself.
 */
const ROW_DETAIL: Record<
  EntityKind,
  { table: string; matchColumn: 'name' | 'source_record_key'; columns: string[] }
> = {
  campus_hours: { table: 'campus_hours', matchColumn: 'name', columns: ['day', 'schedule'] },
  dining_hours: {
    table: 'dining_hours',
    matchColumn: 'name',
    columns: ['day', 'schedule', 'valid_from::text AS season_start', 'valid_until::text AS season_end'],
  },
  campus_contacts: {
    table: 'campus_contacts',
    matchColumn: 'source_record_key',
    columns: ['department', 'phone', 'email', 'office'],
  },
  clubs: {
    table: 'clubs',
    matchColumn: 'source_record_key',
    columns: ['category', 'website'],
  },
  programs: {
    table: 'programs',
    matchColumn: 'source_record_key',
    columns: ['degree', 'program_kind', 'school', 'program_url'],
  },
};

export type EntityRow = Record<string, string | null>;

/**
 * Every row behind one entity — the seven weekday schedules behind a building,
 * the contact details behind an office. A count alone cannot show that a
 * building is missing four days, which reads to a student as "I don't know"
 * on exactly the days it is absent.
 */
export async function loadEntityRows(
  pool: Pool,
  datasetVersionId: string,
  kind: EntityKind,
  key: string
): Promise<EntityRow[]> {
  const detail = ROW_DETAIL[kind];
  const result = await pool.query<EntityRow>(
    `SELECT ${detail.columns.join(', ')}
       FROM rockygpt_v2.${detail.table}
      WHERE dataset_version_id = $1::uuid AND ${detail.matchColumn} = $2
      ORDER BY 1
      LIMIT 60`,
    [datasetVersionId, key]
  );
  return result.rows;
}

/** Counts per kind, for a report that fits on one screen. */
export function registrySummary(registry: EntityRegistry): Array<{ kind: EntityKind; count: number }> {
  const counts = new Map<EntityKind, number>();
  for (const entity of registry.entities) {
    counts.set(entity.kind, (counts.get(entity.kind) || 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/**
 * Keys whose names disagree — the same record appearing under more than one
 * label. This is the shape the library bug took, visible before a student
 * finds it.
 */
export function ambiguousEntities(registry: EntityRegistry): RegistryEntity[] {
  return registry.entities.filter((entity) => entity.names.length > 1);
}
