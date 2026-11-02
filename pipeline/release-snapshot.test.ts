import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fromSnapshot, restoreActiveReleaseFiles, RELEASE_ARTIFACT_TARGETS } from './restore-active-release';
import {
  inJsonbKeyOrder,
  md5,
  readReleaseSnapshot,
  sha256,
  writeReleaseSnapshot,
} from './release-snapshot';

test('keys are put in the order PostgreSQL jsonb returns them', () => {
  // PostgreSQL 16: SELECT '{"bb":1,"a":{"zz":1,"y":2},"é":3,"ab":4,"10":5,"9":6,"B":7}'::jsonb
  // returns {"9": 6, "B": 7, "a": {"y": 2, "zz": 1}, "10": 5, "ab": 4, "bb": 1, "é": 3}; the pg
  // driver parses that text, which is what a restore from the database writes.
  const fromDatabase = JSON.parse('{"9": 6, "B": 7, "a": {"y": 2, "zz": 1}, "10": 5, "ab": 4, "bb": 1, "é": 3}');
  const published = '{"bb":1,"a":{"zz":1,"y":2},"é":3,"ab":4,"10":5,"9":6,"B":7}';
  assert.equal(JSON.stringify(inJsonbKeyOrder(JSON.parse(published))), JSON.stringify(fromDatabase));
  assert.equal(
    JSON.stringify(inJsonbKeyOrder([{ b: 1, a: [{ d: 1, c: 2 }] }])),
    '[{"a":[{"c":2,"d":1}],"b":1}]'
  );
  const proto = inJsonbKeyOrder(JSON.parse('{"__proto__": {"x": 1}}')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(proto), ['__proto__']);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

test('only what the database holds with the same hash is taken from the saved copy', () => {
  const courses = '{"CMPS 147":{"name":"Computer Science I","credits":4}}';
  const snapshot = {
    version: 'v2-yesterday',
    artifacts: { courses, faculty: '[{"name":"Old"}]', clubs: 'not json' },
    documents: { 'hours/library.md': '# Library\n\nOpen 8-5.', 'hours/gym.md': '# Gym' },
  };
  const kept = fromSnapshot(
    snapshot,
    [
      { artifact_key: 'courses', content_hash: sha256(courses) },
      { artifact_key: 'faculty', content_hash: sha256('[{"name":"New"}]') },
      { artifact_key: 'clubs', content_hash: sha256('not json') },
      { artifact_key: 'events', content_hash: sha256('[]') },
    ],
    [
      { source_path: 'hours/library.md', content_md5: md5('# Library\n\nOpen 8-5.') },
      { source_path: 'hours/gym.md', content_md5: md5('# Gym, changed') },
      { source_path: 'hours/new.md', content_md5: md5('# New') },
      { source_path: null, content_md5: md5('') },
    ]
  );
  assert.deepEqual(kept.artifacts, [
    { key: 'courses', payload: { 'CMPS 147': { name: 'Computer Science I', credits: 4 } } },
  ]);
  assert.deepEqual(kept.documents, [
    { sourcePath: 'hours/library.md', content: '# Library\n\nOpen 8-5.' },
  ]);
  assert.deepEqual(fromSnapshot(null, [{ artifact_key: 'courses', content_hash: sha256(courses) }], []),
    { artifacts: [], documents: [] });
});

test('a restore from the saved copy writes the same files as one from the database', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-release-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The publisher's file text, and what PostgreSQL 16 returns for it as jsonb.
  const text = '{\n  "zeta": "x",\n  "alpha": [{"longer": 1, "s": 2.50}],\n  "é": true,\n  "n": 1e2\n}';
  const fromDatabase = '{"n": 100, "é": true, "zeta": "x", "alpha": [{"s": 2.50, "longer": 1}]}';
  const published = Object.fromEntries(Object.keys(RELEASE_ARTIFACT_TARGETS).map((key) => [key, text]));
  const release = { datasetId: 'd', releaseId: 'r', version: 'v', activatedAt: '2026-11-02T04:04:00.000Z' };
  restoreActiveReleaseFiles({
    rootDir: path.join(root, 'database'),
    release,
    artifacts: Object.keys(published).map((key) => ({ key, payload: JSON.parse(fromDatabase) })),
    documents: [{ content: '# Library', metadata: { sourcePath: 'hours/library.md' } }],
  });
  const kept = fromSnapshot(
    { version: 'v', artifacts: published, documents: { 'hours/library.md': '# Library' } },
    Object.entries(published).map(([key, text]) => ({ artifact_key: key, content_hash: sha256(text) })),
    [{ source_path: 'hours/library.md', content_md5: md5('# Library') }]
  );
  restoreActiveReleaseFiles({
    rootDir: path.join(root, 'snapshot'),
    release,
    artifacts: kept.artifacts,
    documents: kept.documents.map(({ sourcePath, content }) => ({ content, metadata: { sourcePath } })),
  });
  for (const relativePath of [...Object.values(RELEASE_ARTIFACT_TARGETS).flat(), 'data/context/hours/library.md']) {
    if (relativePath.startsWith('src/')) continue;
    assert.equal(
      fs.readFileSync(path.join(root, 'snapshot', relativePath), 'utf8'),
      fs.readFileSync(path.join(root, 'database', relativePath), 'utf8'),
      relativePath
    );
  }
});

test('the saved copy is read back, and an unreadable one is ignored', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-release-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.release-snapshot', 'release.json');
  assert.equal(readReleaseSnapshot(file), null);
  const snapshot = { version: 'v', artifacts: { courses: '{}' }, documents: { 'a.md': '# A' } };
  writeReleaseSnapshot(file, snapshot);
  assert.deepEqual(readReleaseSnapshot(file), snapshot);
  fs.writeFileSync(file, '{"version":"v","artifacts":{"courses":1},"documents":{}}');
  assert.equal(readReleaseSnapshot(file), null);
  fs.writeFileSync(file, '{"version":');
  assert.equal(readReleaseSnapshot(file), null);
});
