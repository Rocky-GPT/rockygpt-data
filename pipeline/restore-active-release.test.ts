import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  downloadPinnedRawBundles,
  RELEASE_ARTIFACT_TARGETS,
  restoreActiveReleaseFiles,
  REUSABLE_CAPTURE_SOURCES,
  reusableCapture,
  withUnpublishedCaptures,
} from './restore-active-release';
import { archivedCaptureFromKey, SOURCE_RAW_ARTIFACT_FILES, type RawArtifactBundleEnvelope } from './raw-artifacts';
import { RELEASE_ARTIFACT_FILES } from './release-artifact-files';
import { SOURCE_RAW_DATASETS } from './quality/provenance';
import { writeJsonFile } from '../ingestion/pipeline-utils';

const archived = (sourceKey: string, rawUri: string | null = `r2://raw/${sourceKey}`) => ({
  sourceKey,
  rawUri,
  rawHash: null,
  collectedAt: '2026-09-25T11:00:00.000Z',
});
const bundleFor = async (rawUri: string) =>
  ({ sourceKey: rawUri.replace('r2://raw/', '') }) as unknown as RawArtifactBundleEnvelope;

test('a source added after the active release is left for the refresh to collect', async () => {
  const [added, ...published] = Object.keys(SOURCE_RAW_DATASETS);
  const downloaded = await downloadPinnedRawBundles(published.map((key) => archived(key)), bundleFor);
  assert.deepEqual(
    downloaded.map(({ artifact }) => artifact.sourceKey),
    published
  );
  assert.ok(!downloaded.some(({ artifact }) => artifact.sourceKey === added));
});

test('a published source without its raw archive still stops the restore', async () => {
  const [unarchived, ...published] = Object.keys(SOURCE_RAW_DATASETS);
  await assert.rejects(
    downloadPinnedRawBundles(
      [archived(unarchived, null), ...published.map((key) => archived(key))],
      bundleFor
    ),
    new RegExp(`missing archived raw artifact URI\\(s\\) for: ${unarchived}\\.`)
  );
});

test('legacy release restoration removes an optional manifest left by another release', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-restore-release-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const omissionsPath = path.join(rootDir, 'data/normalized/hours-omissions.json');
  writeJsonFile(omissionsPath, { version: 1, omitted: [{ record: 'unrelated release' }] });
  const artifacts = Object.keys(RELEASE_ARTIFACT_TARGETS)
    .filter((key) => key !== 'hours-omissions')
    .map((key) => ({ key, payload: [] }));
  const summary = restoreActiveReleaseFiles({
    rootDir,
    release: { datasetId: 'dataset', releaseId: 'release', version: 'legacy-release', activatedAt: '2026-09-23T12:00:00Z' },
    artifacts,
    documents: [{ content: '# Source document', metadata: { sourcePath: 'hours/source.md' } }],
  });
  assert.equal(fs.existsSync(omissionsPath), false);
  assert.equal(summary.artifactsRestored, artifacts.length);
  assert.equal(fs.readFileSync(path.join(rootDir, 'data/context/hours/source.md'), 'utf8'), '# Source document');
});

test('a release made before the office reviews keeps the committed review files', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-restore-release-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const reviews = ['office-contact-review', 'office-hours-review'];
  const reviewPaths = reviews.map((key) => path.join(rootDir, RELEASE_ARTIFACT_TARGETS[key][0]));
  for (const reviewPath of reviewPaths) writeJsonFile(reviewPath, { schema_version: 1, offices: [] });
  restoreActiveReleaseFiles({
    rootDir,
    release: { datasetId: 'dataset', releaseId: 'release', version: 'before-reviews', activatedAt: '2026-10-07T12:00:00Z' },
    artifacts: Object.keys(RELEASE_ARTIFACT_TARGETS)
      .filter((key) => !reviews.includes(key))
      .map((key) => ({ key, payload: [] })),
    documents: [{ content: '# Source document', metadata: { sourcePath: 'hours/source.md' } }],
  });
  for (const reviewPath of reviewPaths) assert.ok(fs.existsSync(reviewPath), `${reviewPath} was removed.`);
});

// Published artifacts that come back without a release artifact target: the
// search vocabulary is committed, and context markdown is restored from the
// release's documents.
const RESTORED_ANOTHER_WAY = new Set([
  'search-vocabulary',
  'menu-context',
  'transportation',
  'dining-hours-context',
]);

test('the restore writes every file the publisher saves', () => {
  for (const [key, relativePath] of Object.entries(RELEASE_ARTIFACT_FILES)) {
    if (RESTORED_ANOTHER_WAY.has(key)) {
      assert.ok(
        relativePath.startsWith('src/') || relativePath.startsWith('data/context/'),
        `${key} is exempt from restore but ${relativePath} is neither committed nor a context document.`
      );
      continue;
    }
    assert.ok(
      RELEASE_ARTIFACT_TARGETS[key]?.includes(relativePath),
      `Publish saves ${key} from ${relativePath}, but the restore does not write it back.`
    );
  }
});

test('the restore only expects artifacts the publisher saves', () => {
  for (const key of Object.keys(RELEASE_ARTIFACT_TARGETS)) {
    assert.ok(key in RELEASE_ARTIFACT_FILES, `The restore expects ${key}, which publish never saves.`);
  }
});

const HASH = 'a'.repeat(64);
const capture = (collectedAt: string, sourceKey = 'office-pages') => ({
  rawUri: `s3://archive/raw/${sourceKey}/${collectedAt.replace(/[:.]/g, '-')}/${HASH}.json.gz`, rawHash: HASH, collectedAt,
});

test('an archived capture is read back from the key the publish gave it', () => {
  const key = `raw/office-pages/2026-11-10T12-10-05-123Z/${HASH}.json.gz`;
  assert.deepEqual(archivedCaptureFromKey('archive', 'office-pages', key),
    { rawUri: `s3://archive/${key}`, rawHash: HASH, collectedAt: '2026-11-10T12:10:05.123Z' });
  // Another source's folder, a stray file, a hash that is not one.
  assert.equal(archivedCaptureFromKey('archive', 'housing', key), null);
  assert.equal(archivedCaptureFromKey('archive', 'office-pages', 'raw/office-pages/notes.txt'), null);
  assert.equal(archivedCaptureFromKey('archive', 'office-pages', 'raw/office-pages/2026-11-10T12-10-05-123Z/short.json.gz'), null);
});

test('pages a failed publish collected stand in for a new download the next night only', () => {
  const release = { collectedAt: '2026-11-01T12:00:00.000Z' };
  const lastNight = capture('2026-11-08T12:10:00.000Z');
  const archive = [capture('2026-11-01T12:00:00.000Z'), lastNight, capture('2026-10-25T12:00:00.000Z')];
  // The next night's run, and a run started by hand the same afternoon after a fix.
  assert.deepEqual(reusableCapture(release, archive, new Date('2026-11-09T12:06:00Z')), lastNight);
  assert.deepEqual(reusableCapture(release, archive, new Date('2026-11-08T15:00:00Z')), lastNight);
  // It failed to publish twice: the third night downloads the source again.
  assert.equal(reusableCapture(release, archive, new Date('2026-11-10T11:44:00Z')), null);
  // Once published, the release holds that very capture and nothing is newer.
  assert.equal(reusableCapture({ collectedAt: '2026-11-08T12:10:00.000Z' }, archive, new Date('2026-11-09T12:06:00Z')), null);
  assert.equal(reusableCapture({ collectedAt: '2026-11-08T12:10:00.000123Z' }, archive, new Date('2026-11-09T12:06:00Z')), null);
  assert.equal(reusableCapture(release, [], new Date('2026-11-09T12:06:00Z')), null);
});

test('only page-only sources are restored from an unpublished capture, and trouble falls back to the release', async () => {
  const now = new Date('2026-11-09T12:06:00Z');
  const released = (sourceKey: string) => ({ sourceKey, rawUri: `s3://archive/raw/${sourceKey}/released`, rawHash: 'r', collectedAt: '2026-11-01T12:00:00.000Z' });
  const artifacts = ['office-pages', 'housing', 'dining', 'health'].map(released);
  const warnings: string[] = [];
  const listed: string[] = [];
  const result = await withUnpublishedCaptures(artifacts, {
    now,
    log: (line) => warnings.push(line),
    listCaptures: async (sourceKey) => {
      listed.push(sourceKey);
      if (sourceKey === 'health') throw new Error('the archive did not answer');
      return [capture('2026-11-08T12:10:00.000Z', sourceKey)];
    },
    downloadBundle: async (rawUri) => {
      if (rawUri.includes('/housing/2026')) throw new Error('Raw artifact hash mismatch');
      return { version: 1, sourceKey: rawUri.split('/')[4], entries: [] };
    },
  });
  // Dining is not a page-only source: its archive is never even listed.
  assert.deepEqual(listed, ['office-pages', 'housing', 'health']);
  assert.deepEqual(result.reused, [{ sourceKey: 'office-pages', collectedAt: '2026-11-08T12:10:00.000Z' }]);
  assert.deepEqual(result.artifacts.map((artifact) => [artifact.sourceKey, artifact.collectedAt]), [
    ['office-pages', '2026-11-08T12:10:00.000Z'], ['housing', '2026-11-01T12:00:00.000Z'],
    ['dining', '2026-11-01T12:00:00.000Z'], ['health', '2026-11-01T12:00:00.000Z'],
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^Could not reuse a newer capture of housing; restoring the release's own: Raw artifact hash mismatch/);
  assert.match(warnings[1], /^Could not reuse a newer capture of health; restoring the release's own: the archive did not answer/);
  // The newer bundle was read once, to check it, and is handed to the restore without a second download.
  const bundle = await result.downloadBundle(result.artifacts[0].rawUri!, HASH);
  assert.equal(bundle.sourceKey, 'office-pages');
});

test('every reusable source is archived as pages with their HTML', () => {
  for (const sourceKey of REUSABLE_CAPTURE_SOURCES) {
    const files = SOURCE_RAW_ARTIFACT_FILES[sourceKey];
    assert.ok(files?.some((file) => file.endsWith('-sources.raw.json')), `${sourceKey} has no page capture to rebuild from.`);
  }
});
