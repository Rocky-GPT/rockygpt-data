import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { renderClubDetailContext } from './club-detail-context';
import { chunkDocumentSections } from '../src/data-v2/document-text';
import type { RawDatasetV1, RawPageV1 } from './raw-types';

function page(url: string, sections: RawPageV1['sections']): RawPageV1 {
  return { url, sections, statusCode: 200, sourceType: 'detail', fetchedAt: '2026-09-23T01:00:00Z',
    title: 'Club', lists: [], tables: [], contacts: [], documents: [], links: [], externalLinks: [] };
}
function dataset(pages: RawPageV1[]): RawDatasetV1 {
  return { version: '1.0', dataset: 'clubs-detail', collectedAt: '2026-09-23T01:00:00Z',
    seedUrls: [], stats: { pagesFetched: pages.length, pagesFailed: 0, externalLinksSeen: 0 }, pages };
}
const clubs = [{ name: 'Club', category: 'Student Organization', websiteUrl: 'https://archway.ramapo.edu/club/' }];

test('scoped raw sections retain source dates, historical text and ambiguous officer lists with caveats', () => {
  const prose = 'Source policy condition, including the exception. '.repeat(50);
  const input = dataset([page('https://archway.ramapo.edu/club/home/', [
    { heading: 'Policy', text: prose }, { heading: 'News', text: 'Event held September 10, 2021.' },
    { heading: 'Team', text: 'Elana Secretary Shannon Vice-President Julia Treasurer Mimi President.' },
    { heading: 'Members Benefits', text: 'Membership benefits include (define your member benefits under group settings)' },
    { heading: 'There are no upcoming events.', text: 'Events [CONTENT-EVENTS_NAME_FEATURED]' },
    { heading: '5', text: 'Officers' }, { heading: 'Sign in', text: 'Log In' },
  ]), page('https://archway.ramapo.edu/club/other/', [{ heading: 'Policy', text: prose }]),
  page('https://archway.ramapo.edu/unrelated/home/', [{ heading: 'Other', text: 'Do not misattribute this policy.' }]),
  page('https://archway.ramapo.edu/club/web_login', [{ heading: 'Login', text: 'Do not publish this form.' }])]);
  const result = renderClubDetailContext(clubs, input);
  assert.equal(result.stats.publishedSections, 3);
  assert.equal(result.stats.duplicateSections, 1);
  assert.doesNotMatch(result.markdown, /define your member benefits|CONTENT-EVENTS|Do not misattribute|Do not publish|Log In/);
  assert.match(result.markdown, /September 10, 2021/);
  assert.match(result.markdown, /Elana Secretary Shannon Vice-President/);
  const chunks = chunkDocumentSections(result.markdown).filter(chunk => chunk.canonicalUrl);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every(chunk => chunk.canonicalUrl === input.pages[0].url && chunk.collectedAt === input.pages[0].fetchedAt));
  assert.ok(chunks.every(chunk => chunk.content.includes('Names and roles in flattened text do not establish')));
});

test('duplicate club scopes and failed captures cannot assign text to an arbitrary club', () => {
  const source = page('https://archway.ramapo.edu/club/policies/', [{ heading: 'Policy', text: 'Actual policy.' }]);
  assert.equal(renderClubDetailContext([...clubs, { ...clubs[0], name: 'Other Club' }], dataset([source])).stats.publishedSections, 0);
  source.statusCode = 404;
  assert.equal(renderClubDetailContext(clubs, dataset([source])).stats.publishedSections, 0);
});

// A pinned capture: the refresh restores or recollects data/raw, and a club
// editing its page must not fail the daily publish's tests.
test('captured 1Step and CSI pages retain substantive source text without template promotion', () => {
  const { clubs, capture } = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/clubs-detail-1step-csi.json'), 'utf8')
  );
  const { markdown, stats } = renderClubDetailContext(clubs, capture);
  assert.match(markdown, /We are 1STEP/);
  assert.match(markdown, /Elana Elmazi Secretary Shannon Lawlor Vice-President/);
  assert.match(markdown, /Our policies are subject to change/);
  assert.match(markdown, /recharterment process every 3 years/);
  assert.doesNotMatch(markdown, /define your member benefits under group settings|Get our newsletter and stay in the loop/);
  assert.ok(stats.publishedPages < stats.eligiblePages);
  assert.ok(stats.filteredSections > 0);
});
