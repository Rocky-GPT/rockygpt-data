import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { SourceSeed } from '../../src/data-v2/source-seeds';

/**
 * Source-native provenance (PROB-002/REC-002).
 *
 * Collectors write a sidecar next to each raw dataset recording when the
 * source was actually fetched, so freshness reflects the collection event
 * instead of a filesystem mtime or the publication instant. A source without
 * a valid sidecar has UNKNOWN age — unknown is represented as `null`, never
 * as zero hours — and fails the enforced gate until an authorized refresh
 * produces real provenance. Timestamps are never fabricated.
 */

export interface RawProvenanceV1 {
  version: 1;
  dataset: string;
  /** The actual collection instant, written by the collector at fetch time. */
  fetchedAt: string;
  sourceUrl?: string;
  recordCount?: number;
  /** sha256 of the raw payload the collector wrote. */
  contentHash?: string;
}

/**
 * Raw datasets each publishable source is collected from. Sources absent
 * here are repository-static (critical facts, seeded contacts, the checked-in
 * shuttle timetable) whose truth is versioned by Git rather than a scrape.
 */
export const SOURCE_RAW_DATASETS: Record<string, string[]> = {
  'public-safety': ['safety'],
  'academic-calendar': ['calendar'],
  dining: ['menu', 'menu-week', 'dining-hours'],
  'campus-hours': ['hours'],
  'archway-events': ['events', 'events-detail', 'events-signals'],
  'archway-clubs': ['clubs', 'clubs-detail'],
  // Programs, requirements, and courses are collected together from the
  // official Coursedog API into one provenance-bound raw artifact.
  'academic-programs': ['catalog-programs'],
  'campus-directory': ['directory'],
  transportation: ['transportation'],
  housing: ['housing'],
  health: ['health'],
  counseling: ['counseling'],
  faculty: ['faculty'],
};

export const RAW_DATASET_FILES: Record<string, string> = {
  safety: 'safety.raw.json',
  calendar: 'calendar.raw.json',
  menu: 'menu.raw.json',
  'menu-week': 'menu-week.raw.json',
  'dining-hours': 'dining-hours.raw.json',
  hours: 'hours.raw.json',
  events: 'events.raw.json',
  'events-detail': 'events-detail.raw.json',
  'events-signals': 'events-signals.raw.json',
  clubs: 'clubs.raw.json',
  'clubs-detail': 'clubs-detail.raw.json',
  'catalog-programs': 'catalog-programs-api.raw.json',
  directory: 'directory.raw.json',
  transportation: 'transportation.raw.json',
  housing: 'housing.raw.json',
  health: 'health.raw.json',
  counseling: 'counseling.raw.json',
  faculty: 'faculty.raw.json',
};

export type SourceProvenanceStatus = 'fresh' | 'stale' | 'unknown' | 'static';

export interface SourceProvenanceState {
  key: string;
  status: SourceProvenanceStatus;
  /** Hours since the oldest underlying collection; null when unknown. */
  ageHours: number | null;
  maxAgeHours: number;
  datasets: string[];
  fetchedAt?: string;
  recordCount?: number;
  contentHash?: string;
  detail: string;
}

export function provenancePath(dataset: string, rawDir = 'data/raw'): string {
  return path.join(path.resolve(process.cwd(), rawDir), `${dataset}.provenance.json`);
}

export function readRawProvenance(dataset: string, rawDir = 'data/raw'): RawProvenanceV1 | null {
  let raw: string;
  try {
    raw = fs.readFileSync(provenancePath(dataset, rawDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RawProvenanceV1> | null;
    if (
      parsed &&
      parsed.version === 1 &&
      parsed.dataset === dataset &&
      typeof parsed.fetchedAt === 'string' &&
      Number.isFinite(Date.parse(parsed.fetchedAt))
    ) {
      const payloadFile = RAW_DATASET_FILES[dataset];
      if (!payloadFile || typeof parsed.contentHash !== 'string') return null;
      let payload: unknown;
      try {
        payload = JSON.parse(
          fs.readFileSync(path.join(path.resolve(process.cwd(), rawDir), payloadFile), 'utf8')
        ) as unknown;
      } catch {
        return null;
      }
      const actualHash = createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
      if (actualHash !== parsed.contentHash) return null;
      return parsed as RawProvenanceV1;
    }
    return null;
  } catch {
    // Malformed provenance is unknown provenance, never zero-age.
    return null;
  }
}

export function evaluateSourceProvenance(
  seeds: ReadonlyArray<Pick<SourceSeed, 'key' | 'freshnessHours'>>,
  now = new Date(),
  rawDir = 'data/raw'
): SourceProvenanceState[] {
  return seeds.map((seed) => {
    const datasets = SOURCE_RAW_DATASETS[seed.key];
    if (!datasets) {
      return {
        key: seed.key,
        status: 'static',
        ageHours: null,
        maxAgeHours: seed.freshnessHours,
        datasets: [],
        detail: 'repository-static source; provenance is the Git revision',
      };
    }

    const sidecars = datasets.map((dataset) => ({
      dataset,
      provenance: readRawProvenance(dataset, rawDir),
    }));
    const missing = sidecars.filter((entry) => !entry.provenance).map((entry) => entry.dataset);
    if (missing.length) {
      return {
        key: seed.key,
        status: 'unknown',
        ageHours: null,
        maxAgeHours: seed.freshnessHours,
        datasets,
        detail: `no valid provenance for raw dataset(s): ${missing.join(', ')}`,
      };
    }

    const collected = sidecars.map((entry) => entry.provenance as RawProvenanceV1);
    const ages = collected.map(
      (provenance) => (now.getTime() - Date.parse(provenance.fetchedAt)) / 3_600_000
    );
    const ageHours = Math.max(...ages);
    const oldest = collected[ages.indexOf(ageHours)];
    const recordCounts = collected
      .map((provenance) => provenance.recordCount)
      .filter((count): count is number => typeof count === 'number');
    const hashes = collected
      .map((provenance) => provenance.contentHash)
      .filter((hash): hash is string => typeof hash === 'string');
    return {
      key: seed.key,
      status: ageHours > seed.freshnessHours ? 'stale' : 'fresh',
      ageHours,
      maxAgeHours: seed.freshnessHours,
      datasets,
      fetchedAt: oldest.fetchedAt,
      recordCount: recordCounts.length
        ? recordCounts.reduce((sum, count) => sum + count, 0)
        : undefined,
      contentHash: hashes.length ? hashes.join(':') : undefined,
      detail: `collected ${ageHours.toFixed(1)}h ago (max ${seed.freshnessHours}h)`,
    };
  });
}
