import assert from 'node:assert/strict';
import test from 'node:test';

import { core6Markdown } from './generate-core6-md-utils';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';
import { chunkDocumentSections } from '../src/data-v2/document-text';

const page = (url: string, html: string) => buildRawPageFromHtml({
  url, html, sourceType: 'seed', allowedHost: 'www.ramapo.edu', statusCode: 200, fetchedAt: '2026-09-24T20:00:00.000Z',
});
const sidebar = '<aside><h3>Tech Support</h3><p>Call the Help Desk at 201-684-7777 or email helpdesk@ramapo.edu.</p></aside>';
const printing = '<h3>Printing</h3><p>Print from any lab computer with your Ramapo login and campus card.</p>';
const labs = '<h3>Lab hours</h3><p>Labs open at 8 a.m. on weekdays during the fall and spring terms.</p>';
const its = (slug: string, title: string, extra: string) => page(`https://www.ramapo.edu/its/${slug}`,
  `<title>${title} - ITS</title><main><h1>${title}</h1><p>This page explains ${title.toLowerCase()} for students and staff.</p>${extra}${sidebar}</main>`);
const dataset: RawDatasetV1 = {
  version: '1.0', dataset: 'office-pages', collectedAt: '2026-09-24T20:00:00.000Z', seedUrls: [],
  stats: { pagesFetched: 4, pagesFailed: 0, externalLinksSeen: 0 },
  pages: [
    its('', 'Home', printing + labs),
    its('printing/', 'Print Services', printing + labs),
    its('labs/', 'Computer Labs', printing),
    its('email/', 'Email', ''),
  ],
};
const options = { title: 'Information Technology Services', description: 'ITS pages.' };

test("a block repeated on half the pages or more is written once, naming the pages when not all", () => {
  const { markdown, pages } = core6Markdown(dataset, { ...options, hoistRepeatedSections: true });
  const count = (text: string) => markdown.split(text).length - 1;
  assert.equal(pages, 4);
  assert.equal(count('Call the Help Desk at 201-684-7777'), 1);
  assert.match(markdown, /### Tech Support\n\n- URL: https:\/\/www\.ramapo\.edu\/its\/\n/);
  assert.match(markdown, /Shown on every Information Technology Services page\./);
  assert.equal(count('Print from any lab computer'), 1);
  assert.match(markdown, /Shown on 3 of 4 Information Technology Services pages: Computer Labs - ITS; Home - ITS; Print Services - ITS\./);
  assert.equal(count('Labs open at 8 a.m.'), 2);
  const helpDesk = chunkDocumentSections(markdown).find(chunk => chunk.content.includes('201-684-7777'));
  assert.equal(helpDesk?.canonicalUrl, 'https://www.ramapo.edu/its/');
  assert.equal(helpDesk?.headingPath, 'Information Technology Services › Site-wide sections › Tech Support');
});

test('without the option every page keeps its own copy, as the other crawled documents do', () => {
  const { markdown } = core6Markdown(dataset, options);
  assert.equal(markdown.split('Call the Help Desk at 201-684-7777').length - 1, 4);
  assert.doesNotMatch(markdown, /Site-wide sections/);
});

test("with the option, a page left with nothing of its own, such as an image's attachment page, is left out", () => {
  const attachment = page('https://www.ramapo.edu/its/screenshot_2026/', `<title>Screenshot_2026 - ITS</title><main>${sidebar}</main>`);
  const withAttachment = { ...dataset, pages: [...dataset.pages, attachment] };
  const hoisted = core6Markdown(withAttachment, { ...options, hoistRepeatedSections: true });
  assert.equal(hoisted.pages, 4);
  assert.doesNotMatch(hoisted.markdown, /Screenshot_2026/);
  assert.match(hoisted.markdown, /- Pages Included in Context: 4\n/);
  assert.match(hoisted.markdown, /Shown on every Information Technology Services page\./);
  assert.equal(core6Markdown(withAttachment, options).pages, 5);
});
