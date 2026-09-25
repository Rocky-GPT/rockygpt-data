import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  downloadPinnedRawBundles,
  RELEASE_ARTIFACT_TARGETS,
  restoreActiveReleaseFiles,
} from './restore-active-release';
import type { RawArtifactBundleEnvelope } from './raw-artifacts';
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
