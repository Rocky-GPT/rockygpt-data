import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { ACADEMIC_SITES, SKIPPED_POST_TYPES } from './academic-sites';
import {
  isSkippedPostTypePath, isUnlistedSitePage, pageKey, readSites, readSkippedPages, readSkippedSections, siteDocuments, siteFolder,
  sitePageUrls,
} from './folder-sites';
import { OFFICE_PAGES } from './office-pages';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';

test('the reviewed academic list names each folder once and leaves the office sites and other sources their folders', () => {
  const sites = readSites(ACADEMIC_SITES.sitesPath);
  const names = sites.map(site => site.folder);
  assert.equal(new Set(names).size, names.length);
  for (const site of sites) {
    assert.match(site.folder, /^[a-z0-9-]+$/);
    assert.ok(site.name.trim());
  }
  const offices = new Set(readSites(OFFICE_PAGES.sitesPath).map(site => site.folder));
  for (const folder of names) assert.ok(!offices.has(folder), `${folder} is an office site`);
  for (const owned of ['majors-minors', 'academic-calendars', 'campus-directory', 'mygraduationplan', 'news', 'fa', 'catalog-2024-2025']) {
    assert.ok(!names.includes(owned), owned);
  }
  for (const school of ['ahe', 'asb', 'snh', 'sssw']) assert.ok(names.includes(school), school);
  for (const [key, reason] of readSkippedPages(ACADEMIC_SITES.sitesPath)) {
    assert.ok(siteFolder(`https://${key}/`, new Set(names)), key);
    assert.ok(reason.trim(), key);
  }
  const { skippedSections } = JSON.parse(fs.readFileSync(ACADEMIC_SITES.sitesPath, 'utf8')) as {
    skippedSections: Array<{ url: string; heading: string; reason: string }>;
  };
  assert.ok(skippedSections.length);
  for (const cut of skippedSections) {
    assert.ok(siteFolder(cut.url, new Set(names)), cut.url);
    assert.ok(cut.heading.trim() && cut.reason.trim(), cut.url);
  }
  assert.deepEqual([...readSkippedSections(ACADEMIC_SITES.sitesPath).get('www.ramapo.edu/sssw/psychology/symposium')!],
    [{ heading: '2021 PSYCHOLOGY STUDENT POSTER GALLERY', andLater: true }]);
});

test('academic sites leave out faculty profiles, dated posts and event venue listings, and keep pages and events', () => {
  for (const type of ['post', 'faculty', 'tribe_venue', 'tribe_organizer']) assert.ok(SKIPPED_POST_TYPES[type], type);
  for (const type of ['page', 'tribe_events']) assert.equal(Object.hasOwn(SKIPPED_POST_TYPES, type), false, type);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/ahe/faculty/jane-doe/', SKIPPED_POST_TYPES), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/sssw/faculty/', SKIPPED_POST_TYPES), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/ahe/faculty-resources/', SKIPPED_POST_TYPES), false);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/holocaust/event/open-classroom/', SKIPPED_POST_TYPES), false);
  // The office sites keep their own list: a page at /x/faculty/ is not skipped there.
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/ahe/faculty/jane-doe/', OFFICE_PAGES.skippedPostTypes), false);

  const folders = new Set(['ahe', 'holocaust']);
  assert.deepEqual(sitePageUrls([
    'https://www.ramapo.edu/ahe/',
    'https://www.ramapo.edu/ahe/faculty/jane-doe/',
    'https://www.ramapo.edu/ahe/2025/02/27/congratulations-to-a-student/',
    'https://www.ramapo.edu/holocaust/event/open-classroom/',
    'https://www.ramapo.edu/finaid/',
  ], folders, new Set(), SKIPPED_POST_TYPES), [
    'https://www.ramapo.edu/ahe/',
    'https://www.ramapo.edu/holocaust/event/open-classroom/',
  ]);
  const unlisted = (url: string) => isUnlistedSitePage(new URL(url), folders, new Set(), SKIPPED_POST_TYPES, new Set(['/ahe/faculty/']));
  assert.equal(unlisted('https://www.ramapo.edu/ahe/faculty/john-roe/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/ahe/advising/'), true);
});

test('academic sites leave out the pages the office sites keep', () => {
  assert.ok(ACADEMIC_SITES.collectedElsewhere.some(collector => collector.file === 'office-pages.raw.json'));
  for (const collector of OFFICE_PAGES.collectedElsewhere) {
    assert.ok(ACADEMIC_SITES.collectedElsewhere.some(own => own.file === collector.file), collector.file);
  }
});

test('a school document leaves out its faculty profiles', () => {
  const page = (url: string, html: string) => buildRawPageFromHtml({
    url, html, sourceType: 'seed', allowedHost: 'www.ramapo.edu', statusCode: 200, fetchedAt: '2026-09-26T15:00:00.000Z',
  });
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'academic-sites', collectedAt: '2026-09-26T15:00:00.000Z', seedUrls: [],
    stats: { pagesFetched: 2, pagesFailed: 0, externalLinksSeen: 0 },
    pages: [
      page('https://www.ramapo.edu/ahe/advising/', '<title>Advising - AHE</title><main><h1>Advising</h1><p>Every AHE student meets an advisor before registering.</p></main>'),
      page('https://www.ramapo.edu/ahe/faculty/jane-doe/', '<title>Jane Doe - AHE</title><main><h1>Jane Doe</h1><p>Jane Doe teaches literature and writes about novels.</p></main>'),
    ],
  };
  const documents = siteDocuments(dataset, [{ folder: 'ahe', name: 'School of Arts, Humanities, and Education (AHE)' }], SKIPPED_POST_TYPES);
  const { markdown, pages } = documents.get('ahe.md')!;
  assert.equal(pages, 1);
  assert.match(markdown, /^# School of Arts, Humanities, and Education \(AHE\)\n/);
  assert.match(markdown, /meets an advisor/);
  assert.doesNotMatch(markdown, /Jane Doe/);
  assert.equal(pageKey('https://www.ramapo.edu/AHE/advising/'), 'www.ramapo.edu/ahe/advising');
});
