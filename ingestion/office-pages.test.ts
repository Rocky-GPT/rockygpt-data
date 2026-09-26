import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';

import { pageKey, readSites, readSkippedPages, readSkippedSections, siteFolder } from './folder-sites';
import { OFFICE_PAGES } from './office-pages';

test('the reviewed office list names each folder once and leaves other sources their folders', () => {
  const sites = readSites(OFFICE_PAGES.sitesPath);
  const names = sites.map(site => site.folder);
  assert.equal(new Set(names).size, names.length);
  for (const site of sites) {
    assert.match(site.folder, /^[a-z0-9-]+$/);
    assert.ok(site.name.trim());
  }
  for (const owned of ['majors-minors', 'academic-calendars', 'campus-directory', 'mygraduationplan', 'news', 'fa']) {
    assert.ok(!names.includes(owned), owned);
  }
  assert.equal(siteFolder('https://www.ramapo.edu/finaid/fafsa/', new Set(names)), 'finaid');
  const skipped = readSkippedPages(OFFICE_PAGES.sitesPath);
  assert.ok(skipped.has(pageKey('https://www.ramapo.edu/commencement/program')!));
  for (const [key, reason] of skipped) {
    assert.ok(siteFolder(`https://${key}/`, new Set(names)), key);
    assert.ok(reason.trim(), key);
  }
  for (const page of ['https://www.ramapo.edu/adult-students/curriculum-test/', 'https://www.ramapo.edu/honors/success-stories/']) {
    assert.ok(skipped.has(pageKey(page)!), page);
  }
  // Test copies are named one by one: the Testing Center's real pages have "test" in their names too.
  assert.ok(![...skipped.keys()].some(key => key.startsWith('www.ramapo.edu/testing/')));
  const { skippedSections } = JSON.parse(fs.readFileSync(OFFICE_PAGES.sitesPath, 'utf8')) as {
    skippedSections: Array<{ url: string; heading: string; reason: string }>;
  };
  for (const cut of skippedSections) {
    assert.ok(siteFolder(cut.url, new Set(names)), cut.url);
    assert.ok(cut.heading.trim() && cut.reason.trim(), cut.url);
  }
  assert.deepEqual(readSkippedSections(OFFICE_PAGES.sitesPath).get('www.ramapo.edu/study-abroad/academic-search/literature'),
    [{ heading: 'Student Testimonials & Videos' }]);
});
