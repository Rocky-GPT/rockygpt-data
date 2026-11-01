import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupScriptsBySource, keptSourcesReport, listFiles, runIsolatedRefresh } from './refresh-isolation';

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-isolation-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const write = (root: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

test('collectors are grouped by the source they renew, in run order', () => {
  const groups = groupScriptsBySource(
    ['fetch:menu', 'fetch:directory:raw', 'fetch:dining-hours', 'fetch:reviewed-contacts'],
    { dining: ['fetch:menu', 'fetch:dining-hours'], 'campus-directory': ['fetch:directory:raw', 'fetch:reviewed-contacts'] }
  );
  assert.deepEqual(groups, [
    { key: 'dining', scripts: ['fetch:menu', 'fetch:dining-hours'] },
    { key: 'campus-directory', scripts: ['fetch:directory:raw', 'fetch:reviewed-contacts'] },
  ]);
  assert.throws(() => groupScriptsBySource(['fetch:unknown'], {}), /No publishable source owns/);
});

test('a source whose collector fails keeps the release copy while the others refresh', () => {
  const root = tree({
    'data/raw/menu.raw.json': 'menu-release',
    'data/raw/directory.raw.json': 'directory-release',
    'data/raw/reviewed-contacts.raw.json': 'contacts-release',
    'data/raw/events.raw.json': 'events-release',
  });
  try {
    const kept = runIsolatedRefresh({
      rootDir: root,
      log: () => {},
      groups: [
        { key: 'dining', scripts: ['fetch:menu'] },
        { key: 'campus-directory', scripts: ['fetch:directory:raw', 'fetch:reviewed-contacts'] },
        { key: 'archway-events', scripts: ['fetch:events:live'] },
      ],
      runScript: (script) => {
        if (script === 'fetch:menu') write(root, 'data/raw/menu.raw.json', 'menu-today');
        if (script === 'fetch:directory:raw') write(root, 'data/raw/directory.raw.json', 'directory-today');
        if (script === 'fetch:reviewed-contacts') {
          write(root, 'data/raw/reviewed-contacts-sources.raw.json', 'failed capture');
          throw new Error('npm run fetch:reviewed-contacts failed with exit code 1. collected 272 of 273.');
        }
        if (script === 'fetch:events:live') write(root, 'data/raw/events.raw.json', 'events-today');
      },
    });
    assert.deepEqual(kept.map((entry) => [entry.key, entry.failedScript]), [['campus-directory', 'fetch:reviewed-contacts']]);
    assert.equal(read(root, 'data/raw/menu.raw.json'), 'menu-today');
    assert.equal(read(root, 'data/raw/events.raw.json'), 'events-today');
    // The whole source goes back, including the collector that succeeded before the failure.
    assert.equal(read(root, 'data/raw/directory.raw.json'), 'directory-release');
    assert.equal(read(root, 'data/raw/reviewed-contacts.raw.json'), 'contacts-release');
    assert.ok(!fs.existsSync(path.join(root, 'data/raw/reviewed-contacts-sources.raw.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed source that touched another source\'s refreshed file stops the refresh', () => {
  const root = tree({ 'data/normalized/shared.json': 'release' });
  try {
    assert.throws(() => runIsolatedRefresh({
      rootDir: root,
      log: () => {},
      groups: [{ key: 'first', scripts: ['a'] }, { key: 'second', scripts: ['b'] }],
      runScript: (script) => {
        write(root, 'data/normalized/shared.json', script);
        if (script === 'b') throw new Error('b failed.');
      },
    }), /b failed\. The release's copy of second cannot be kept/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('run reports and caches are neither snapshotted nor restored', () => {
  const root = tree({ 'data/review/page-check.md': 'old', 'data/raw/x.raw.json': 'x' });
  try {
    assert.deepEqual([...listFiles(root).keys()], ['data/raw/x.raw.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the incident note names each kept source, its failure and how old its data is', () => {
  const report = keptSourcesReport(
    [{ key: 'campus-directory', scripts: ['fetch:reviewed-contacts'], failedScript: 'fetch:reviewed-contacts',
      error: 'npm run fetch:reviewed-contacts failed with exit code 1.' }],
    [{ key: 'campus-directory', detail: 'collected 96.0h ago (max 168h)' }],
    'v2-20261028171145'
  );
  assert.match(report, /could not collect 1 source\(s\)/);
  assert.match(report, /release v2-20261028171145/);
  assert.match(report, /\*\*campus-directory\*\*: `npm run fetch:reviewed-contacts` failed/);
  assert.match(report, /collected 96\.0h ago \(max 168h\)/);
});
