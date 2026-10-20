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

test('a reviewed site owner holds only while its quote is on its own page in this capture', async () => {
  const { checkSiteOwners } = await import('./office-sections');
  const url = 'https://www.ramapo.edu/myadvisor/contact/';
  const pages = new Map([page(url, [{ heading: 'Contact', text: 'The Center for Student Success  advises every student.' }])]);
  const site = { folder: 'myadvisor', owner: 'Center for Student Success (Academic Advising)', evidence_url: url,
    evidence_quote: 'the Center for Student Success advises', note: '' };
  assert.equal(checkSiteOwners({ reviewed_on: '2026-10-19', sites: [site] }, pages, new Set(['myadvisor'])).length, 1);
  assert.throws(() => checkSiteOwners({ reviewed_on: '', sites: [{ ...site, evidence_quote: 'gone words' }] },
    pages, new Set(['myadvisor'])), /no longer on/);
  assert.throws(() => checkSiteOwners({ reviewed_on: '', sites: [site] }, pages, new Set(['registrar'])),
    /not a reviewed office site/);
});

test('a section holding FAQ items is its own opening text and then one section per question', () => {
  const pages = new Map([page('https://www.ramapo.edu/registrar/faq/', [{ heading: 'FAQs',
    text: 'Below are questions. Can I transfer credits? Up to 65 credits. Is there a fee? $65.',
    questions: [{ question: 'Can I transfer credits?', answer: 'Up to 65 credits.' }, { question: 'Is there a fee?', answer: '$65.' }] }])]);
  const [row] = officeSectionPages(pages, new Set(['registrar']), new Map());
  assert.deepEqual(row.sections, [
    { heading: 'FAQs', text: 'Below are questions.' },
    { heading: 'Can I transfer credits?', text: 'Up to 65 credits.' },
    { heading: 'Is there a fee?', text: '$65.' }]);
});
