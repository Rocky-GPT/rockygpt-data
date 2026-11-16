/**
 * The publish's check that a release did not lose much of its documents' text: counted in the
 * chunks chunkDocumentSections cuts each document into, in all and source by source, against the
 * active release. The chunks themselves are no longer stored (11-16): nothing that answers
 * students reads them (the Brain answers from the graph), so the count is taken from the
 * documents' own text, cut the same way, for both releases.
 */
import { chunkDocumentSections } from '../src/data-v2/document-text';

/** At least this many chunks in a release. */
export const MIN_RELEASE_CHUNKS = 100;
/** A release keeps at least this share of the active release's chunks. */
export const RELEASE_CHUNK_FLOOR = 0.5;
/** A source keeps at least this share of its chunks; sources not listed keep half. */
export const SOURCE_CHUNK_FLOORS: Readonly<Record<string, number>> = {
  'archway-events': 0.2,
  dining: 0.3,
  'academic-programs': 0.6,
  faculty: 0.6,
};
const DEFAULT_SOURCE_CHUNK_FLOOR = 0.5;
/** A source with fewer chunks than this in the active release is not judged. */
const MIN_JUDGED_SOURCE_CHUNKS = 3;

export function chunkCountsBySource(
  documents: Iterable<{ sourceKey: string; content: string }>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    counts.set(document.sourceKey,
      (counts.get(document.sourceKey) ?? 0) + chunkDocumentSections(document.content).length);
  }
  return counts;
}

const total = (counts: ReadonlyMap<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);

/** Why the candidate release's chunk counts fail the check against the active release's, or null. */
export function chunkGateError(
  candidate: ReadonlyMap<string, number>,
  active: ReadonlyMap<string, number>
): string | null {
  const candidateTotal = total(candidate);
  const activeTotal = total(active);
  if (candidateTotal < MIN_RELEASE_CHUNKS) {
    return `Staging verification failed: document_chunks=${candidateTotal}, expected >= ${MIN_RELEASE_CHUNKS}.`;
  }
  if (activeTotal > 0 && candidateTotal < activeTotal * RELEASE_CHUNK_FLOOR) {
    return `Staging verification failed: document_chunks dropped from ${activeTotal} to ${candidateTotal} ` +
      `(minimum allowed ratio ${RELEASE_CHUNK_FLOOR}).`;
  }
  for (const [sourceKey, previous] of [...active].sort(([a], [b]) => a.localeCompare(b))) {
    if (previous < MIN_JUDGED_SOURCE_CHUNKS) continue;
    const now = candidate.get(sourceKey) ?? 0;
    const ratio = SOURCE_CHUNK_FLOORS[sourceKey] ?? DEFAULT_SOURCE_CHUNK_FLOOR;
    if (now < previous * ratio) {
      return `Staging verification failed: ${sourceKey} chunks dropped from ${previous} to ${now} ` +
        `(minimum allowed ratio ${ratio}).`;
    }
  }
  return null;
}
