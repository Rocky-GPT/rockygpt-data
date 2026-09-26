import assert from 'node:assert/strict';
import test from 'node:test';

import { pageKey, readSites, readSkippedPages, siteFolder } from './folder-sites';
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
});
