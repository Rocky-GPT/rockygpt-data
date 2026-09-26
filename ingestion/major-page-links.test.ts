import assert from 'node:assert/strict';
import test from 'node:test';

import { isSuccessStory, linkedPageUrls, publishedLinkedPages } from './major-page-links';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';

test('only Ramapo pages collected nowhere else are followed, once each, and never a success story', () => {
  const pages = [
    { links: [
      { url: 'https://www.ramapo.edu/dmc/4plus1/#enroll' },
      { url: 'http://www.ramapo.edu/dmc/4plus1/' },
      { url: 'https://www.ramapo.edu/success-stories/?page_id=109' },
      { url: 'https://www.ramapo.edu/success-stories/success-story/jane-doe/' },
      { url: 'https://bioinformatics.ramapo.edu/employment/index.html' },
      { url: 'https://www.ramapo.edu/majors-minors/majors/data-science/' },
      { url: 'https://www.ramapo.edu/majors-minors/' },
      { url: 'https://catalog.ramapo.edu/programs/SN-BS-CMPS/' },
      { url: 'https://apply.ramapo.edu/register/inquiry' },
      { url: 'https://www.ramapo.edu/undergraduate/wp-content/uploads/sites/283/2020/06/Form.pdf' },
      { url: 'https://www.bls.gov/ooh/' },
      { url: 'mailto:sfrees@ramapo.edu' },
      { url: 'not a url' },
    ] },
    { links: [{ url: 'https://www.ramapo.edu/dmc/4plus1/' }] },
    {},
  ];
  assert.deepEqual(linkedPageUrls(pages), [
    'https://bioinformatics.ramapo.edu/employment/index.html',
    'https://www.ramapo.edu/dmc/4plus1/',
  ]);
});

test('success stories and faculty profiles the faculty source keeps are not published from older captures', () => {
  const page = (url: string, statusCode = 200) => buildRawPageFromHtml({
    url, html: `<title>${url}</title><main><h1>Page</h1><p>Text of ${url} for students.</p></main>`,
    sourceType: 'seed', allowedHost: 'www.ramapo.edu', statusCode, fetchedAt: '2026-09-24T17:57:20.642Z',
  });
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'major-page-links', collectedAt: '2026-09-24T17:57:20.642Z',
    seedUrls: ['https://www.ramapo.edu/dmc/4plus1/', 'https://www.ramapo.edu/success-stories/success-story/jane-doe/', 'https://www.ramapo.edu/ca/faculty/kelly-dolak/'],
    stats: { pagesFetched: 4, pagesFailed: 1, externalLinksSeen: 0 },
    pages: [
      page('https://www.ramapo.edu/dmc/4plus1/'),
      page('https://www.ramapo.edu/success-stories/success-story/jane-doe/'),
      page('https://www.ramapo.edu/success-stories/?major=intl'),
      page('https://www.ramapo.edu/ahe/faculty/kelly-dolak/'),
      page('https://www.ramapo.edu/dmc/gone/', 404),
    ],
  };
  const published = publishedLinkedPages(dataset, new Set(['www.ramapo.edu/ahe/faculty/kelly-dolak']));
  assert.deepEqual(published.pages.map(entry => entry.url), ['https://www.ramapo.edu/dmc/4plus1/', 'https://www.ramapo.edu/dmc/gone/']);
  assert.deepEqual(published.seedUrls, ['https://www.ramapo.edu/dmc/4plus1/', 'https://www.ramapo.edu/ca/faculty/kelly-dolak/']);
  assert.deepEqual(published.stats, { pagesFetched: 1, pagesFailed: 1, externalLinksSeen: 0 });
  assert.equal(isSuccessStory('https://www.ramapo.edu/success-stories/'), true);
  assert.equal(isSuccessStory('https://www.ramapo.edu/success-stories-alumni/'), false);
  assert.equal(isSuccessStory('https://www.ramapo.edu/honors/success-stories/'), false);
});

