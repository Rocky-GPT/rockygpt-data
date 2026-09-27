import assert from 'node:assert/strict';
import test from 'node:test';

import { siteDocuments } from './folder-sites';
import { SKIPPED_POST_TYPES } from './office-pages';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';
import { chunkDocumentSections } from '../src/data-v2/document-text';

const page = (url: string, html: string, statusCode = 200) => buildRawPageFromHtml({
  url, html, sourceType: 'seed', allowedHost: 'www.ramapo.edu', statusCode, fetchedAt: '2026-09-24T20:00:00.000Z',
});
const contact = '<p>Financial Aid Office, Phone: <a href="tel:2016847549">201-684-7549</a>, Email: finaid@ramapo.edu</p>';

test('each site gets its own document, named for the site, with every page cited', () => {
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'office-pages', collectedAt: '2026-09-24T20:00:00.000Z',
    seedUrls: ['https://www.ramapo.edu/finaid/', 'https://www.ramapo.edu/finaid/fafsa/', 'https://www.ramapo.edu/testing/'],
    stats: { pagesFetched: 3, pagesFailed: 1, externalLinksSeen: 0 },
    pages: [
      page('https://www.ramapo.edu/finaid/', `<title>Home - Financial Aid</title><main><h1>Financial Aid</h1><p>Apply for aid every year with the FAFSA.</p>${contact}</main>`),
      page('https://www.ramapo.edu/finaid/fafsa/', `<title>FAFSA - Financial Aid</title><main><h1>FAFSA</h1><h2>Priority deadline</h2><p>File the FAFSA by March 1 for priority consideration.</p>${contact}</main>`),
      page('https://www.ramapo.edu/finaid/old/', '', 404),
      page('https://www.ramapo.edu/testing/', '<title>Testing Center Home - Testing Center</title><main><h1>Testing Center</h1><p>Placement tests are taken by appointment in the Testing Center.</p></main>'),
      page('https://www.ramapo.edu/finaid/recipient/jane-doe/', '<title>Jane Doe - Financial Aid</title><main><h1>Jane Doe</h1><p>Jane Doe received an award for her studies in biology.</p></main>'),
      page('https://www.ramapo.edu/testing/roster/', '<title>Roster - Testing Center</title><main><h1>Roster</h1><p>John Roe, Mary Major and Richard Miles passed the proctor training.</p></main>'),
      page('https://www.ramapo.edu/finaid/forms/', '<title>Forms - Financial Aid</title><main><h1>Forms</h1><p>Another collector already keeps this verification worksheet page.</p></main>'),
    ],
  };
  const documents = siteDocuments(dataset, [
    { folder: 'finaid', name: 'Financial Aid' },
    { folder: 'registrar', name: 'Registrar' },
    { folder: 'testing', name: 'Testing Center' },
  ], SKIPPED_POST_TYPES, new Set(['www.ramapo.edu/testing/roster', 'www.ramapo.edu/finaid/forms']));
  assert.deepEqual([...documents.keys()], ['finaid.md', 'testing.md']);
  const finaid = documents.get('finaid.md')!;
  assert.equal(finaid.pages, 2);
  assert.match(finaid.markdown, /^# Financial Aid\n/);
  assert.match(finaid.markdown, /- Pages Failed: 1/);
  assert.doesNotMatch(finaid.markdown, /Testing Center/);
  assert.doesNotMatch(finaid.markdown, /Jane Doe/);
  assert.doesNotMatch(documents.get('testing.md')!.markdown, /John Roe/);
  assert.doesNotMatch(finaid.markdown, /verification worksheet/);
  const deadline = chunkDocumentSections(finaid.markdown).find(chunk => chunk.content.includes('March 1'));
  assert.equal(deadline?.canonicalUrl, 'https://www.ramapo.edu/finaid/fafsa/');
  assert.equal(deadline?.collectedAt, '2026-09-24T20:00:00.000Z');
  assert.match(deadline?.headingPath ?? '', /^Financial Aid › FAFSA - Financial Aid › /);
});

test('a site document writes a sidebar block repeated across the site pages once', () => {
  const sidebar = '<aside><h3>Tech Support</h3><p>Call the Help Desk at 201-684-7777 or email helpdesk@ramapo.edu.</p></aside>';
  const pages = ['', 'printing/', 'labs/'].map(slug => page(`https://www.ramapo.edu/its/${slug}`,
    `<title>${slug || 'Home'} - ITS</title><main><h1>${slug || 'Home'}</h1><p>This page explains ${slug || 'the office'} for students.</p>${sidebar}</main>`));
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'office-pages', collectedAt: '2026-09-24T20:00:00.000Z', seedUrls: [],
    stats: { pagesFetched: 3, pagesFailed: 0, externalLinksSeen: 0 }, pages,
  };
  const { markdown } = siteDocuments(dataset, [{ folder: 'its', name: 'Information Technology Services' }], SKIPPED_POST_TYPES).get('its.md')!;
  assert.equal(markdown.split('Call the Help Desk').length - 1, 1);
  assert.match(markdown, /## Site-wide sections\n\n### Tech Support\n\n- URL: https:\/\/www\.ramapo\.edu\/its\/\n/);
});

test('a site-wide block cites a written page, not a page left with nothing of its own', () => {
  const sidebar = '<aside><h3>Follow CHGS</h3><p>Follow the Center on Facebook and donate to support its programs.</p></aside>';
  const pages = [
    page('https://www.ramapo.edu/holocaust/test/', `<title>Test - CHGS</title><main>${sidebar}</main>`),
    page('https://www.ramapo.edu/holocaust/about/staff/', `<title>Staff - CHGS</title><main><h1>Staff</h1><p>The Center's director and staff.</p>${sidebar}</main>`),
    page('https://www.ramapo.edu/holocaust/about-us/', `<title>About - CHGS</title><main><h1>About</h1><p>The Center teaches the history of genocide.</p>${sidebar}</main>`),
  ];
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'academic-sites', collectedAt: '2026-09-24T20:00:00.000Z', seedUrls: [],
    stats: { pagesFetched: 3, pagesFailed: 0, externalLinksSeen: 0 }, pages,
  };
  const { markdown } = siteDocuments(dataset, [{ folder: 'holocaust', name: 'CHGS' }], SKIPPED_POST_TYPES).get('holocaust.md')!;
  assert.match(markdown, /### Follow CHGS\n\n- URL: https:\/\/www\.ramapo\.edu\/holocaust\/about-us\/\n/);
  assert.doesNotMatch(markdown, /holocaust\/test/);
});

test('reviewed section cuts leave the rest of the page in its document', () => {
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'academic-sites', collectedAt: '2026-09-24T20:00:00.000Z', seedUrls: [],
    stats: { pagesFetched: 2, pagesFailed: 0, externalLinksSeen: 0 },
    pages: [
      page('https://www.ramapo.edu/te/grad-programs/', '<title>Graduate - TE</title><main><h2>Graduate Programs in Education</h2><p>Ramapo offers graduate degrees in education.</p><h2>Graduate Student Success Stories</h2><p>Alum Jane Roe 2019 teaches in Mahwah.</p></main>'),
      page('https://www.ramapo.edu/te/changed/', '<title>Changed - TE</title><main><h2>Now Renamed</h2><p>Alum John Doe 2020 teaches in Ramsey.</p></main>'),
    ],
  };
  const cuts = new Map([
    ['www.ramapo.edu/te/grad-programs', [{ heading: 'Graduate Student Success Stories' }]],
    ['www.ramapo.edu/te/changed', [{ heading: 'Success Stories' }]],
  ]);
  const { markdown, pages } = siteDocuments(dataset, [{ folder: 'te', name: 'Teacher Education' }], SKIPPED_POST_TYPES, new Set(), cuts).get('te.md')!;
  assert.equal(pages, 1);
  assert.match(markdown, /graduate degrees in education/);
  assert.doesNotMatch(markdown, /Jane Roe|John Doe/);
});

