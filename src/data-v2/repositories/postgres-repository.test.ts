import assert from 'node:assert/strict';
import test from 'node:test';

import { toWireDateTime } from './postgres-repository';

test('PostgreSQL timestamps are emitted as RFC 3339 date-times', () => {
  assert.equal(
    toWireDateTime('2026-08-22 05:40:42.514749+00'),
    '2026-08-22T05:40:42.514Z'
  );
  assert.equal(
    toWireDateTime(new Date('2026-08-22T05:35:02.413Z')),
    '2026-08-22T05:35:02.413Z'
  );
  assert.throws(() => toWireDateTime('not-a-timestamp'));
});
