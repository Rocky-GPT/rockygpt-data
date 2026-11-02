import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalDatabaseUrl, testBuildFromCapturedPages } from './test-build';

const LOCAL = 'postgresql://rocky:pw@127.0.0.1:55435/rocky_test';
const ON = { ROCKYGPT_TEST_BUILD_FROM_CAPTURED_PAGES: '1' };

test('the test-build switch is off unless set', () => {
  assert.equal(testBuildFromCapturedPages({ DATABASE_URL: LOCAL }), false);
});

test('the test-build switch is on for a local database with no bucket', () => {
  assert.equal(testBuildFromCapturedPages({ ...ON, DATABASE_URL: LOCAL }), true);
  assert.equal(testBuildFromCapturedPages({ ...ON, DATABASE_URL: 'postgres://u@localhost/db' }), true);
});

test('the test-build switch refuses a remote database', () => {
  assert.throws(() => testBuildFromCapturedPages({ ...ON, DATABASE_URL: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require' }), /this machine/);
  assert.throws(() => testBuildFromCapturedPages(ON), /this machine/);
  assert.equal(isLocalDatabaseUrl('postgresql://u@127.0.0.1.evil.example/db'), false);
  assert.equal(isLocalDatabaseUrl('not a url'), false);
});

test('the test-build switch refuses a bucket or a workflow', () => {
  assert.throws(() => testBuildFromCapturedPages({ ...ON, DATABASE_URL: LOCAL, RAW_ARTIFACT_BUCKET: 'b' }), /never uploads/);
  assert.throws(() => testBuildFromCapturedPages({ ...ON, DATABASE_URL: LOCAL, GITHUB_ACTIONS: 'true' }), /never a workflow/);
});
