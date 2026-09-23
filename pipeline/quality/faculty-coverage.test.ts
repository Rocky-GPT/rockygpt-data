import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseFacultyProfileHtml } from '../../ingestion/faculty-profile-parser';
import { facultyCoverageErrors } from './faculty-coverage';

const html = '<div class="callout-no-image"><h1>Example Faculty</h1></div><div id="content-block"><div class="col-lg-12"><h3>Professor</h3><p><strong>Recent Publications</strong></p><ul><li>One complete citation. With a second sentence.</li></ul><h4>Service</h4><p>Chairs a committee.</p></div></div>';
const url = 'https://example.edu/faculty/example/';
const page = { requestedUrl: url, url, role: 'profile', school: 'School', status: 200,
  fetchedAt: '2026-09-23T20:00:00Z', html, contentHash: createHash('sha256').update(html).digest('hex') };
const capture = { schemaVersion: 1, pages: [page] };

test('source coverage blocks missing sections and biography content even when record counts match', () => {
  const profile = parseFacultyProfileHtml(html, url, 'School').profile!;
  assert.deepEqual(facultyCoverageErrors([profile], capture), []);
  assert.match(facultyCoverageErrors([{ ...profile, publishedResearch: [] }], capture).join(), /publishedResearch/);
  assert.match(facultyCoverageErrors([{ ...profile, bio: '' }], capture).join(), /biography/);
});

test('source coverage rejects missing or altered source captures', () => {
  const profile = parseFacultyProfileHtml(html, url, 'School').profile!;
  assert.match(facultyCoverageErrors([profile], { schemaVersion: 1, pages: [] }).join(), /capture missing/);
  assert.match(facultyCoverageErrors([profile], { schemaVersion: 1, pages: [{ ...page, html: 'changed' }] }).join(), /invalid/);
});
