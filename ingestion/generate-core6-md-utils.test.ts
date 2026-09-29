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

test("a section is written under the tab and headings it sits under, so its passages' heading path says whose it is", () => {
  const printing = page('https://www.ramapo.edu/its/mobile-printing/', `<title>Printing - ITS</title><main><h1>Printing</h1>
    <div id="tab-content"><div class="content" title="Student Printing"><h3>Where can students print or copy?</h3>
      <p>Students can only print or copy in the Fishbowl, or in the Learning Commons on floors 1, 2, 3, and 4.</p></div>
    <div class="content" title="Faculty Printing"><h2>Faculty Printing</h2><p>All faculty share a pool of printers near the Dean's Suite offices.</p>
      <h3>Printer Locations</h3><ul><li>ASB122 – Undergraduate Studies Office</li><li>H113 – H-Wing Copy Room</li></ul></div></div></main>`);
  const { markdown } = core6Markdown({ ...dataset, pages: [printing] }, options);
  assert.match(markdown, /\n### Student Printing › Where can students print or copy\?\n/);
  assert.match(markdown, /\n### Faculty Printing\n/);
  assert.match(markdown, /\n### Faculty Printing › Printer Locations\n/);
  const locations = chunkDocumentSections(markdown).find(chunk => chunk.content.includes('ASB122'));
  assert.equal(locations?.headingPath, 'Information Technology Services › Printing - ITS › Faculty Printing › Printer Locations');
  assert.match(locations?.content ?? '', /^### Faculty Printing › Printer Locations/);
});

test("a heading that only says what follows are questions is not written above them", () => {
  const faqs = page('https://www.ramapo.edu/student-accounts/title-iv/', `<title>Title IV - Student Accounts</title><main>
    <h1>Title IV</h1><h2>Frequently Asked Questions (FAQ)</h2><h3>What is Title IV financial aid?</h3>
    <p>Title IV aid is federal student aid such as Pell Grants and Direct Loans.</p>
    <h2>Financial Aid FAQs</h2><h3>Can I change my answers?</h3><p>Yes, change them any time in the student portal.</p></main>`);
  const { markdown } = core6Markdown({ ...dataset, pages: [faqs] }, options);
  assert.match(markdown, /\n### What is Title IV financial aid\?\n/);
  // A question list named for its subject still names it.
  assert.match(markdown, /\n### Financial Aid FAQs › Can I change my answers\?\n/);
});
