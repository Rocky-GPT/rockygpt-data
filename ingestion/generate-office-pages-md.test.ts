import assert from 'node:assert/strict';
import test from 'node:test';

import { officeDocuments } from './generate-office-pages-md';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';
import { chunkDocumentSections } from '../src/data-v2/document-text';

const page = (url: string, html: string, statusCode = 200) => buildRawPageFromHtml({
  url, html, sourceType: 'seed', allowedHost: 'www.ramapo.edu', statusCode, fetchedAt: '2026-09-24T20:00:00.000Z',
});
const contact = '<p>Financial Aid Office, Phone: <a href="tel:2016847549">201-684-7549</a>, Email: finaid@ramapo.edu</p>';

test('each office gets its own document, named for the office, with every page cited', () => {
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
  const documents = officeDocuments(dataset, [
    { folder: 'finaid', name: 'Financial Aid' },
    { folder: 'registrar', name: 'Registrar' },
    { folder: 'testing', name: 'Testing Center' },
  ], new Set(['www.ramapo.edu/testing/roster', 'www.ramapo.edu/finaid/forms']));
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

test('office documents write a sidebar block repeated across the office pages once', () => {
  const sidebar = '<aside><h3>Tech Support</h3><p>Call the Help Desk at 201-684-7777 or email helpdesk@ramapo.edu.</p></aside>';
  const pages = ['', 'printing/', 'labs/'].map(slug => page(`https://www.ramapo.edu/its/${slug}`,
    `<title>${slug || 'Home'} - ITS</title><main><h1>${slug || 'Home'}</h1><p>This page explains ${slug || 'the office'} for students.</p>${sidebar}</main>`));
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'office-pages', collectedAt: '2026-09-24T20:00:00.000Z', seedUrls: [],
    stats: { pagesFetched: 3, pagesFailed: 0, externalLinksSeen: 0 }, pages,
  };
  const { markdown } = officeDocuments(dataset, [{ folder: 'its', name: 'Information Technology Services' }]).get('its.md')!;
  assert.equal(markdown.split('Call the Help Desk').length - 1, 1);
  assert.match(markdown, /## Site-wide sections\n\n### Tech Support\n\n- URL: https:\/\/www\.ramapo\.edu\/its\/\n/);
});
