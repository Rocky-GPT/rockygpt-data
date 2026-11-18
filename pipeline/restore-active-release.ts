import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import {
  downloadRawArtifactBundle,
  listArchivedCaptures,
  type ArchivedCapture,
  type RawArtifactBundleEnvelope,
} from './raw-artifacts';
import { SOURCE_RAW_DATASETS } from './quality/provenance';
import { restoreBundleToRawDirectory } from './restore-active-raw';
import { writeJsonFile } from '../ingestion/pipeline-utils';
import { RELEASE_ARTIFACT_FILES } from './release-artifact-files';
import {
  RELEASE_SNAPSHOT_FILE,
  inJsonbKeyOrder,
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

interface ActiveSourceArtifact {
  sourceKey: string;
  rawUri: string | null;
  rawHash: string | null;
  collectedAt: string;
}

interface LoadedActiveRelease {
  release: ActiveReleaseIdentity;
  artifacts: ActiveReleaseArtifact[];
  rawArtifacts: ActiveSourceArtifact[];
  /** How many artifacts came from the database rather than the saved copy. */
  downloaded: { artifacts: number };
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
  /**
   * The nightly refresh only: restore a source's pages from a newer archived capture no release
   * holds yet (the last run collected them, then its publish failed), so they are not downloaded
   * from Ramapo's sites again. See reusableCapture.
   */
  reuseUnpublishedCaptures?: boolean;
  listCaptures?: (sourceKey: string) => Promise<ArchivedCapture[]>;
  now?: Date;
}

type RestoreEnvironment = Readonly<Record<string, string | undefined>>;

export interface RestoreActiveReleaseSummary {
  datasetId: string;
  releaseId: string;
  version: string;
  artifactsRestored: number;
  artifactFilesWritten: number;
  /** Artifacts read from the database; the rest matched the saved copy. */
  artifactsDownloaded: number;
  rawRestoreEnabled: boolean;
  rawSourcesRestored: number;
  rawFilesRestored: number;
  rawSourcesRequiringRefresh: string[];
  /** Sources restored from a capture newer than the active release's, and when each was collected. */
  rawSourcesReused: Array<{ sourceKey: string; collectedAt: string }>;
}

/**
 * Sources a run may restore from an archived capture the active release does not hold. Each is
 * collected as pages only (raw-collector.ts), and normalize:raw rebuilds all
 * it publishes from those pages, so the archived bundle is everything its collector wrote. They
 * are also nearly all of a night's requests to Ramapo's sites (3,631 pages on November 10, 2026).
 */
export const REUSABLE_CAPTURE_SOURCES: readonly string[] = [
  'public-safety', 'campus-directory', 'transportation', 'housing', 'health', 'counseling',
  'office-pages', 'academic-sites',
];

/**
 * How old an unpublished capture may be and still stand in for a new download. A day and a half
 * covers the next night's run and any run started by hand after a fix. A capture that old has
 * already failed to publish twice, so the run after that collects the source again: if the pages
 * themselves were the problem, a fresh download gets its chance.
 */
export const REUSABLE_CAPTURE_MAX_AGE_HOURS = 36;

/**
 * The capture to restore in place of the active release's, or null to keep the release's.
 *
 * A publish archives every source's raw files after the quality gates and before its own last
 * gates. When one of those stops it, the pages it collected belong to no release, and the next run
 * used to restore the last release's older pages, find them due, and download every page again
 * (November 8 to 10, 2026: 9,743 pages over three nights, none of them published). The newest
 * archived capture is used instead when it is newer than the release's and no older than
 * REUSABLE_CAPTURE_MAX_AGE_HOURS.
 */
export function reusableCapture(
  release: { collectedAt: string },
  archived: readonly ArchivedCapture[],
  now: Date
): ArchivedCapture | null {
  const releaseAt = Date.parse(release.collectedAt);
  const newest = archived
    .filter((capture) => Number.isFinite(Date.parse(capture.collectedAt)))
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0];
  if (!newest) return null;
  const at = Date.parse(newest.collectedAt);
  // The release's own bundle carries the same time, give or take the database's rounding.
  if (!(at - releaseAt > 1000)) return null;
  const ageHours = (now.getTime() - at) / 3_600_000;
  if (ageHours < 0 || ageHours > REUSABLE_CAPTURE_MAX_AGE_HOURS) return null;
  return newest;
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

export function restoreActiveReleaseFiles(input: {
  rootDir: string;
  release: ActiveReleaseIdentity;
  artifacts: ReadonlyArray<ActiveReleaseArtifact>;
}): { artifactsRestored: number; artifactFilesWritten: number } {
  const rootDir = path.resolve(input.rootDir);
  const artifacts = validatedArtifactMap(input.artifacts);
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

  writeJsonFile(path.join(rootDir, 'data', 'cache', 'corpus-version.json'), {
    updatedAt: input.release.activatedAt,
    datasetVersion: input.release.version,
    datasetVersionId: input.release.datasetId,
  });

  return {
    artifactsRestored: Object.keys(RELEASE_ARTIFACT_TARGETS).filter((key) => artifacts.has(key)).length,
    artifactFilesWritten,
  };
}

/**
 * The artifacts the saved copy holds with the database's exact hashes. An artifact
 * is parsed as the database would return its jsonb payload, so either way the same files are
 * written.
 */
export function fromSnapshot(
  snapshot: ReleaseSnapshot | null,
  artifactHashes: ReadonlyArray<{ artifact_key: string; content_hash: string }>
): {
  artifacts: Array<{ key: string; payload: unknown }>;
} {
  if (!snapshot) return { artifacts: [] };
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
  return { artifacts };
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

    // Only the hashes first: an artifact the saved copy already holds (same hash) is not
    // downloaded again; the rest are read in this same snapshot of the database.
    const restoredKeys = Object.keys(RELEASE_ARTIFACT_TARGETS);
    const artifactHashes = await client.query<{ artifact_key: string; content_hash: string }>(
      `SELECT artifact_key, content_hash
       FROM rockygpt_v2.release_artifacts
       WHERE dataset_version_id = $1::uuid AND artifact_key = ANY($2::text[])
       ORDER BY artifact_key`,
      [release.datasetId, restoredKeys]
    );
    const kept = fromSnapshot(snapshot, artifactHashes.rows);
    const missingKeys = artifactHashes.rows
      .map((row) => row.artifact_key)
      .filter((key) => !kept.artifacts.some((artifact) => artifact.key === key));

    const [artifactResult, rawResult] = await Promise.all([
      missingKeys.length
        ? client.query<{ artifact_key: string; payload: unknown }>(
            `SELECT artifact_key, payload
             FROM rockygpt_v2.release_artifacts
             WHERE dataset_version_id = $1::uuid AND artifact_key = ANY($2::text[])
             ORDER BY artifact_key`,
            [release.datasetId, missingKeys]
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
      downloaded: { artifacts: artifactResult.rows.length },
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

/**
 * Each source's archived capture to restore: the active release's, or for a reusable source a
 * newer one no release holds yet. Finding or reading the newer one must never stop a refresh, so
 * any trouble with it falls back to the release's own capture (and the source is collected again
 * if it is due).
 */
export async function withUnpublishedCaptures(
  artifacts: ReadonlyArray<ActiveSourceArtifact>,
  options: {
    listCaptures: (sourceKey: string) => Promise<ArchivedCapture[]>;
    downloadBundle: NonNullable<RestoreActiveReleaseOptions['downloadBundle']>;
    now: Date;
    log?: (line: string) => void;
  }
): Promise<{
  artifacts: ActiveSourceArtifact[];
  reused: Array<{ sourceKey: string; collectedAt: string }>;
  downloadBundle: NonNullable<RestoreActiveReleaseOptions['downloadBundle']>;
}> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const fetched = new Map<string, RawArtifactBundleEnvelope>();
  const reused: Array<{ sourceKey: string; collectedAt: string }> = [];
  const chosen: ActiveSourceArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact.rawUri || !REUSABLE_CAPTURE_SOURCES.includes(artifact.sourceKey)) {
      chosen.push(artifact);
      continue;
    }
    try {
      const newer = reusableCapture(artifact, await options.listCaptures(artifact.sourceKey), options.now);
      if (!newer || newer.rawUri === artifact.rawUri) {
        chosen.push(artifact);
        continue;
      }
      const bundle = await options.downloadBundle(newer.rawUri, newer.rawHash);
      if (bundle.sourceKey !== artifact.sourceKey) throw new Error(`the bundle belongs to ${bundle.sourceKey}`);
      fetched.set(newer.rawUri, bundle);
      chosen.push({ ...artifact, ...newer });
      reused.push({ sourceKey: artifact.sourceKey, collectedAt: newer.collectedAt });
    } catch (error) {
      log(`Could not reuse a newer capture of ${artifact.sourceKey}; restoring the release's own: ` +
        `${error instanceof Error ? error.message : String(error)}`);
      chosen.push(artifact);
    }
  }
  return {
    artifacts: chosen,
    reused,
    downloadBundle: async (rawUri, expectedRawHash) =>
      fetched.get(rawUri) ?? options.downloadBundle(rawUri, expectedRawHash),
  };
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

    const downloadBundle = options.downloadBundle ?? downloadRawArtifactBundle;
    const captures = rawRestoreEnabled && options.reuseUnpublishedCaptures
      ? await withUnpublishedCaptures(loaded.rawArtifacts, {
          listCaptures: options.listCaptures ?? listArchivedCaptures,
          downloadBundle,
          now: options.now ?? new Date(),
        })
      : { artifacts: loaded.rawArtifacts, reused: [], downloadBundle };
    const downloadedRaw = rawRestoreEnabled
      ? await downloadPinnedRawBundles(captures.artifacts, captures.downloadBundle)
      : [];
    const restored = restoreActiveReleaseFiles({
      rootDir,
      release: loaded.release,
      artifacts: loaded.artifacts,
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
      rawRestoreEnabled,
      rawSourcesRestored: downloadedRaw.length - rawSourcesRequiringRefresh.length,
      rawFilesRestored,
      rawSourcesRequiringRefresh,
      rawSourcesReused: captures.reused.filter(
        (entry) => !rawSourcesRequiringRefresh.includes(entry.sourceKey)
      ),
    };
  } finally {
    await pool.end();
  }
}
