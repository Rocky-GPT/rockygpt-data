import type { GraphRecordCollection } from './campus-identities';

/**
 * @module data-v2/graph-records
 * One store for the records of every node kind added to the campus graph since 11-02 (terms,
 * calendar dates, and the parking, staff, menu and class-section kinds that follow).
 *
 * Each collection is a set of rows keyed by `source_record_key`, all from one source page set,
 * with the page each row was read from and when it was collected. The release publishes them as
 * the `graph-records` artifact. An identity links its rows the usual way (collection,
 * source_key, source_record_keys), and the Brain reads every collection here with one generic
 * reader, so a new kind needs no new table and no new Brain reader.
 */

export const GRAPH_RECORDS_ARTIFACT = 'graph-records';

export type GraphRecordRow = Record<string, unknown> & {
  source_record_key: string;
  /** The ramapo.edu page the row says what it says on. */
  source_url: string;
};

export interface GraphRecordCollectionData {
  source_key: string;
  /** When the source was collected, ISO 8601; empty when an offline compile does not know. */
  collected_at: string;
  rows: GraphRecordRow[];
}

export interface GraphRecordsArtifact {
  schema_version: 1;
  collections: Partial<Record<GraphRecordCollection, GraphRecordCollectionData>>;
}

export function emptyGraphRecords(): GraphRecordsArtifact {
  return { schema_version: 1, collections: {} };
}

/** Add one collection; its rows must have unique, nonempty keys and a source page. */
export function addGraphRecords(artifact: GraphRecordsArtifact, collection: GraphRecordCollection,
  data: GraphRecordCollectionData): void {
  if (artifact.collections[collection]) throw new Error(`Graph record collection ${collection} was added twice.`);
  const keys = new Set<string>();
  for (const row of data.rows) {
    if (!row.source_record_key || keys.has(row.source_record_key)) {
      throw new Error(`Graph record collection ${collection} has a missing or repeated key: ${row.source_record_key}.`);
    }
    if (!/^https:\/\//.test(row.source_url)) throw new Error(`Graph record ${collection}:${row.source_record_key} has no source page.`);
    keys.add(row.source_record_key);
  }
  artifact.collections[collection] = { ...data, rows: [...data.rows].sort((a, b) => a.source_record_key.localeCompare(b.source_record_key)) };
}
