import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gzipSync } from 'node:zlib';

import {
  contentSitemaps,
  cutSections,
  isSkippedPostTypePath,
  isUnlistedSitePage,
  pageKey,
  pagesCollectedElsewhere,
  RAMAPO_SITE_COLLECTORS,
  sitemapLocs,
  sitemapPostType,
  sitemapXml,
  sitePageUrls,
  skippedPathPrefix,
  wordpressShellPages,
} from './folder-sites';
import { SKIPPED_POST_TYPES } from './office-pages';

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

test('only pages in a listed folder are collected, once each, less what other collectors keep', () => {
  const elsewhere = new Set([pageKey('https://www.ramapo.edu/registrar/forms-transcripts/')!]);
  assert.deepEqual(sitePageUrls([
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
  ], folders, elsewhere, SKIPPED_POST_TYPES), [
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
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/peer-facilitators/peers/', SKIPPED_POST_TYPES), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/peer-facilitators/peers/2235/', SKIPPED_POST_TYPES), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/study-abroad/success-story/adam-lazor/', SKIPPED_POST_TYPES), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/peer-facilitators/about/', SKIPPED_POST_TYPES), false);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/csi/post/', SKIPPED_POST_TYPES), false);
});

test('a page a listed page links to is collected only when no sitemap listed it and it is not a WordPress listing', () => {
  const known = new Set([pageKey('https://www.ramapo.edu/finaid/fafsa/')!]);
  const skipped = new Set(['/finaid/recipient/']);
  const unlisted = (url: string) => isUnlistedSitePage(new URL(url), folders, known, SKIPPED_POST_TYPES, skipped);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-folder-sites-elsewhere-'));
  try {
    fs.writeFileSync(path.join(dir, 'housing.raw.json'), JSON.stringify({ pages: [
      { url: 'https://www.ramapo.edu/reslife/', statusCode: 200 },
      { url: 'https://www.ramapo.edu/reslife/gone/', statusCode: 404 },
    ] }));
    fs.writeFileSync(path.join(dir, 'faculty.raw.json'), JSON.stringify([{ profileUrl: 'https://www.ramapo.edu/library/staff/' }]));
    fs.writeFileSync(path.join(dir, 'hours.raw.json'), JSON.stringify([{ sourceUrl: 'https://www.ramapo.edu/library/library-hours/' }]));
    const kept = pagesCollectedElsewhere(RAMAPO_SITE_COLLECTORS, dir);
    assert.ok(kept.has(pageKey('https://www.ramapo.edu/reslife')!));
    assert.ok(!kept.has(pageKey('https://www.ramapo.edu/reslife/gone/')!));
    assert.ok(kept.has(pageKey('https://www.ramapo.edu/library/staff/')!));
    assert.ok(kept.has(pageKey('https://www.ramapo.edu/library/library-hours/')!));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pages below a dated post, such as its images, are skipped like the post', () => {
  const listed = [
    'https://www.ramapo.edu/finaid/2025/04/17/congratulations/',
    'https://www.ramapo.edu/finaid/2025/04/17/congratulations/student-photo/',
    'https://www.ramapo.edu/finaid/fafsa/',
  ];
  assert.deepEqual(sitePageUrls(listed, folders, new Set(), SKIPPED_POST_TYPES), ['https://www.ramapo.edu/finaid/fafsa/']);
  assert.equal(isUnlistedSitePage(new URL(listed[1]), folders, new Set(), SKIPPED_POST_TYPES), false);
});

test('event venues and organizers are skipped under the paths The Events Calendar serves them at', () => {
  const types = { tribe_venue: 'venues', tribe_organizer: 'organizers' };
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/holocaust/venue/adler-theater/', types), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/holocaust/organizer/chgs/', types), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/holocaust/tribe_venue/adler-theater/', types), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/berriecenter/series/macbeth/', { tribe_event_series: 'series' }), true);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/holocaust/venues/', types), false);
  assert.equal(isSkippedPostTypePath('https://www.ramapo.edu/holocaust/venue/adler-theater/', {}), false);
});

test('pages WordPress made for an uploaded image, or put behind a password, are found by their HTML', () => {
  const page = (url: string, html: string, compress = false) => compress
    ? { url, html: '', htmlGzip: gzipSync(html).toString('base64') }
    : { url, html };
  const found = wordpressShellPages({ pages: [
    page('https://www.ramapo.edu/holocaust/landscape/mailchimp-png1/', '<html><body class="attachment wp-singular attachment-png">x</body></html>', true),
    page('https://www.ramapo.edu/ahe/news/photo/', "<body id=top class='single single-attachment attachment postid-6226'>x</body>"),
    page('https://www.ramapo.edu/snh/graduate-certificate-data-modeling/', '<body class="page"><form class="post-password-form" method="post">Password:</form></body>'),
    page('https://www.ramapo.edu/dmc/programs/msds/', '<body class="wp-singular page-template page">An attachment of files is described here.</body>'),
    page('https://www.ramapo.edu/dmc/attachments/', '<body class="page page-attachments has-attachment">x</body>'),
  ] } as Parameters<typeof wordpressShellPages>[0]);
  assert.deepEqual([...found].sort(), [
    'www.ramapo.edu/ahe/news/photo',
    'www.ramapo.edu/holocaust/landscape/mailchimp-png1',
    'www.ramapo.edu/snh/graduate-certificate-data-modeling',
  ]);
});

test('a reviewed section cut leaves out that section, or everything from it on, and fails closed when it no longer matches', () => {
  const sections = ['Symposium 2027', 'Submission Criteria:', '2021 PSYCHOLOGY STUDENT POSTER GALLERY', 'Examining Conformity', 'Role Demands']
    .map(heading => ({ heading, text: `${heading} text` }));
  assert.deepEqual(cutSections(sections, [{ heading: '2021 Psychology  Student Poster Gallery', andLater: true }])?.map(s => s.heading),
    ['Symposium 2027', 'Submission Criteria:']);
  assert.deepEqual(cutSections(sections, [{ heading: 'Submission Criteria:' }])?.map(s => s.heading),
    ['Symposium 2027', '2021 PSYCHOLOGY STUDENT POSTER GALLERY', 'Examining Conformity', 'Role Demands']);
  assert.equal(cutSections(sections, [{ heading: 'Success Stories' }]), null);
});

test('a folder without a sitemap falls back, but a server error stops the collection', () => {
  const answer = (status: number, body: string) => ({ ok: status >= 200 && status < 300, status, text: () => body });
  const url = 'https://www.ramapo.edu/dh/wp-sitemap.xml';
  assert.equal(sitemapXml(url, answer(404, 'Not found')), null);
  assert.equal(sitemapXml(url, answer(200, '<html>Home</html>')), null);
  assert.equal(sitemapXml(url, answer(200, '<?xml version="1.0"?><sitemapindex></sitemapindex>')), '<?xml version="1.0"?><sitemapindex></sitemapindex>');
  assert.throws(() => sitemapXml(url, answer(503, 'Busy')), /answered 503/);
  assert.throws(() => sitemapXml(url, answer(429, 'Slow down')), /answered 429/);
});
