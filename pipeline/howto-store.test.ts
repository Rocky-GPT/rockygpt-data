import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HOWTO_PAGES_WORTH_GUARDING, HOWTO_STORE_FILE, HOWTO_STORE_SOURCE, howtoPagesShortfall, mergeReadings, readingsDigest,
  restoreHowtoReadings, saveHowtoReadings,
  type HowtoStoreDeps,
} from './howto-store';
import { buildRawArtifactBundle, decodeRawArtifactBundle, type ArchivedCapture } from './raw-artifacts';
import type { HowtoCapture } from '../ingestion/howto-entries';

const reading = (key: string, readAt: string, steps = 1) => ({ key, url: 'https://www.ramapo.edu/registrar/', model: 'gpt-6-luna',
  read_at: readAt, reply: { entries: Array.from({ length: steps }, (_, index) => ({ task: `task ${index}` })) } });
const capture = (pages: HowtoCapture['pages']): HowtoCapture => ({ dataset: 'howto-entries', pages });

function rawDirWith(pages?: HowtoCapture['pages']): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'howto-store-'));
  if (pages) fs.writeFileSync(path.join(directory, HOWTO_STORE_FILE), JSON.stringify(capture(pages)));
  return directory;
}
const onDisk = (rawDir: string): HowtoCapture => JSON.parse(fs.readFileSync(path.join(rawDir, HOWTO_STORE_FILE), 'utf8')) as HowtoCapture;

/** A file store in memory that keeps what archive() is given, as the real one does. */
function memoryStore(): HowtoStoreDeps & { objects: Array<ArchivedCapture & { body: Buffer }>; waits: number[] } {
  const objects: Array<ArchivedCapture & { body: Buffer }> = [];
  const waits: number[] = [];
  return {
    objects, waits,
    list: async sourceKey => { assert.equal(sourceKey, HOWTO_STORE_SOURCE); return objects.map(({ rawUri, rawHash, collectedAt }) => ({ rawUri, rawHash, collectedAt })); },
    download: async (rawUri, expectedRawHash) => decodeRawArtifactBundle(objects.find(object => object.rawUri === rawUri)!.body, expectedRawHash),
    archive: async (sourceKey, collectedAt, rawDir) => {
      const bundle = buildRawArtifactBundle(sourceKey, rawDir);
      if (!bundle) return null;
      const rawUri = `s3://test/raw/${sourceKey}/${collectedAt}/${bundle.rawHash}.json.gz`;
      objects.push({ rawUri, rawHash: bundle.rawHash, collectedAt, body: bundle.body });
      return { sourceKey, rawHash: bundle.rawHash, rawUri, objectKey: rawUri, stored: true, compressedBytes: bundle.body.byteLength };
    },
    wait: async milliseconds => { waits.push(milliseconds); },
  };
}

test('for each page the reading made last is kept, and the one on disk on a tie', () => {
  const merged = mergeReadings(
    capture({ a: reading('a2', '2026-11-10T04:00:00.000Z'), b: reading('b1', '2026-11-08T04:00:00.000Z'), d: reading('d-local', '2026-11-09T04:00:00.000Z') }),
    capture({ a: reading('a1', '2026-11-09T04:00:00.000Z'), b: reading('b2', '2026-11-09T04:00:00.000Z'), c: reading('c1', '2026-11-09T04:00:00.000Z'),
      d: reading('d-stored', '2026-11-09T04:00:00.000Z') }));
  assert.deepEqual(Object.fromEntries(Object.entries(merged.pages).map(([page, read]) => [page, read.key])),
    { a: 'a2', b: 'b2', c: 'c1', d: 'd-local' });
});

test('the digest tells readings apart whatever the order of their pages', () => {
  const one = capture({ a: reading('a1', '2026-11-09T04:00:00.000Z'), b: reading('b1', '2026-11-09T04:00:00.000Z') });
  const sameReordered = capture({ b: reading('b1', '2026-11-09T04:00:00.000Z'), a: reading('a1', '2026-11-09T04:00:00.000Z') });
  const reread = capture({ a: reading('a1', '2026-11-10T04:00:00.000Z'), b: reading('b1', '2026-11-09T04:00:00.000Z') });
  assert.equal(readingsDigest(one), readingsDigest(sameReordered));
  assert.notEqual(readingsDigest(one), readingsDigest(reread));
});

test('a night saves its readings and the next night starts from them', async () => {
  const store = memoryStore();
  const firstNight = rawDirWith();
  const empty = await restoreHowtoReadings(firstNight, store);
  assert.deepEqual(empty, { pages: 0, fromStore: 0, archivedAt: null, storedDigest: null });
  // Nothing was read, so nothing is archived: an empty file would hide every later reading behind it.
  assert.equal((await saveHowtoReadings(firstNight, empty.storedDigest, store)).saved, false);

  fs.writeFileSync(path.join(firstNight, HOWTO_STORE_FILE), JSON.stringify(capture({
    a: reading('a1', '2026-11-09T04:00:00.000Z', 3), b: reading('b1', '2026-11-09T04:00:00.000Z') })));
  const saved = await saveHowtoReadings(firstNight, empty.storedDigest, { ...store, now: () => new Date('2026-11-09T05:00:00.000Z') });
  assert.equal(saved.saved, true);
  assert.equal(saved.pages, 2);
  assert.equal(store.objects.length, 1);

  // A fresh runner: no file on disk.
  const secondNight = rawDirWith();
  const restored = await restoreHowtoReadings(secondNight, store);
  assert.deepEqual({ ...restored, storedDigest: '' }, { pages: 2, fromStore: 2, archivedAt: '2026-11-09T05:00:00.000Z', storedDigest: '' });
  assert.equal(restored.storedDigest, saved.digest);
  assert.deepEqual(onDisk(secondNight).pages.a, reading('a1', '2026-11-09T04:00:00.000Z', 3));

  // No page changed that night: the store already holds exactly these readings.
  assert.equal((await saveHowtoReadings(secondNight, restored.storedDigest, store)).saved, false);
  assert.equal(store.objects.length, 1);

  // One page was read again: the whole set is archived once more, and the newest set wins.
  const changed = onDisk(secondNight);
  changed.pages.b = reading('b2', '2026-11-10T04:00:00.000Z', 2);
  fs.writeFileSync(path.join(secondNight, HOWTO_STORE_FILE), JSON.stringify(changed));
  assert.equal((await saveHowtoReadings(secondNight, restored.storedDigest, { ...store, now: () => new Date('2026-11-10T05:00:00.000Z') })).saved, true);
  const thirdNight = rawDirWith();
  await restoreHowtoReadings(thirdNight, store);
  assert.equal(onDisk(thirdNight).pages.b.key, 'b2');
  assert.equal(onDisk(thirdNight).pages.a.key, 'a1');
});

test('a restore never drops a reading that is only on disk', async () => {
  const store = memoryStore();
  const earlier = rawDirWith({ a: reading('a1', '2026-11-09T04:00:00.000Z') });
  await saveHowtoReadings(earlier, null, { ...store, now: () => new Date('2026-11-09T05:00:00.000Z') });

  const rawDir = rawDirWith({ a: reading('a2', '2026-11-10T04:00:00.000Z'), local: reading('l1', '2026-11-10T04:00:00.000Z') });
  const restored = await restoreHowtoReadings(rawDir, store);
  assert.equal(restored.pages, 2);
  assert.equal(restored.fromStore, 0);
  assert.equal(onDisk(rawDir).pages.a.key, 'a2');
  assert.equal(onDisk(rawDir).pages.local.key, 'l1');
  // What is on disk differs from the store, so the next save archives it.
  assert.equal((await saveHowtoReadings(rawDir, restored.storedDigest, store)).saved, true);
});

test('a store request that fails in passing is tried again; one that keeps failing stops the restore', async () => {
  const store = memoryStore();
  const earlier = rawDirWith({ a: reading('a1', '2026-11-09T04:00:00.000Z') });
  await saveHowtoReadings(earlier, null, store);

  let failures = 2;
  const flaky: HowtoStoreDeps = { ...store, list: async sourceKey => {
    if (failures-- > 0) throw new Error('We encountered an internal error. Please try again.');
    return store.list!(sourceKey);
  } };
  const rawDir = rawDirWith();
  assert.equal((await restoreHowtoReadings(rawDir, flaky)).pages, 1);
  assert.deepEqual(store.waits, [2000, 4000]);

  const down: HowtoStoreDeps = { ...store, list: async () => { throw new Error('We encountered an internal error. Please try again.'); } };
  const untouched = rawDirWith({ kept: reading('k1', '2026-11-10T04:00:00.000Z') });
  await assert.rejects(restoreHowtoReadings(untouched, down), /Listing the archived how-to readings failed 4 times/);
  assert.equal(onDisk(untouched).pages.kept.key, 'k1');
});

test('a store with no settings fails at once, and a save that stored nothing is an error', async () => {
  const store = memoryStore();
  const unset: HowtoStoreDeps = { ...store, list: async () => { throw new Error('Raw artifact storage is not configured.'); } };
  await assert.rejects(restoreHowtoReadings(rawDirWith(), unset), /failed: Raw artifact storage is not configured/);
  assert.deepEqual(store.waits, []);

  const rawDir = rawDirWith({ a: reading('a1', '2026-11-09T04:00:00.000Z') });
  const notStored: HowtoStoreDeps = { ...store, archive: async sourceKey => ({ sourceKey, rawHash: 'x', rawUri: null, objectKey: null, stored: false, compressedBytes: 1 }) };
  await assert.rejects(saveHowtoReadings(rawDir, null, notStored), /not archived/);
});

test('an archived bundle without the readings file stops the restore', async () => {
  const store = memoryStore();
  const wrong: HowtoStoreDeps = { ...store,
    list: async () => [{ rawUri: 's3://test/raw/howto-entries/x', rawHash: 'x', collectedAt: '2026-11-09T05:00:00.000Z' }],
    download: async () => ({ version: 1, sourceKey: HOWTO_STORE_SOURCE, entries: [{ file: 'other.raw.json', sha256: 'x', content: {} }] }) };
  await assert.rejects(restoreHowtoReadings(rawDirWith(), wrong), /hold no howto-entries\.raw\.json/);
});

test('a publish may not replace the live how-to tasks with under half as many pages of them', () => {
  // Before the first read there is nothing to protect.
  assert.equal(howtoPagesShortfall(0, 0), null);
  assert.equal(howtoPagesShortfall(0, HOWTO_PAGES_WORTH_GUARDING - 1), null);
  // A normal night: a few pages gained or lost their tasks.
  assert.equal(howtoPagesShortfall(1790, 1833), null);
  assert.equal(howtoPagesShortfall(917, 1833), null);
  assert.match(howtoPagesShortfall(916, 1833) ?? '', /dropped from 1833 to 916/);
  assert.match(howtoPagesShortfall(0, 1833) ?? '', /howto_max_usd/);
});
