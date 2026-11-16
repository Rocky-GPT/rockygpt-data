import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkCountsBySource, chunkGateError } from './document-chunk-gate';

const page = (words: number) => `# Page\n\n${'word '.repeat(words)}`;

test('counts chunks per source the way the publish chunks documents', () => {
  const counts = chunkCountsBySource([
    { sourceKey: 'housing', content: page(10) },
    { sourceKey: 'housing', content: page(10) },
    { sourceKey: 'dining', content: page(1_000) },
  ]);
  assert.equal(counts.get('housing'), 2);
  assert.ok((counts.get('dining') ?? 0) > 2);
});

test('a release with too few chunks in all is refused', () => {
  assert.match(chunkGateError(new Map([['housing', 99]]), new Map()) ?? '', /document_chunks=99, expected >= 100/);
});

test('a release whose chunks fell below half of the active release is refused', () => {
  const error = chunkGateError(new Map([['housing', 150]]), new Map([['housing', 400]]));
  assert.match(error ?? '', /document_chunks dropped from 400 to 150/);
});

test("a source's chunks may not fall below its own floor", () => {
  const active = new Map([['dining', 100], ['faculty', 100], ['housing', 1_000]]);
  assert.equal(chunkGateError(new Map([['dining', 31], ['faculty', 60], ['housing', 1_000]]), active), null);
  assert.match(chunkGateError(new Map([['dining', 29], ['faculty', 60], ['housing', 1_000]]), active) ?? '',
    /dining chunks dropped from 100 to 29 \(minimum allowed ratio 0.3\)/);
  assert.match(chunkGateError(new Map([['dining', 31], ['faculty', 59], ['housing', 1_000]]), active) ?? '',
    /faculty chunks dropped from 100 to 59/);
});

test('a source gone from the candidate is caught, and a source with under 3 chunks is not judged', () => {
  const active = new Map([['housing', 1_000], ['health', 10], ['tiny', 2]]);
  assert.match(chunkGateError(new Map([['housing', 1_000]]), active) ?? '', /health chunks dropped from 10 to 0/);
  assert.equal(chunkGateError(new Map([['housing', 1_000], ['health', 10]]), active), null);
});
