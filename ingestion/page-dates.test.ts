import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { editDatedReuse, readPageEditTimes } from './page-dates';

test('the smaller site collectors read the office and school sitemap dates, only while they are recent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-page-dates-'));
  const now = Date.parse('2026-11-18T03:41:00Z');
  const state = (readAt: string, editedAt: Record<string, string>) =>
    JSON.stringify({ version: 1, readAt, sites: {}, editedAt });
  try {
    fs.writeFileSync(path.join(dir, 'office-pages-sitemaps.json'),
      state('2026-11-17T03:50:00Z', { 'www.ramapo.edu/publicsafety': '2026-11-16T12:00:00-05:00' }));
    fs.writeFileSync(path.join(dir, 'academic-sites-sitemaps.json'),
      state('2026-11-10T03:50:00Z', { 'www.ramapo.edu/nursing': '2026-11-09T12:00:00-05:00' }));
    const times = readPageEditTimes(dir, now);
    assert.equal(times.get('www.ramapo.edu/publicsafety'), '2026-11-16T12:00:00-05:00');
    // Dates a week old say nothing about tonight: the page counts as undated (its weekly night).
    assert.equal(times.has('www.ramapo.edu/nursing'), false);
    const reuse = editDatedReuse(times);
    assert.equal(reuse.listedEditedAt('https://www.ramapo.edu/publicsafety/'), '2026-11-16T12:00:00-05:00');
    assert.equal(reuse.listedEditedAt('https://www.ramapo.edu/reslife/'), undefined);
    assert.equal(reuse.undatedReuseDays, 7);
    assert.equal(reuse.deadReuseDays, 28);
    // No dates at all (a first run): nothing breaks.
    assert.equal(readPageEditTimes(path.join(dir, 'missing'), now).size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
