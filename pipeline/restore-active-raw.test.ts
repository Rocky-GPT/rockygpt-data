import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { restoreBundleToRawDirectory } from './restore-active-raw';
import { type RawArtifactBundleEnvelope } from './raw-artifacts';
import { evaluateSourceProvenance, readRawProvenance } from './quality/provenance';
import { refreshScriptsForStates } from '../ingestion/refresh-publishable';
import { writeJsonFile, writeRawProvenance } from '../ingestion/pipeline-utils';

const sourceKey = 'campus-hours';
const collectedAt = '2026-09-23T12:00:00Z';
const artifact = { sourceKey, collectedAt };
const hours = [{ name: 'Published facility', hours: { Monday: 'Closed' } }];
const captures = { version: 1, captures: [{ sourceUrl: 'https://example.edu/hours', html: 'captured', collectedAt }] };
const entry = (file: string, content: unknown) => ({ file, content, sha256: 'verified-envelope-hash' });
const bundle = (entries: RawArtifactBundleEnvelope['entries']): RawArtifactBundleEnvelope => ({ version: 1, sourceKey, entries });

function tempDirectory(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-restore-raw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedUnrelatedCapture(rawDir: string): void {
  for (const dataset of ['hours', 'hours-sources']) {
    const payload = { unrelatedLocalPayload: dataset };
    writeJsonFile(path.join(rawDir, `${dataset}.raw.json`), payload);
    writeRawProvenance(dataset, { payload, fetchedAt: collectedAt }, rawDir);
  }
}

test('complete pinned archives restore all inputs with their original collection time', (t) => {
  const rawDir = tempDirectory(t);
  const count = restoreBundleToRawDirectory(bundle([
    entry('hours.raw.json', hours), entry('hours-sources.raw.json', captures),
  ]), artifact, rawDir);
  assert.equal(count, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rawDir, 'hours-sources.raw.json'), 'utf8')), captures);
  assert.equal(readRawProvenance('hours', rawDir)?.fetchedAt, collectedAt);
  assert.equal(readRawProvenance('hours-sources', rawDir)?.fetchedAt, collectedAt);
});

test('strict restore cannot use local leftovers to complete an archived source', (t) => {
  const rawDir = tempDirectory(t);
  seedUnrelatedCapture(rawDir);
  const before = new Map(fs.readdirSync(rawDir).map((file) => [file, fs.readFileSync(path.join(rawDir, file), 'utf8')]));
  assert.throws(() => restoreBundleToRawDirectory(bundle([entry('hours.raw.json', hours)]), artifact, rawDir), /missing required file.*hours-sources/);
  for (const [file, content] of before) assert.equal(fs.readFileSync(path.join(rawDir, file), 'utf8'), content);
});

test('refresh discards incomplete legacy source state and schedules its collector', (t) => {
  const rawDir = tempDirectory(t);
  seedUnrelatedCapture(rawDir);
  const count = restoreBundleToRawDirectory(bundle([entry('hours.raw.json', hours)]), artifact, rawDir, { allowIncomplete: true });
  assert.equal(count, 0);
  assert.deepEqual(fs.readdirSync(rawDir), []);
  const states = evaluateSourceProvenance([{ key: sourceKey, freshnessHours: 72 }], new Date(collectedAt), rawDir);
  assert.equal(states[0]?.status, 'unknown');
  assert.deepEqual(refreshScriptsForStates(states), ['fetch:hours']);
});

test('unsafe or ambiguous archives still fail before writing in refresh mode', (t) => {
  const rawDir = tempDirectory(t);
  for (const entries of [
    [entry('hours.raw.json', hours), entry('../outside.json', {})],
    [entry('hours.raw.json', hours), entry('hours.raw.json', [])],
  ]) {
    assert.throws(() => restoreBundleToRawDirectory(bundle(entries), artifact, rawDir, { allowIncomplete: true }), /Unsafe|duplicate/);
    assert.deepEqual(fs.readdirSync(rawDir), []);
  }
  assert.throws(() => restoreBundleToRawDirectory({ ...bundle([]), sourceKey: 'dining' }, artifact, rawDir, { allowIncomplete: true }), /source mismatch/);
});
