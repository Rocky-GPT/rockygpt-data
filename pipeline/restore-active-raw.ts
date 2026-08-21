import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { downloadRawArtifactBundle, type RawArtifactBundleEnvelope } from './raw-artifacts';
import { SOURCES } from '../src/data-v2/source-seeds';
import {
  RAW_DATASET_FILES,
  SOURCE_RAW_DATASETS,
} from './quality/provenance';
import {
  writeJsonFile,
  writeRawFileProvenance,
} from '../ingestion/pipeline-utils';

interface ActiveSourceArtifact {
  sourceKey: string;
  rawUri: string | null;
  rawHash: string | null;
  collectedAt: string;
}

export interface RestoreActiveRawSummary {
  activeReleaseFound: boolean;
  sourcesRestored: number;
  filesRestored: number;
  skippedSources: string[];
}

function recordCount(payload: unknown): number | undefined {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.pages)) return record.pages.length;
  if (Array.isArray(record.programs)) return record.programs.length;
  if (Array.isArray(record.entries)) return record.entries.length;
  if (typeof record.count === 'number' && Number.isFinite(record.count)) return record.count;
  return undefined;
}

function safeRawFileName(file: string): string {
  const normalized = path.posix.normalize(file);
  if (
    normalized !== path.posix.basename(normalized) ||
    normalized.startsWith('.') ||
    !normalized.endsWith('.json')
  ) {
    throw new Error(`Unsafe raw artifact filename: ${file}`);
  }
  return normalized;
}

export function restoreBundleToRawDirectory(
  bundle: RawArtifactBundleEnvelope,
  artifact: Pick<ActiveSourceArtifact, 'sourceKey' | 'collectedAt'>,
  rawDir = path.join(process.cwd(), 'data', 'raw')
): number {
  if (bundle.sourceKey !== artifact.sourceKey) {
    throw new Error(
      `Raw artifact source mismatch: expected ${artifact.sourceKey}, received ${bundle.sourceKey}.`
    );
  }

  fs.mkdirSync(rawDir, { recursive: true });
  for (const entry of bundle.entries) {
    const fileName = safeRawFileName(entry.file);
    writeJsonFile(path.join(rawDir, fileName), entry.content);
  }

  const source = SOURCES.find((candidate) => candidate.key === artifact.sourceKey);
  for (const dataset of SOURCE_RAW_DATASETS[artifact.sourceKey] || []) {
    const rawFile = RAW_DATASET_FILES[dataset];
    if (!rawFile) {
      throw new Error(`No raw file mapping exists for restored dataset ${dataset}.`);
    }
    const rawPath = path.join(rawDir, rawFile);
    if (!fs.existsSync(rawPath)) {
      throw new Error(
        `Restored artifact for ${artifact.sourceKey} is missing required file ${rawFile}.`
      );
    }
    const payload = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as unknown;
    writeRawFileProvenance(dataset, rawPath, {
      sourceUrl: source?.url,
      recordCount: recordCount(payload),
      fetchedAt: artifact.collectedAt,
    });
  }

  return bundle.entries.length;
}

async function activeSourceArtifacts(pool: Pool): Promise<ActiveSourceArtifact[]> {
  const result = await pool.query<{
    source_key: string;
    raw_uri: string | null;
    raw_hash: string | null;
    collected_at: Date | string;
  }>(
    `SELECT
       source.source_key,
       ingestion.raw_uri,
       ingestion.raw_hash,
       COALESCE(source_run.started_at, snapshot.collected_at) AS collected_at
     FROM rockygpt_v2.releases release
     JOIN rockygpt_v2.release_sources release_source
       ON release_source.release_id = release.id
     JOIN rockygpt_v2.sources source
       ON source.id = release_source.source_id
     JOIN rockygpt_v2.source_snapshots snapshot
       ON snapshot.id = release_source.snapshot_id
     JOIN rockygpt_v2.ingestion_runs ingestion
       ON ingestion.id = snapshot.ingestion_run_id
     LEFT JOIN rockygpt_v2.source_runs source_run
       ON source_run.dataset_version_id = release.dataset_version_id
      AND source_run.source_key = source.source_key
     WHERE release.status = 'active'
     ORDER BY source.source_key`
  );
  return result.rows.map((row) => ({
    sourceKey: row.source_key,
    rawUri: row.raw_uri,
    rawHash: row.raw_hash,
    collectedAt: new Date(row.collected_at).toISOString(),
  }));
}

export async function restoreActiveRawArtifacts(
  rawDir = path.join(process.cwd(), 'data', 'raw')
): Promise<RestoreActiveRawSummary> {
  if (!process.env.DATABASE_URL || !process.env.RAW_ARTIFACT_BUCKET) {
    return {
      activeReleaseFound: false,
      sourcesRestored: 0,
      filesRestored: 0,
      skippedSources: [],
    };
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const artifacts = await activeSourceArtifacts(pool);
    if (!artifacts.length) {
      return {
        activeReleaseFound: false,
        sourcesRestored: 0,
        filesRestored: 0,
        skippedSources: [],
      };
    }

    let sourcesRestored = 0;
    let filesRestored = 0;
    const skippedSources: string[] = [];
    for (const artifact of artifacts) {
      if (!SOURCE_RAW_DATASETS[artifact.sourceKey]) continue;
      if (!artifact.rawUri) {
        skippedSources.push(artifact.sourceKey);
        continue;
      }
      const bundle = await downloadRawArtifactBundle(
        artifact.rawUri,
        artifact.rawHash || undefined
      );
      filesRestored += restoreBundleToRawDirectory(bundle, artifact, rawDir);
      sourcesRestored += 1;
    }
    return {
      activeReleaseFound: true,
      sourcesRestored,
      filesRestored,
      skippedSources,
    };
  } finally {
    await pool.end();
  }
}
