import assert from 'node:assert/strict';
import test from 'node:test';
import { LIBRARY_HOURS_URL, OFFICE_HOURS_PAGES, rereadFromPageCopies, type HoursSourceCapture } from './campus-hours';
import { pageKey, type PageCopy } from './page-copies';
import { PAGE_COPY_SOURCES, readsPageCopiesOnly, refreshScriptsForStates } from './refresh-publishable';

// Audit 2026-11-17, item 9: an office's hours are re-read the night its page changes, from the
// copy the nightly page collectors saved, with no request of their own.
const crw = OFFICE_HOURS_PAGES.find((office) => office.name === 'Center for Reading and Writing')!;
const page = (text: string) => `<body>${text.split('\n').map((line) => `<p>${line}</p>`).join('')}</body>`;
const crwPage = (friday: string) => page(`Hours\nMonday - Thursday, 10 AM - 8:00 PM\nFriday - ${friday}\nWeekends - by virtual appointment`);
const saved: HoursSourceCapture = { sourceUrl: crw.url, collectedAt: '2026-11-12T03:00:00.000Z', html: crwPage('10:00 AM - 4:00 PM') };
const copiesOf = (html: string, fetchedAt: string) => new Map<string, PageCopy>([[pageKey(crw.url), { html, fetchedAt }]]);

test("a changed office page is re-read from tonight's copy", () => {
  const tonight = crwPage('10:00 AM - 2:00 PM');
  const result = rereadFromPageCopies([saved], copiesOf(tonight, '2026-11-19T03:50:00.000Z'));
  assert.deepEqual(result.changed, [crw.url]);
  assert.deepEqual(result.captures, [{ sourceUrl: crw.url, collectedAt: '2026-11-19T03:50:00.000Z', html: tonight }]);
  assert.deepEqual(result.kept, []);
});

test('an unchanged page, an older copy, or a page with no copy keeps its saved read', () => {
  assert.deepEqual(rereadFromPageCopies([saved], copiesOf(saved.html, '2026-11-19T03:50:00.000Z')).captures, [saved]);
  // A copy the page collector reused without downloading keeps its older download time.
  assert.deepEqual(rereadFromPageCopies([saved], copiesOf(crwPage('9 AM - 1 PM'), '2026-11-10T03:00:00.000Z')).captures, [saved]);
  const library: HoursSourceCapture = { sourceUrl: LIBRARY_HOURS_URL, collectedAt: saved.collectedAt, html: page('x') };
  assert.deepEqual(rereadFromPageCopies([library], copiesOf(crwPage('9 AM - 1 PM'), '2026-11-19T03:50:00.000Z')).captures, [library]);
});

test('a changed page that no longer reads keeps its saved read and is named', () => {
  const result = rereadFromPageCopies([saved], copiesOf(page('Our hours moved to a new page.'), '2026-11-19T03:50:00.000Z'));
  assert.deepEqual(result.captures, [saved]);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.kept.map((entry) => [entry.url, entry.keptFrom]), [[crw.url, saved.collectedAt]]);
});

test('hours run every night after the page collectors, and read only page copies unless due', () => {
  assert.deepEqual([...PAGE_COPY_SOURCES], ['campus-hours']);
  const week = 168;
  const states = [
    { key: 'campus-hours', status: 'fresh' as const, ageHours: 24, maxAgeHours: week },
    { key: 'office-pages', status: 'fresh' as const, ageHours: 24, maxAgeHours: week },
    { key: 'academic-sites', status: 'fresh' as const, ageHours: 24, maxAgeHours: week },
  ];
  assert.deepEqual(refreshScriptsForStates(states), ['fetch:office-pages', 'fetch:academic-sites', 'fetch:hours']);
  assert.equal(readsPageCopiesOnly('campus-hours', states, new Set(), []), true);
  // Due within a day, named by hand, or no longer replaying: every hours page is read from Ramapo's sites.
  const due = [{ ...states[0], ageHours: 150 }];
  assert.equal(readsPageCopiesOnly('campus-hours', due, new Set(), []), false);
  assert.equal(readsPageCopiesOnly('campus-hours', states, new Set(['campus-hours']), []), false);
  assert.equal(readsPageCopiesOnly('campus-hours', states, new Set(), ['fetch:hours']), false);
  assert.equal(readsPageCopiesOnly('office-pages', states, new Set(), []), false);
});
