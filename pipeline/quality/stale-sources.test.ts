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

test('a test build is built without a source added since the capture, but a release is not', () => {
  const cwd = oldCapture();
  const now = new Date('2026-11-04T00:00:00Z');
  const build = validateCurrentDatasetV2({}, { cwd, now, allowStaleSources: true });
  assert.ok(build.warnings.some(w => w.startsWith('Source athletics-schedules was added since')));
  assert.ok(!build.errors.some(e => e.startsWith('Source athletics-schedules')));
  const release = validateCurrentDatasetV2({}, { cwd, now });
  assert.ok(release.errors.some(e => e.startsWith('Source athletics-schedules has unknown collection age')));
  // Two weeks on, production has had its chance to collect it: a missing capture stops a test build too.
  const later = validateCurrentDatasetV2({}, { cwd, now: new Date('2026-11-20T00:00:00Z'), allowStaleSources: true });
  assert.ok(later.errors.some(e => e.startsWith('Source athletics-schedules has unknown collection age')));
});
