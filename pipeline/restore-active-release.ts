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
import { RELEASE_ARTIFACT_FILES } from './release-artifact-files';
import {
  RELEASE_SNAPSHOT_FILE,
  inJsonbKeyOrder,
  md5,
  readReleaseSnapshot,
  sha256,
  type ReleaseSnapshot,
} from './release-snapshot';

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
  /** How many artifacts and documents came from the database rather than the saved copy. */
  downloaded: { artifacts: number; documents: number };
}

export interface RestoreActiveReleaseOptions {
  rootDir?: string;
  /** The publisher's saved copy of the release (default: .release-snapshot/release.json). */
  snapshotFile?: string;
  requireRawArtifacts?: boolean;
  /** Only refresh workflows can discard incomplete legacy captures and recollect. */
  allowIncompleteRawArtifacts?: boolean;
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
  /** Artifacts and documents read from the database; the rest matched the saved copy. */
  artifactsDownloaded: number;
  documentsDownloaded: number;
  rawRestoreEnabled: boolean;
  rawSourcesRestored: number;
  rawFilesRestored: number;
  rawSourcesRequiringRefresh: string[];
}

/**
 * PostgreSQL release artifacts are the canonical browser/file-mode projections.
 * Collector-owned datasets are dual-written because their fetchers produce the
 * same validated object for public and normalized consumers.
 */
export const RELEASE_ARTIFACT_TARGETS: Readonly<Record<string, readonly string[]>> = {
  calendar: ['public/data/calendar.json', 'data/normalized/calendar.json'],
  clubs: ['public/data/clubs.json', 'data/normalized/clubs.json'],
  courses: ['public/data/courses.json'],
  events: ['public/data/events.json', 'data/normalized/events.json'],
  hours: ['public/data/hours.json', 'data/normalized/hours.json'],
  'hours-omissions': ['data/normalized/hours-omissions.json'],
  'office-contact-review': ['src/reference/office-contact-review.json'],
  'office-hours-review': ['src/reference/office-hours-review.json'],
  programs: ['public/data/programs.json', 'data/normalized/programs.json'],
  'graduation-plans': ['public/data/graduation-plans.json'],
  'major-pages': ['public/data/major-pages.json'],
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
  // Legacy releases predate the omission manifest. Restore them so the
  // compatibility/provenance checks can request a fresh hours collection.
  const missing = Object.keys(RELEASE_ARTIFACT_TARGETS).filter((key) =>
    !['hours-omissions', 'office-contact-review', 'office-hours-review'].includes(key) && !byKey.has(key));
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
    if (!artifacts.has(key)) {
      // Optional artifacts absent from this release must not retain another
      // release's local projection. Committed reference files (src/) are not
      // projections: a release made before they existed keeps the checked-in copy.
      for (const relativePath of relativePaths) {
        if (!relativePath.startsWith('src/')) fs.rmSync(path.join(rootDir, relativePath), { force: true });
      }
      continue;
    }
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
    artifactsRestored: Object.keys(RELEASE_ARTIFACT_TARGETS).filter((key) => artifacts.has(key)).length,
    artifactFilesWritten,
    documentsRestored: documents.length,
  };
}

/**
 * The artifacts and documents the saved copy holds with the database's exact hashes. An artifact
 * is parsed as the database would return its jsonb payload, so either way the same files are
 * written.
 */
export function fromSnapshot(
  snapshot: ReleaseSnapshot | null,
  artifactHashes: ReadonlyArray<{ artifact_key: string; content_hash: string }>,
  documentHashes: ReadonlyArray<{ source_path: string | null; content_md5: string }>
): {
  artifacts: Array<{ key: string; payload: unknown }>;
  documents: Array<{ sourcePath: string; content: string }>;
} {
  if (!snapshot) return { artifacts: [], documents: [] };
  const artifacts: Array<{ key: string; payload: unknown }> = [];
  for (const { artifact_key: key, content_hash: hash } of artifactHashes) {
    const text = snapshot.artifacts[key];
    if (text === undefined || sha256(text) !== hash) continue;
    try {
      const payload = RELEASE_ARTIFACT_FILES[key]?.endsWith('.json')
        ? inJsonbKeyOrder(JSON.parse(text))
        : { content: text };
      artifacts.push({ key, payload });
    } catch {
      // Unreadable here: read from the database instead.
    }
  }
  const documents: Array<{ sourcePath: string; content: string }> = [];
  for (const { source_path: sourcePath, content_md5: hash } of documentHashes) {
    if (sourcePath === null) continue;
    const content = snapshot.documents[sourcePath];
    if (content !== undefined && md5(content) === hash) documents.push({ sourcePath, content });
  }
  return { artifacts, documents };
}

async function loadActiveRelease(
  client: PoolClient,
  snapshot: ReleaseSnapshot | null
): Promise<LoadedActiveRelease> {
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

    // Only the hashes first: an artifact or document the saved copy already holds (same hash)
    // is not downloaded again; the rest are read in this same snapshot of the database.
    const restoredKeys = Object.keys(RELEASE_ARTIFACT_TARGETS);
    const [artifactHashes, documentHashes] = await Promise.all([
      client.query<{ artifact_key: string; content_hash: string }>(
        `SELECT artifact_key, content_hash
         FROM rockygpt_v2.release_artifacts
         WHERE dataset_version_id = $1::uuid AND artifact_key = ANY($2::text[])
         ORDER BY artifact_key`,
        [release.datasetId, restoredKeys]
      ),
      client.query<{ source_path: string | null; content_md5: string }>(
        `SELECT metadata->>'sourcePath' AS source_path, md5(content) AS content_md5
         FROM rockygpt_v2.documents
         WHERE dataset_version_id = $1::uuid
         ORDER BY metadata->>'sourcePath'`,
        [release.datasetId]
      ),
    ]);
    const kept = fromSnapshot(snapshot, artifactHashes.rows, documentHashes.rows);
    const missingKeys = artifactHashes.rows
      .map((row) => row.artifact_key)
      .filter((key) => !kept.artifacts.some((artifact) => artifact.key === key));
    const keptPaths = new Set(kept.documents.map((document) => document.sourcePath));
    const missingPaths = documentHashes.rows
      .filter((row) => row.source_path === null || !keptPaths.has(row.source_path))
      .map((row) => row.source_path);

    const [artifactResult, documentResult, rawResult] = await Promise.all([
      missingKeys.length
        ? client.query<{ artifact_key: string; payload: unknown }>(
            `SELECT artifact_key, payload
             FROM rockygpt_v2.release_artifacts
             WHERE dataset_version_id = $1::uuid AND artifact_key = ANY($2::text[])
             ORDER BY artifact_key`,
            [release.datasetId, missingKeys]
          )
        : { rows: [] },
      missingPaths.length
        ? client.query<{ content: string; metadata: unknown }>(
            `SELECT content, metadata
             FROM rockygpt_v2.documents
             WHERE dataset_version_id = $1::uuid
               AND (metadata->>'sourcePath' = ANY($2::text[]) OR metadata->>'sourcePath' IS NULL)
             ORDER BY metadata->>'sourcePath'`,
            [release.datasetId, missingPaths.filter((sourcePath) => sourcePath !== null)]
          )
        : { rows: [] },
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
      artifacts: [
        ...kept.artifacts.map(({ key, payload }) => ({ key, payload })),
        ...artifactResult.rows.map((artifact) => ({
          key: artifact.artifact_key,
          payload: artifact.payload,
        })),
      ],
      documents: [
        ...kept.documents.map(({ sourcePath, content }) => ({ content, metadata: { sourcePath } })),
        ...documentResult.rows,
      ],
      downloaded: { artifacts: artifactResult.rows.length, documents: documentResult.rows.length },
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

export async function downloadPinnedRawBundles(
  artifacts: ReadonlyArray<ActiveSourceArtifact>,
  downloadBundle: NonNullable<RestoreActiveReleaseOptions['downloadBundle']>
): Promise<Array<{ artifact: ActiveSourceArtifact; bundle: RawArtifactBundleEnvelope }>> {
  const bySource = new Map(artifacts.map((artifact) => [artifact.sourceKey, artifact]));
  const requiredSources = Object.keys(SOURCE_RAW_DATASETS);
  // A source added after the active release was published has nothing to
  // restore; with no raw capture its provenance reads unknown, so the refresh
  // collects it. A source the release did publish without an archive cannot be
  // restored faithfully, so that still stops the refresh.
  const missing = requiredSources.filter(
    (sourceKey) => bySource.has(sourceKey) && !bySource.get(sourceKey)?.rawUri
  );
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

  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const snapshot = readReleaseSnapshot(
    options.snapshotFile ?? path.join(rootDir, RELEASE_SNAPSHOT_FILE)
  );

  try {
    const client = await pool.connect();
    let loaded: LoadedActiveRelease;
    try {
      loaded = await loadActiveRelease(client, snapshot);
    } finally {
      client.release();
    }

    const downloadedRaw = rawRestoreEnabled
      ? await downloadPinnedRawBundles(
          loaded.rawArtifacts,
          options.downloadBundle ?? downloadRawArtifactBundle
        )
      : [];
    const restored = restoreActiveReleaseFiles({
      rootDir,
      release: loaded.release,
      artifacts: loaded.artifacts,
      documents: loaded.documents,
    });

    let rawFilesRestored = 0;
    const rawSourcesRequiringRefresh: string[] = [];
    const rawDir = path.join(rootDir, 'data', 'raw');
    for (const downloaded of downloadedRaw) {
      const filesRestored = restoreBundleToRawDirectory(
        downloaded.bundle,
        downloaded.artifact,
        rawDir,
        { allowIncomplete: options.allowIncompleteRawArtifacts }
      );
      rawFilesRestored += filesRestored;
      if (filesRestored === 0) rawSourcesRequiringRefresh.push(downloaded.artifact.sourceKey);
    }

    return {
      datasetId: loaded.release.datasetId,
      releaseId: loaded.release.releaseId,
      version: loaded.release.version,
      ...restored,
      artifactsDownloaded: loaded.downloaded.artifacts,
      documentsDownloaded: loaded.downloaded.documents,
      rawRestoreEnabled,
      rawSourcesRestored: downloadedRaw.length - rawSourcesRequiringRefresh.length,
      rawFilesRestored,
      rawSourcesRequiringRefresh,
    };
  } finally {
    await pool.end();
  }
}
