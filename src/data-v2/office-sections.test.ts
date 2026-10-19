import assert from 'node:assert/strict';
import test from 'node:test';
import { pageKey, type CapturedPage } from '../directory/contact-evidence';
import { officeSectionPages, siteFolder } from './office-sections';

const page = (url: string, sections: CapturedPage['sections']): [string, CapturedPage] =>
  [pageKey(url), { url, fetchedAt: '2026-10-15T14:00:00.000Z', sections }];

test('a page belongs to the site its first folder on www.ramapo.edu names', () => {
  assert.equal(siteFolder('https://www.ramapo.edu/registrar/transcripts/'), 'registrar');
  assert.equal(siteFolder('https://ramapo.edu/Counseling/'), 'counseling');
  assert.equal(siteFolder('https://www.ramapoathletics.com/news/'), null);
  assert.equal(siteFolder('https://www.ramapo.edu/'), null);
});

test('only reviewed office sites are kept, each page with its sections less the reviewed cuts', () => {
  const pages = new Map([
    page('https://www.ramapo.edu/registrar/transcripts/', [
      { heading: 'How do I request a transcript?', text: '  Order it online through Parchment.  ' },
      { heading: 'Past Winners', text: 'Names of people.' },
      { heading: 'Empty', text: '   ' }]),
    page('https://www.ramapo.edu/news/story/', [{ heading: 'News', text: 'Not an office site.' }]),
  ]);
  const cuts = new Map([[pageKey('https://www.ramapo.edu/registrar/transcripts/'), [{ heading: 'Past Winners' }]]]);
  const rows = officeSectionPages(pages, new Set(['registrar']), cuts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, 'registrar');
  assert.deepEqual(rows[0].sections, [
    { heading: 'How do I request a transcript?', text: 'Order it online through Parchment.' }]);
  assert.match(rows[0].contentHash, /^[0-9a-f]{64}$/);
});

test('a page whose reviewed cut is no longer on it is left out rather than published uncut', () => {
  const pages = new Map([page('https://www.ramapo.edu/registrar/', [{ heading: 'Hours', text: '9 to 5' }])]);
  const cuts = new Map([[pageKey('https://www.ramapo.edu/registrar/'), [{ heading: 'Gone heading' }]]]);
  assert.deepEqual(officeSectionPages(pages, new Set(['registrar']), cuts), []);
});
