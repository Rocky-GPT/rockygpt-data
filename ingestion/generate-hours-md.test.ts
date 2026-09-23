import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWithheldHours } from './generate-hours-md';
import { chunkDocumentSections } from '../src/data-v2/document-text';

test('withheld hours explain uncertainty with source provenance without exposing rejected times', () => {
  const records = [
    { record: { name: 'Gym', sourceUrl: 'https://example.edu/gym', collectedAt: '2026-09-23T19:00:00Z', hours: { Monday: '8am-10pm' } }, reason: 'unbounded-term' },
    { record: { name: 'Research Help', sourceUrl: 'https://example.edu/library', collectedAt: '2026-09-23T19:01:00Z', hours: { Monday: '9am-9pm' } }, reason: 'conflicting-source-validity' },
  ];
  const markdown = renderWithheldHours(records);
  assert.ok(!markdown.includes('8am-10pm') && !markdown.includes('9am-9pm'));
  assert.match(markdown, /without explicit start and end dates/);
  assert.match(markdown, /conflicting applicability dates/);
  assert.match(markdown, /does not establish that the facility is closed/);
  const chunks = chunkDocumentSections(markdown);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map(c => [c.canonicalUrl, c.collectedAt]), records.map(r => [r.record.sourceUrl, r.record.collectedAt]));
  assert.ok(chunks.every(c => c.content.includes('Current hours are unverified.')));
});
