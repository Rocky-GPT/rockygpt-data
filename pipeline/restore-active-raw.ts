import fs from 'node:fs';
import path from 'node:path';
import { type RawArtifactBundleEnvelope } from './raw-artifacts';
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
