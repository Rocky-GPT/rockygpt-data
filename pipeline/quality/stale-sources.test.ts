import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateCurrentDatasetV2 } from './validate';

// A captured calendar a year old: stale for a release, fine for a laptop test build.
function oldCapture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-sources-'));
  const raw = path.join(cwd, 'data/raw');
  fs.mkdirSync(raw, { recursive: true });
  const payload = { dates: [] };
  fs.writeFileSync(path.join(raw, 'calendar.raw.json'), JSON.stringify(payload));
  fs.writeFileSync(path.join(raw, 'calendar.provenance.json'), JSON.stringify({ version: 1, dataset: 'calendar',
    fetchedAt: '2025-11-01T00:00:00.000Z', contentHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }));
  return cwd;
}

test('a stale source stops a release', () => {
  const cwd = oldCapture();
  const summary = validateCurrentDatasetV2({}, { cwd, now: new Date('2026-11-02T00:00:00Z') });
  assert.ok(summary.errors.some(e => e.startsWith('Source academic-calendar is stale')));
});

test('a test build only warns about a stale source and still stops on unknown age', () => {
  const cwd = oldCapture();
  const summary = validateCurrentDatasetV2({}, { cwd, now: new Date('2026-11-02T00:00:00Z'), allowStaleSources: true });
  assert.ok(!summary.errors.some(e => e.includes('is stale')));
  assert.ok(summary.warnings.some(w => w.startsWith('Source academic-calendar is stale')));
  assert.ok(summary.errors.some(e => e.includes('unknown collection age')));
});
