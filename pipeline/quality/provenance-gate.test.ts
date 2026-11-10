import assert from 'node:assert/strict';
import test from 'node:test';
import { provenanceIssues } from '../../scripts/database/quality-gates';

const states = [
  { key: 'dining', status: 'stale', detail: 'collected 80.9h ago (max 36h)' },
  { key: 'office-pages', status: 'fresh', detail: 'collected 2.0h ago (max 168h)' },
  { key: 'athletics-coaches', status: 'unknown', detail: 'no collection record' },
  { key: 'housing', status: 'unknown', detail: 'no collection record' },
];
const notCaptured = (key: string) => key === 'athletics-coaches';

test('a production run refuses a source past its freshness window or without a collection record', () => {
  const found = provenanceIssues(states, { testBuild: false, enforce: true, notCaptured });
  assert.deepEqual(found.errors, [
    'Source dining is stale: collected 80.9h ago (max 36h)',
    'Source athletics-coaches has unknown collection age: no collection record',
    'Source housing has unknown collection age: no collection record',
  ]);
  assert.deepEqual(found.warnings, []);
});

test('a test build uses production\'s pages however old, and still refuses a source with no record', () => {
  // Production had not published for three nights (November 8 to 10, 2026): the dev build that
  // carried the fix stopped here on "Source dining is stale".
  const found = provenanceIssues(states, { testBuild: true, enforce: true, notCaptured });
  assert.deepEqual(found.errors, ['Source housing has unknown collection age: no collection record']);
  assert.equal(found.warnings.length, 2);
  assert.match(found.warnings[0], /^Source dining is past its freshness window \(collected 80\.9h ago \(max 36h\)\)/);
  assert.match(found.warnings[1], /^Source athletics-coaches was added since the captured pages were collected/);
});

test('where the gate only warns, nothing is an error', () => {
  const found = provenanceIssues(states, { testBuild: false, enforce: false, notCaptured });
  assert.deepEqual(found.errors, []);
  assert.equal(found.warnings.length, 3);
});
