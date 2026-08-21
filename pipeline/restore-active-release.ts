import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import {
  downloadRawArtifactBundle,
  type RawArtifactBundleEnvelope,
} from './raw-artifacts';
import { SOURCE_RAW_DATASETS } from './quality/provenance';
import { restoreBundleToRawDirectory } from './restore-active-raw';
import { writeJsonFile } from '../ingestion/pipeline-utils';

export interface ActiveReleaseIdentity {
  datasetId: string;
  releaseId: string;
  version: string;
  activatedAt: string;
}

export interface ActiveReleaseArtifact {
  key: string;
  payload: unknown;
}

export interface ActiveReleaseDocument {
  content: string;
  metadata: unknown;
}

interface ActiveSourceArtifact {
  sourceKey: string;
  rawUri: string | null;
  rawHash: string | null;
  collectedAt: string;
}

interface LoadedActiveRelease {
  release: ActiveReleaseIdentity;
  artifacts: ActiveReleaseArtifact[];
  documents: ActiveReleaseDocument[];
  rawArtifacts: ActiveSourceArtifact[];
}

export interface RestoreActiveReleaseOptions {
  rootDir?: string;
  requireRawArtifacts?: boolean;
  databaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  downloadBundle?: (
    rawUri: string,
    expectedRawHash?: string
  ) => Promise<RawArtifactBundleEnvelope>;
}

type RestoreEnvironment = Readonly<Record<string, string | undefined>>;

export interface RestoreActiveReleaseSummary {
  datasetId: string;
  releaseId: string;
  version: string;
  artifactsRestored: number;
  artifactFilesWritten: number;
  documentsRestored: number;
  rawRestoreEnabled: boolean;
  rawSourcesRestored: number;
  rawFilesRestored: number;
}

/**
 * PostgreSQL release artifacts are the canonical browser/file-mode projections.
 * Collector-owned datasets are dual-written because their fetchers produce the
 * same validated object for public and normalized consumers.
 */
export const RELEASE_ARTIFACT_TARGETS: Readonly<Record<string, readonly string[]>> = {
  calendar: ['../ui/public/data/calendar.json', 'data/normalized/calendar.json'],
  clubs: ['../ui/public/data/clubs.json', 'data/normalized/clubs.json'],
  courses: ['../ui/public/data/courses.json'],
  events: ['../ui/public/data/events.json', 'data/normalized/events.json'],
  hours: ['../ui/public/data/hours.json', 'data/normalized/hours.json'],
  programs: ['../ui/public/data/programs.json', 'data/normalized/programs.json'],
  menu: ['data/normalized/menu.json'],
  'menu-week': ['data/normalized/menu-week.json'],
  'dining-hours': ['data/normalized/dining-hours.json'],
  faculty: ['data/normalized/faculty.json'],
};

const RAW_ARTIFACT_ENV_KEYS = [
  'RAW_ARTIFACT_BUCKET',
  'RAW_ARTIFACT_ENDPOINT',
  'RAW_ARTIFACT_ACCESS_KEY_ID',
  'RAW_ARTIFACT_SECRET_ACCESS_KEY',
] as const;

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

export function rawArtifactRestoreEnabled(
  env: RestoreEnvironment,
  requireRawArtifacts: boolean
): boolean {
  const configured = RAW_ARTIFACT_ENV_KEYS.filter((key) => Boolean(env[key]?.trim()));
  if (!configured.length && !requireRawArtifacts) return false;

  const missing = RAW_ARTIFACT_ENV_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(
      `Raw artifact restore requires complete R2 configuration. Missing: ${missing.join(', ')}.`
    );
  }
  return true;
}

export function safeDocumentSourcePath(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('Active release document is missing metadata.');
  }
  const sourcePath = (metadata as { sourcePath?: unknown }).sourcePath;
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new Error('Active release document is missing metadata.sourcePath.');
  }
  if (
    sourcePath.includes('\\') ||
    sourcePath.includes('\0') ||
    path.posix.isAbsolute(sourcePath)
  ) {
    throw new Error(`Unsafe active release document path: ${sourcePath}`);
  }
  const normalized = path.posix.normalize(sourcePath);
  if (
    normalized !== sourcePath ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    !normalized.endsWith('.md')
  ) {
    throw new Error(`Unsafe active release document path: ${sourcePath}`);
  }
  return normalized;
}

function validatedArtifactMap(
  artifacts: ReadonlyArray<ActiveReleaseArtifact>
): Map<string, unknown> {
  const byKey = new Map(artifacts.map((artifact) => [artifact.key, artifact.payload]));
  const missing = Object.keys(RELEASE_ARTIFACT_TARGETS).filter((key) => !byKey.has(key));
  if (missing.length) {
    throw new Error(
      `Active release is missing required release artifact(s): ${missing.join(', ')}.`
    );
  }
  return byKey;
}

function validatedDocuments(
  documents: ReadonlyArray<ActiveReleaseDocument>
): Array<{ sourcePath: string; content: string }> {
  if (!documents.length) throw new Error('Active release has no context documents.');
  const seen = new Set<string>();
  return documents.map((document) => {
    const sourcePath = safeDocumentSourcePath(document.metadata);
    if (seen.has(sourcePath)) {
      throw new Error(`Active release contains duplicate document path: ${sourcePath}.`);
    }
    seen.add(sourcePath);
    if (typeof document.content !== 'string' || !document.content.trim()) {
      throw new Error(`Active release document is empty: ${sourcePath}.`);
    }
    return { sourcePath, content: document.content };
  });
}

export function restoreActiveReleaseFiles(input: {
  rootDir: string;
  release: ActiveReleaseIdentity;
  artifacts: ReadonlyArray<ActiveReleaseArtifact>;
  documents: ReadonlyArray<ActiveReleaseDocument>;
}): { artifactsRestored: number; artifactFilesWritten: number; documentsRestored: number } {
  const rootDir = path.resolve(input.rootDir);
  const artifacts = validatedArtifactMap(input.artifacts);
  const documents = validatedDocuments(input.documents);
  let artifactFilesWritten = 0;

  for (const [key, relativePaths] of Object.entries(RELEASE_ARTIFACT_TARGETS)) {
    const payload = artifacts.get(key);
    for (const relativePath of relativePaths) {
      writeJsonFile(path.join(rootDir, relativePath), payload);
      artifactFilesWritten += 1;
    }
  }

  const contextRoot = path.join(rootDir, 'data', 'context');
  fs.rmSync(contextRoot, { recursive: true, force: true });
  fs.mkdirSync(contextRoot, { recursive: true });
  for (const document of documents) {
    const destination = path.resolve(contextRoot, document.sourcePath);
    if (!destination.startsWith(`${contextRoot}${path.sep}`)) {
      throw new Error(`Unsafe active release document path: ${document.sourcePath}`);
    }
    writeTextFile(destination, document.content);
  }

  writeJsonFile(path.join(rootDir, 'data', 'cache', 'corpus-version.json'), {
    updatedAt: input.release.activatedAt,
    contextIngestedAt: input.release.activatedAt,
    contextSourceCount: documents.length,
    datasetVersion: input.release.version,
    datasetVersionId: input.release.datasetId,
  });

  return {
    artifactsRestored: Object.keys(RELEASE_ARTIFACT_TARGETS).length,
    artifactFilesWritten,
    documentsRestored: documents.length,
  };
}

async function loadActiveRelease(client: PoolClient): Promise<LoadedActiveRelease> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const active = await client.query<{
      dataset_id: string;
      release_id: string;
      version: string;
      activated_at: Date | string | null;
    }>(
      `SELECT
         dataset.id::text AS dataset_id,
         release.id::text AS release_id,
         dataset.version,
         dataset.activated_at
       FROM rockygpt_v2.dataset_versions dataset
       JOIN rockygpt_v2.releases release ON release.dataset_version_id = dataset.id
       WHERE dataset.status = 'active' AND release.status = 'active'
       ORDER BY dataset.activated_at DESC
       LIMIT 1`
    );
    const row = active.rows[0];
    if (!row) throw new Error('No active RockyGPT dataset and release were found.');
    if (!row.activated_at) throw new Error(`Active release ${row.version} has no activation time.`);
    const release: ActiveReleaseIdentity = {
      datasetId: row.dataset_id,
      releaseId: row.release_id,
      version: row.version,
      activatedAt: new Date(row.activated_at).toISOString(),
    };

    const [artifactResult, documentResult, rawResult] = await Promise.all([
      client.query<{ artifact_key: string; payload: unknown }>(
        `SELECT artifact_key, payload
         FROM rockygpt_v2.release_artifacts
         WHERE dataset_version_id = $1::uuid
         ORDER BY artifact_key`,
        [release.datasetId]
      ),
      client.query<{ content: string; metadata: unknown }>(
        `SELECT content, metadata
         FROM rockygpt_v2.documents
         WHERE dataset_version_id = $1::uuid
         ORDER BY metadata->>'sourcePath'`,
        [release.datasetId]
      ),
      client.query<{
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
         FROM rockygpt_v2.release_sources release_source
         JOIN rockygpt_v2.sources source ON source.id = release_source.source_id
         JOIN rockygpt_v2.source_snapshots snapshot ON snapshot.id = release_source.snapshot_id
         JOIN rockygpt_v2.ingestion_runs ingestion ON ingestion.id = snapshot.ingestion_run_id
         LEFT JOIN rockygpt_v2.source_runs source_run
           ON source_run.dataset_version_id = $1::uuid
          AND source_run.source_key = source.source_key
         WHERE release_source.release_id = $2::uuid
         ORDER BY source.source_key`,
        [release.datasetId, release.releaseId]
      ),
    ]);

    await client.query('COMMIT');
    return {
      release,
      artifacts: artifactResult.rows.map((artifact) => ({
        key: artifact.artifact_key,
        payload: artifact.payload,
      })),
      documents: documentResult.rows,
      rawArtifacts: rawResult.rows.map((artifact) => ({
        sourceKey: artifact.source_key,
        rawUri: artifact.raw_uri,
        rawHash: artifact.raw_hash,
        collectedAt: new Date(artifact.collected_at).toISOString(),
      })),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function downloadPinnedRawBundles(
  artifacts: ReadonlyArray<ActiveSourceArtifact>,
  downloadBundle: NonNullable<RestoreActiveReleaseOptions['downloadBundle']>
): Promise<Array<{ artifact: ActiveSourceArtifact; bundle: RawArtifactBundleEnvelope }>> {
  const bySource = new Map(artifacts.map((artifact) => [artifact.sourceKey, artifact]));
  const requiredSources = Object.keys(SOURCE_RAW_DATASETS);
  const missing = requiredSources.filter((sourceKey) => !bySource.get(sourceKey)?.rawUri);
  if (missing.length) {
    throw new Error(
      `Active release is missing archived raw artifact URI(s) for: ${missing.join(', ')}.`
    );
  }

  const downloaded: Array<{
    artifact: ActiveSourceArtifact;
    bundle: RawArtifactBundleEnvelope;
  }> = [];
  for (const sourceKey of requiredSources) {
    const artifact = bySource.get(sourceKey);
    if (!artifact?.rawUri) continue;
    const bundle = await downloadBundle(artifact.rawUri, artifact.rawHash || undefined);
    if (bundle.sourceKey !== sourceKey) {
      throw new Error(
        `Raw artifact source mismatch: expected ${sourceKey}, received ${bundle.sourceKey}.`
      );
    }
    downloaded.push({ artifact, bundle });
  }
  return downloaded;
}

export async function restoreActiveRelease(
  options: RestoreActiveReleaseOptions = {}
): Promise<RestoreActiveReleaseSummary> {
  const env = options.env ?? process.env;
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error('DATABASE_URL is required to restore the active RockyGPT release.');
  }
  const rawRestoreEnabled = rawArtifactRestoreEnabled(
    env,
    options.requireRawArtifacts === true
  );
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    statement_timeout: 30_000,
    application_name: 'rockygpt-active-release-bootstrap',
  });

  try {
    const client = await pool.connect();
    let loaded: LoadedActiveRelease;
    try {
      loaded = await loadActiveRelease(client);
    } finally {
      client.release();
    }

    const downloadedRaw = rawRestoreEnabled
      ? await downloadPinnedRawBundles(
          loaded.rawArtifacts,
          options.downloadBundle ?? downloadRawArtifactBundle
        )
      : [];
    const rootDir = path.resolve(options.rootDir ?? process.cwd());
    const restored = restoreActiveReleaseFiles({
      rootDir,
      release: loaded.release,
      artifacts: loaded.artifacts,
      documents: loaded.documents,
    });

    let rawFilesRestored = 0;
    const rawDir = path.join(rootDir, 'data', 'raw');
    for (const downloaded of downloadedRaw) {
      rawFilesRestored += restoreBundleToRawDirectory(
        downloaded.bundle,
        downloaded.artifact,
        rawDir
      );
    }

    return {
      datasetId: loaded.release.datasetId,
      releaseId: loaded.release.releaseId,
      version: loaded.release.version,
      ...restored,
      rawRestoreEnabled,
      rawSourcesRestored: downloadedRaw.length,
      rawFilesRestored,
    };
  } finally {
    await pool.end();
  }
}
