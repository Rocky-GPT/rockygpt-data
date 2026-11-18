import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { GENERAL_CAMPUS_HOURS_URL, LIBRARY_HOURS_URL, OFFICE_HOURS_PAGES } from './campus-hours';
import { hoursPageUrls, pageKey, spotCheck, spotCheckReport } from './hours-spot-check';
import type { RawSourceCaptureV1 } from './raw-collector';

const library = `CIRCULATION DESK HOURS
Fall Semester
(Aug. 26 - Dec. 15, 2026)
Mon-Thu: 7:45am - 12:00am
Fri: 7:45am - 6:00pm
Sat: 10:00am - 6:00pm
Sun: 12:00pm - 12:00am
RESEARCH HELP HOURS
Fall Semester
(Aug. 26 - Dec. 15, 2026)
Mon-Thu: 9:00am - 9:00pm
Fri: 9:00am - 4:00pm
Sat & Sun: 3:00pm - 6:00pm
GAME LAB HOURS
Fall Semester
(Aug. 26 - Dec. 15, 2026)
Mon-Thu: 9:00am - 8:00pm
Fri: 9:00am - 6:00pm
Sat & Sun: CLOSED`;

const html = (text: string) => `<body>${text.split('\n').map((line) => `<p>${line}</p>`).join('')}</body>`;

function capture(pages: Array<{ url: string; html: string; gzip?: boolean; statusCode?: number }>): RawSourceCaptureV1 {
  return {
    schemaVersion: 1, dataset: 'office-pages', generatedAt: '2026-11-18T04:00:00Z', collectionSucceeded: true,
    pages: pages.map((page) => ({
      url: page.url, requestedUrl: page.url, statusCode: page.statusCode ?? 200, contentType: 'text/html',
      html: page.gzip ? '' : page.html, ...(page.gzip ? { htmlGzip: gzipSync(page.html).toString('base64') } : {}),
      sourceType: 'detail' as const, fetchedAt: '2026-11-18T04:00:00Z', contentHash: 'x',
    })),
  };
}

test('every ramapo.edu hours page is checked once, the library page among them', () => {
  const urls = hoursPageUrls();
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.includes(LIBRARY_HOURS_URL));
  assert.ok(urls.every((url) => url.startsWith('https://www.ramapo.edu/')));
  assert.ok(urls.length >= new Set(OFFICE_HOURS_PAGES.map((office) => office.url)).size);
});

test('addresses match whatever their slash, scheme or www', () => {
  assert.equal(pageKey('https://www.ramapo.edu/library/library-hours/'), pageKey('http://ramapo.edu/library/library-hours'));
});

test("a page that still reads passes, one that no longer reads is named, and one tonight's pages lack is listed", () => {
  const result = spotCheck([capture([
    { url: 'https://www.ramapo.edu/library/library-hours', html: html(library), gzip: true },
    { url: GENERAL_CAMPUS_HOURS_URL, html: html('Our hours moved to a new page.') },
    { url: 'https://www.ramapo.edu/elsewhere/', html: html('Nothing to see.'), statusCode: 404 },
  ])], [LIBRARY_HOURS_URL, GENERAL_CAMPUS_HOURS_URL, 'https://www.ramapo.edu/elsewhere/']);
  assert.equal(result.checked, 2);
  assert.deepEqual(result.failed.map((page) => page.url), [GENERAL_CAMPUS_HOURS_URL]);
  assert.deepEqual(result.unseen, ['https://www.ramapo.edu/elsewhere/']);
  const report = spotCheckReport(result);
  assert.match(report, /2 hours page\(s\) read from tonight's page copies, 1 no longer read, 1 not among/);
  assert.match(report, /about\/campus-hours\/ \(copy of 2026-11-18\)/);
});
