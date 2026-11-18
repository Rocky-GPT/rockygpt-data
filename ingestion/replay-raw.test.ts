import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildRawPageFromHtml } from './raw-collector';
import { replayRaw } from './replay-raw';

const URL = 'https://www.ramapo.edu/registrar/';
const FETCHED_AT = '2026-11-18T17:15:51.152Z';
const HTML = `<main><h1>Registrar</h1><h2>Office of the Registrar Staff</h2>
  <p><strong>Beth Foster</strong><br />Associate Registrar<br /><a href="mailto:bfoster@ramapo.edu">bfoster@ramapo.edu</a><br />Office: D-224</p></main>`;

test('a page source collected by an older reader is read again from its saved HTML with this one', () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-raw-'));
  const write = (file: string, value: unknown) => fs.writeFileSync(path.join(rawDir, file), JSON.stringify(value));
  const page = buildRawPageFromHtml({ url: URL, html: HTML, sourceType: 'seed', fetchedAt: FETCHED_AT, statusCode: 200,
    allowedHost: 'www.ramapo.edu' });
  // The stored copy as the November 18 failed run's reader left it: the name carried onto each line.
  const stale = { ...page, sections: page.sections.map(section => ({ ...section,
    shaped: 'Beth Foster: Associate Registrar\nBeth Foster: bfoster@ramapo.edu\nBeth Foster: Office: D-224' })) };
  const dataset = { version: '1.0', dataset: 'directory', collectedAt: FETCHED_AT, seedUrls: [URL],
    stats: { pagesFetched: 1, pagesFailed: 0, externalLinksSeen: 0 }, pages: [stale] };
  write('directory.raw.json', dataset);
  write('directory-sources.raw.json', { schemaVersion: 1, dataset: 'directory', generatedAt: FETCHED_AT, collectionSucceeded: true,
    pages: [{ requestedUrl: URL, url: URL, statusCode: 200, html: HTML, contentType: 'text/html', sourceType: 'seed',
      fetchedAt: FETCHED_AT, contentHash: createHash('sha256').update(HTML).digest('hex') }] });
  write('directory.provenance.json', { version: 1, dataset: 'directory', fetchedAt: FETCHED_AT, sourceUrl: URL, recordCount: 1,
    contentHash: 'stale' });

  assert.equal(replayRaw('directory', rawDir), 1);
  const replayed = JSON.parse(fs.readFileSync(path.join(rawDir, 'directory.raw.json'), 'utf8'));
  const staff = replayed.pages[0].sections.find((section: { heading: string }) => /Staff/.test(section.heading));
  assert.equal(staff.shaped, page.sections.find(section => /Staff/.test(section.heading))?.shaped);
  assert.doesNotMatch(staff.shaped, /Beth Foster: /);
  assert.equal(replayed.pages[0].fetchedAt, FETCHED_AT, 'the fetch time stays the collection\'s');
  const provenance = JSON.parse(fs.readFileSync(path.join(rawDir, 'directory.provenance.json'), 'utf8'));
  assert.equal(provenance.fetchedAt, FETCHED_AT);
  assert.equal(provenance.contentHash, createHash('sha256').update(JSON.stringify(replayed)).digest('hex'));
});
