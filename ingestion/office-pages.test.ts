import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  contentSitemaps,
  isUnlistedOfficePage,
  officeFolder,
  officePageUrls,
  pageKey,
  pagesCollectedElsewhere,
  readOfficeSites,
  readSkippedPages,
  sitemapLocs,
  isSkippedPostTypePath,
  sitemapPostType,
  SKIPPED_POST_TYPES,
  skippedPathPrefix,
} from './office-pages';

const folders = new Set(['finaid', 'registrar', 'titleix']);

test('a WordPress sitemap index yields its post-type sitemaps, not taxonomies or users', () => {
  const index = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://www.ramapo.edu/finaid/wp-sitemap-posts-post-1.xml</loc></sitemap>
    <sitemap><loc>https://www.ramapo.edu/finaid/wp-sitemap-posts-page-1.xml</loc></sitemap>
    <sitemap><loc>https://www.ramapo.edu/scholarships/wp-sitemap-posts-scholarship_type-2.xml</loc></sitemap>
    <sitemap><loc>https://www.ramapo.edu/finaid/wp-sitemap-taxonomies-category-1.xml</loc></sitemap>
    <sitemap><loc>https://www.ramapo.edu/finaid/wp-sitemap-users-1.xml</loc></sitemap>
  </sitemapindex>`;
  assert.deepEqual(contentSitemaps(index), [
    'https://www.ramapo.edu/finaid/wp-sitemap-posts-post-1.xml',
    'https://www.ramapo.edu/finaid/wp-sitemap-posts-page-1.xml',
    'https://www.ramapo.edu/scholarships/wp-sitemap-posts-scholarship_type-2.xml',
  ]);
  assert.deepEqual(sitemapLocs('<urlset><url><loc> https://www.ramapo.edu/finaid/?a=1&amp;b=2 </loc></url></urlset>'),
    ['https://www.ramapo.edu/finaid/?a=1&b=2']);
});

test('only pages in an office folder are collected, once each, less what other collectors keep', () => {
  const elsewhere = new Set([pageKey('https://www.ramapo.edu/registrar/forms-transcripts/')!]);
  assert.deepEqual(officePageUrls([
    'https://www.ramapo.edu/finaid/fafsa/',
    'http://www.ramapo.edu/finaid/fafsa',
    'https://www.ramapo.edu/finaid/fafsa/#deadlines',
    'https://www.ramapo.edu/FinAid/calendar/',
    'https://www.ramapo.edu/registrar/forms-transcripts',
    'https://www.ramapo.edu/registrar/',
    'https://www.ramapo.edu/finaid/2013/02/13/hello-world/',
    'https://www.ramapo.edu/finaid/sample-page/',
    'https://www.ramapo.edu/finaid/wp-content/uploads/sites/12/2026/01/aid-form.pdf',
    'https://www.ramapo.edu/commencement/2026/',
    'https://www.ramapo.edu/majors-minors/majors/accounting/',
    'https://catalog.ramapo.edu/finaid/',
  ], folders, elsewhere), [
    'https://www.ramapo.edu/FinAid/calendar/',
    'https://www.ramapo.edu/finaid/fafsa/',
    'https://www.ramapo.edu/registrar/',
  ]);
});

test('each post-type sitemap names its type, and skipped types say why they are skipped', () => {
  assert.equal(sitemapPostType('https://www.ramapo.edu/finaid/wp-sitemap-posts-page-1.xml'), 'page');
  assert.equal(sitemapPostType('https://www.ramapo.edu/scholarships/wp-sitemap-posts-recipient-2.xml'), 'recipient');
  assert.equal(sitemapPostType('https://www.ramapo.edu/crw/wp-sitemap-posts-tribe_events-1.xml'), 'tribe_events');
  assert.equal(sitemapPostType('https://www.ramapo.edu/finaid/wp-sitemap-users-1.xml'), null);
  for (const type of ['post', 'recipient', 'peers', 'success-story']) assert.ok(SKIPPED_POST_TYPES[type]);
  for (const type of ['page', 'scholarship', 'organization', 'chapters', 'tribe_events']) {
    assert.equal(Object.hasOwn(SKIPPED_POST_TYPES, type), false, type);
  }
  assert.equal(skippedPathPrefix('https://www.ramapo.edu/scholarships/recipient/jane-doe/'), '/scholarships/recipient/');
  assert.equal(skippedPathPrefix('https://www.ramapo.edu/finaid/sample/'), null);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/peer-facilitators/peers/'), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/peer-facilitators/peers/2235/'), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/study-abroad/success-story/adam-lazor/'), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/peer-facilitators/about/'), false);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/csi/post/'), false);
});

test('a page an office page links to is collected only when no sitemap listed it and it is not a WordPress listing', () => {
  const known = new Set([pageKey('https://www.ramapo.edu/finaid/fafsa/')!]);
  const skipped = new Set(['/finaid/recipient/']);
  const unlisted = (url: string) => isUnlistedOfficePage(new URL(url), folders, known, skipped);
  assert.equal(unlisted('https://www.ramapo.edu/titleix/sexual-misconduct-policy/'), true);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/fafsa'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/category/news/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/2024/05/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/page/2/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/feed/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/?s=loans'), false);
  assert.equal(unlisted('https://www.ramapo.edu/news/finaid-deadline/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/2019/03/01/weekend-edition/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/recipient/jane-doe/'), false);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/recipients-list/'), true);
  assert.equal(unlisted('https://www.ramapo.edu/finaid/recipient/'), false);
});

test('pages other collectors kept successfully are read from their raw captures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-office-elsewhere-'));
  try {
    fs.writeFileSync(path.join(dir, 'housing.raw.json'), JSON.stringify({ pages: [
      { url: 'https://www.ramapo.edu/reslife/', statusCode: 200 },
      { url: 'https://www.ramapo.edu/reslife/gone/', statusCode: 404 },
    ] }));
    fs.writeFileSync(path.join(dir, 'faculty.raw.json'), JSON.stringify([{ profileUrl: 'https://www.ramapo.edu/library/staff/' }]));
    fs.writeFileSync(path.join(dir, 'hours.raw.json'), JSON.stringify([{ sourceUrl: 'https://www.ramapo.edu/library/library-hours/' }]));
    const kept = pagesCollectedElsewhere(dir);
    assert.ok(kept.has(pageKey('https://www.ramapo.edu/reslife')!));
    assert.ok(!kept.has(pageKey('https://www.ramapo.edu/reslife/gone/')!));
    assert.ok(kept.has(pageKey('https://www.ramapo.edu/library/staff/')!));
    assert.ok(kept.has(pageKey('https://www.ramapo.edu/library/library-hours/')!));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the reviewed office list names each folder once and leaves other sources their folders', () => {
  const sites = readOfficeSites();
  const names = sites.map(site => site.folder);
  assert.equal(new Set(names).size, names.length);
  for (const site of sites) {
    assert.match(site.folder, /^[a-z0-9-]+$/);
    assert.ok(site.name.trim());
  }
  for (const owned of ['majors-minors', 'academic-calendars', 'campus-directory', 'mygraduationplan', 'news', 'fa']) {
    assert.ok(!names.includes(owned), owned);
  }
  assert.equal(officeFolder('https://www.ramapo.edu/finaid/fafsa/', new Set(names)), 'finaid');
  const skipped = readSkippedPages();
  assert.ok(skipped.has(pageKey('https://www.ramapo.edu/commencement/program')!));
  for (const [key, reason] of skipped) {
    assert.ok(officeFolder(`https://${key}/`, new Set(names)), key);
    assert.ok(reason.trim(), key);
  }
});
