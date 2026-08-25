import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresRepositoryV2, toWireDateTime } from './postgres-repository';

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

// Retrieval scoring runs in SQL, so the only honest test of it needs the
// index. These skip without a database rather than asserting on the shape of
// a query string, which would pass while retrieving nothing.
const connectionString = process.env.DATABASE_URL;
const withDatabase = { skip: connectionString ? false : 'DATABASE_URL is not set' };

test('a more precise question does not retrieve less', withDatabase, async () => {
  // The bug this replaced: terms were joined with AND, so every added word
  // could only narrow the result. "guest policy" found the guest policy and
  // "Ramapo overnight guest policy" found nothing, though all four words are
  // in the corpus.
  const repository = new PostgresRepositoryV2(connectionString as string);
  const dataset = await repository.getDatasetContext();
  const search = (query: string) =>
    repository.withDataset(dataset).searchDocuments(query, { domains: [], limit: 5 });

  const broad = await search('guest policy');
  const precise = await search('Ramapo overnight guest policy');

  assert.ok(broad.length > 0, 'the corpus holds a guest policy');
  assert.ok(precise.length > 0, 'naming more of the question must not empty the result');
  assert.equal(precise[0].domain, broad[0].domain, 'and it should still rank the same passage first');
});

test('a question the corpus cannot answer still reports nothing', withDatabase, async () => {
  // OR matching makes almost everything match something, so the floor is what
  // keeps `no_match` meaningful. Without it every question would come back
  // with whichever passage shared a preposition with it.
  const repository = new PostgresRepositoryV2(connectionString as string);
  const dataset = await repository.getDatasetContext();
  const found = await repository
    .withDataset(dataset)
    .searchDocuments('purple monkey dishwasher', { domains: [], limit: 5 });

  assert.equal(found.length, 0);
});

test('passages come back in relevance order', withDatabase, async () => {
  const repository = new PostgresRepositoryV2(connectionString as string);
  const dataset = await repository.getDatasetContext();
  const found = await repository
    .withDataset(dataset)
    .searchDocuments('overnight guest policy', { domains: [], limit: 5 });

  assert.ok(found.length > 1, 'needs at least two passages to have an order');
  const scores = found.map((item) => item.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});
