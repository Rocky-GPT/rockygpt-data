import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseFacultyProfileHtml } from '../../ingestion/faculty-profile-parser';
import { facultyCoverageErrors } from './faculty-coverage';
import { validateFacultyProfiles } from '../../ingestion/schema';

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

test('angle-bracket citation text and its actual link survive final normalization', () => {
  const displayed = 'http://m05.cgpublisher.com/proposals/137/index.aspx';
  const target = 'http://m05.cgpublisher.com/proposals/137/index.html';
  const source = html.replace('One complete citation. With a second sentence.',
    `Heinze, P. &amp; Munoz, S. (2006). From Classroom to Corporation. (Peer-reviewed) &lt;<a href="${target}">${displayed}</a>&gt;`);
  const parsed = parseFacultyProfileHtml(source, url, 'School').profile!;
  const normalized = validateFacultyProfiles([parsed]);
  assert.ok(normalized[0].publishedResearch[0].includes(displayed));
  assert.ok(normalized[0].publishedResearch[0].includes(target));
  const sourceCapture = { schemaVersion: 1, pages: [{ ...page, html: source,
    contentHash: createHash('sha256').update(source).digest('hex') }] };
  assert.deepEqual(facultyCoverageErrors(normalized, sourceCapture), []);
  const missingLink = [{ ...normalized[0], publishedResearch: [normalized[0].publishedResearch[0].replace(target, '')] }];
  assert.match(facultyCoverageErrors(missingLink, sourceCapture).join(), /Faculty source link lost/);
});

test('embedded gallery markup loses formatting without losing its linked source evidence', () => {
  const profile = parseFacultyProfileHtml(html, url, 'School').profile!;
  const target = 'https://publisher.example/book';
  const normalized = validateFacultyProfiles([{ ...profile,
    bio: `Books: <ul><li><a href="${target}"><img src="https://example.edu/cover.jpg" /></a><p>Published Book</p></li></ul>`,
  }])[0];
  assert.ok(normalized.bio.includes(target));
  assert.ok(normalized.bio.includes('Published Book'));
  assert.doesNotMatch(normalized.bio, /<\/?(?:a|img|ul|li|p)\b/);
  assert.deepEqual(validateFacultyProfiles([normalized]), [normalized]);
});

test('source anchor coverage also catches links omitted by the parser itself', () => {
  const target = 'https://example.edu/full-bibliography';
  const source = html.replace('<p><strong>Recent Publications</strong></p>',
    `<h4><a href="${target}">Recent Publications</a></h4>`);
  const parsed = parseFacultyProfileHtml(source, url, 'School').profile!;
  const sourceCapture = { schemaVersion: 1, pages: [{ ...page, html: source,
    contentHash: createHash('sha256').update(source).digest('hex') }] };
  assert.match(facultyCoverageErrors(validateFacultyProfiles([parsed]), sourceCapture).join(), /Faculty source link lost/);
});
