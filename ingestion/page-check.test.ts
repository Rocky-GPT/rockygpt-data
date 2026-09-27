import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { ACADEMIC_SITES, SKIPPED_POST_TYPES } from './academic-sites';
import { pageKey, readSites, readSkippedPages, siteFolder, sitePages } from './folder-sites';
import { type AskJev, JEV_MODEL, JEV_URL, jevAnswers, jevClient } from './jev';
import { OFFICE_PAGES } from './office-pages';
import {
  type CheckedSource, checkPages, estimatedTokens, LABELS, MAX_TEXT_CHARS, PAGE_QUESTION, pageState, pageText, QUESTION_ID, readKeptPages,
  RECHECK_DAYS, reviewMarkdown, skippedPageLine, type Verdict,
} from './page-check';
import { buildRawPageFromHtml } from './raw-collector';
import type { RawDatasetV1 } from './raw-types';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const page = (slug: string, title: string, body: string) => buildRawPageFromHtml({
  url: `https://www.ramapo.edu/berriecenter/${slug}`, html: `<title>${title} - Berrie Center</title><main><h1>${title}</h1>${body}</main>`,
  sourceType: 'seed', allowedHost: 'www.ramapo.edu', statusCode: 200, fetchedAt: '2026-09-26T15:00:00.000Z',
});
const PAGES = {
  tickets: page('tickets/', 'Tickets', '<p>The box office sells tickets for every performance, Monday to Friday from noon to 5 p.m.</p>'),
  season: page('spring-2019/', 'Spring 2019 Season', '<p>Join us on March 3, 2019 for the opening of our spring season in the Sharp Theater.</p>'),
  test: page('tickets-test/', 'Tickets Test', '<p>Testing the ticket page layout with sample text before it goes live on the site.</p>'),
  gallery: page('gallery/', 'Gallery', '<p>The Kresge and Pascal galleries show work by visiting artists through the fall term.</p>'),
};
const dataset = (pages: RawDatasetV1['pages']): RawDatasetV1 => ({
  version: '1.0', dataset: 'academic-sites', collectedAt: '2026-09-26T15:00:00.000Z',
  seedUrls: pages.map(p => p.url), stats: { pagesFetched: pages.length, pagesFailed: 0, externalLinksSeen: 0 }, pages,
});
const berrie = { folder: 'berriecenter', name: 'Berrie Center for Performing and Visual Arts' };
const source = (pages: RawDatasetV1['pages'], kept: string[] = []): CheckedSource => ({
  list: 'src/reference/academic-sites.json',
  sites: sitePages(dataset(pages), [berrie], SKIPPED_POST_TYPES),
  kept: new Set(kept.map(url => pageKey(url)!)),
});

/** Answers by the page's title, as Jev would label it, and records what it was sent. */
function fakeJev(labels: Record<string, string>, sent: unknown[] = [], inputTokens = 1_000): AskJev {
  return async (state, questions) => {
    sent.push(state);
    const { title } = state as { title: string };
    const choice = labels[title] ?? 'keep';
    const options = Object.keys(questions.page.criteria);
    const probabilities = Object.fromEntries(options.map(option => [option, option === choice ? 0.93 : 0.07 / (options.length - 1)]));
    return { model: JEV_MODEL, answers: { page: { choice, probabilities, confidence: 0.91 } }, inputTokens };
  };
}
const LABELED = { 'Spring 2019 Season - Berrie Center': 'past_event', 'Tickets Test - Berrie Center': 'test_copy' };

test('Jev is asked about each published page once, and flagged pages come with the line that would skip them', async () => {
  const sent: unknown[] = [];
  const all = [PAGES.tickets, PAGES.season, PAGES.test, PAGES.gallery];
  const first = await checkPages({
    sources: [source(all, [PAGES.gallery.url])], verdicts: {}, ask: fakeJev(LABELED, sent), now: NOW, maxNanodollars: 1e9,
  });
  assert.equal(first.pages, 4);
  assert.equal(first.kept, 1);
  assert.equal(first.sent, 3);
  assert.equal(first.nanodollars, 3 * 1_000 * 42);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(state => (state as { today: string }).today === '2026-09-27'));
  assert.ok(!sent.some(state => (state as { title: string }).title.startsWith('Gallery')), 'a kept page is not sent');
  assert.equal(first.unjudged, 0);
  assert.deepEqual(first.flagged.map(flag => [flag.url, flag.label]), [
    [PAGES.season.url, 'past_event'],
    [PAGES.test.url, 'test_copy'],
  ]);
  assert.equal(skippedPageLine(first.flagged[1]),
    `{"url": "${PAGES.test.url}", "reason": "A WordPress test page or backup copy of another page, not the site's information."}`);

  // The next day nothing has changed, so nothing is sent and the flags stay.
  const again = await checkPages({
    sources: [source(all, [PAGES.gallery.url])], verdicts: first.verdicts, ask: fakeJev({}, sent),
    now: new Date('2026-09-28T12:00:00.000Z'), maxNanodollars: 1e9,
  });
  assert.equal(again.due, 0);
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 3);
  assert.equal(again.flagged.length, 2);

  // A page whose text changed is asked again; its old verdict no longer flags it.
  const retitled = page('spring-2019/', 'Spring 2019 Season', '<p>Our 2026-2027 season opens October 9 in the Sharp Theater.</p>');
  const changed = await checkPages({
    sources: [source([PAGES.tickets, retitled, PAGES.test], [])], verdicts: first.verdicts, ask: fakeJev({}, sent),
    now: NOW, maxNanodollars: 1e9,
  });
  assert.equal(changed.sent, 1);
  assert.deepEqual(changed.flagged.map(flag => flag.label), ['test_copy']);
});

test('a verdict is asked again after RECHECK_DAYS, or when the question changes', async () => {
  const [tickets] = source([PAGES.tickets]).sites[0].pages;
  const { hash } = pageState(berrie, tickets, '2026-09-27');
  const verdict = (checkedAt: string, question = QUESTION_ID): Record<string, Verdict> => ({
    [pageKey(PAGES.tickets.url)!]: {
      url: PAGES.tickets.url, hash, question, model: JEV_MODEL, label: 'keep', probability: 0.95, keep: 0.95, confidence: 0.94, checkedAt,
    },
  });
  const due = async (verdicts: Record<string, Verdict>) =>
    (await checkPages({ sources: [source([PAGES.tickets])], verdicts, now: NOW, maxNanodollars: 0 })).due;
  assert.equal(await due(verdict('2026-09-01T00:00:00.000Z')), 0);
  assert.equal(await due(verdict(new Date(NOW.getTime() - RECHECK_DAYS * 86_400_000).toISOString())), 1);
  assert.equal(await due(verdict('2026-09-01T00:00:00.000Z', 'an-older-question')), 1);
});

test('without a key nothing is sent, and the review list comes from past verdicts', async () => {
  const first = await checkPages({
    sources: [source([PAGES.tickets, PAGES.test])], verdicts: {}, ask: fakeJev(LABELED), now: NOW, maxNanodollars: 1e9,
  });
  const offline = await checkPages({
    sources: [source([PAGES.tickets, PAGES.test, PAGES.season])], verdicts: first.verdicts, now: NOW, maxNanodollars: 1e9,
  });
  assert.equal(offline.sent, 0);
  assert.equal(offline.due, 1);
  assert.equal(offline.unjudged, 1);
  assert.ok(offline.estimatedNanodollars > 0);
  assert.deepEqual(offline.flagged.map(flag => flag.label), ['test_copy']);
  assert.match(reviewMarkdown(offline), /1 pages have not been checked yet/);
});

test('a run stops sending before it passes its spending limit or page limit', async () => {
  const sent: unknown[] = [];
  const all = [PAGES.tickets, PAGES.season, PAGES.test, PAGES.gallery];
  const estimates = source(all).sites[0].pages.map(written => estimatedTokens(pageState(berrie, written, '2026-09-27').state) * 42);
  const run = (maxNanodollars: number) =>
    checkPages({ sources: [source(all)], verdicts: {}, ask: fakeJev({}, sent, 400), now: NOW, maxNanodollars });
  const none = await run(Math.min(...estimates) - 1);
  assert.equal(none.sent, 0);
  assert.equal(none.stoppedAtLimit, true);
  const one = await run(Math.max(...estimates) + 1);
  assert.equal(one.sent, 1);
  assert.ok(one.nanodollars <= Math.max(...estimates) + 1);
  assert.equal(one.stoppedAtLimit, true);
  sent.length = 0;
  const limited = await checkPages({
    sources: [source(all)], verdicts: {}, ask: fakeJev({}, sent), now: NOW, maxNanodollars: 1e9, limit: 2,
  });
  assert.equal(limited.sent, 2);
  assert.equal(limited.stoppedAtLimit, true);
  assert.equal(sent.length, 2);
});

test('a failed call stops the check and keeps the verdicts it already had', async () => {
  let calls = 0;
  const ask: AskJev = async (state, questions) => {
    calls += 1;
    if (calls > 1) throw new Error('Jev answered 529.');
    return fakeJev({})(state, questions);
  };
  await assert.rejects(
    checkPages({ sources: [source([PAGES.tickets, PAGES.season, PAGES.test])], verdicts: {}, ask, now: NOW, maxNanodollars: 1e9 }),
    (error: Error & { result?: { sent: number; verdicts: Record<string, Verdict> } }) => {
      assert.match(error.message, /Jev stopped the check: Jev answered 529/);
      assert.equal(error.result?.sent, 1);
      assert.equal(Object.keys(error.result?.verdicts ?? {}).length, 1);
      return true;
    },
  );
  assert.ok(calls <= 4, 'no more calls start once one fails');
});

test('Jev sees the page as its document writes it, cut to a bounded length, and the hash ignores the date', () => {
  const long = page('history/', 'History', `<p>${'The Berrie Center opened in 1999 with a theater and galleries. '.repeat(400)}</p>`);
  const [written] = source([long]).sites[0].pages;
  const text = pageText(written);
  assert.ok(text.length <= MAX_TEXT_CHARS + 50);
  assert.match(text, /^## /);
  assert.match(text, /\[The rest of the page is not shown\.\]$/);
  const today = pageState(berrie, written, '2026-09-27');
  const tomorrow = pageState(berrie, written, '2026-09-28');
  assert.equal(today.hash, tomorrow.hash);
  assert.deepEqual(Object.keys(today.state), ['today', 'site', 'address', 'title', 'text']);
});

test('the labels match the question, and skip reasons reuse the site lists\' wording', () => {
  assert.deepEqual(Object.keys(PAGE_QUESTION.criteria), Object.keys(LABELS));
  assert.equal(LABELS.keep.reason, null);
  const listed = new Set([...readSkippedPages(ACADEMIC_SITES.sitesPath).values()]);
  for (const label of ['test_copy', 'past_event', 'placeholder', 'named_students', 'faculty_list']) {
    assert.ok(listed.has(LABELS[label].reason!), label);
  }
  for (const [label, { reason, criterion }] of Object.entries(LABELS)) {
    assert.ok(criterion.trim(), label);
    if (label !== 'keep') assert.ok(reason?.trim(), label);
  }
});

test('kept pages are in their list\'s folders, with a reason, and not also skipped', () => {
  for (const list of [OFFICE_PAGES.sitesPath, ACADEMIC_SITES.sitesPath]) {
    const { keptPages } = JSON.parse(fs.readFileSync(list, 'utf8')) as { keptPages: Array<{ url: string; reason: string }> };
    assert.ok(Array.isArray(keptPages), list);
    const folders = new Set(readSites(list).map(site => site.folder));
    const skipped = readSkippedPages(list);
    for (const kept of keptPages) {
      assert.ok(siteFolder(kept.url, folders), kept.url);
      assert.ok(kept.reason.trim(), kept.url);
      assert.ok(!skipped.has(pageKey(kept.url)!), kept.url);
    }
    assert.equal(readKeptPages(list).size, keptPages.length);
  }
});

test('the review list groups flags by site, most likely first, and fits in a GitHub issue', async () => {
  const many = Array.from({ length: 400 }, (_, index) => page(`test-${index}/`, `Test Copy ${index}`, '<p>Sample text for a test copy of the tickets page.</p>'));
  const labels = Object.fromEntries(many.map(p => [p.title!, 'test_copy']));
  const result = await checkPages({ sources: [source(many)], verdicts: {}, ask: fakeJev(labels), now: NOW, maxNanodollars: 1e9 });
  const markdown = reviewMarkdown(result);
  assert.ok(markdown.length <= 60_000);
  assert.match(markdown, /^# Pages to review\n/);
  assert.match(markdown, /Jev flagged 400 of 400 published/);
  assert.equal(markdown.match(/^## /gm)?.length, 1);
  assert.match(markdown, /^## Berrie Center for Performing and Visual Arts · src\/reference\/academic-sites\.json$/m);
  assert.match(markdown, /- \*\*Test copy\*\* \(93%\): \[Test Copy \d+ - Berrie Center\]\(https:\/\/www\.ramapo\.edu\/berriecenter\/test-\d+\/\)/);
  assert.match(markdown, /\d+ more flagged pages are not shown here/);
});

test('Jev\'s answers are checked against the question', () => {
  const questions = { page: PAGE_QUESTION };
  const probabilities = Object.fromEntries(Object.keys(LABELS).map(label => [label, label === 'keep' ? 0.92 : 0.01]));
  const body = { model: JEV_MODEL, answers: { page: { type: 'choice', choice: 'keep', probabilities, confidence: 0.9 } }, usage: { input_tokens: 812, output_tokens: 3 } };
  assert.deepEqual(jevAnswers(body, questions), {
    model: JEV_MODEL, answers: { page: { choice: 'keep', probabilities, confidence: 0.9 } }, inputTokens: 812,
  });
  assert.throws(() => jevAnswers({ ...body, answers: { page: { ...body.answers.page, choice: 'spam' } } }, questions), /not one of its options/);
  assert.throws(() => jevAnswers({ ...body, answers: { page: { ...body.answers.page, confidence: 2 } } }, questions), /not one of its options/);
  assert.throws(() => jevAnswers({ ...body, answers: {} }, questions), /not one of its options/);
  assert.throws(() => jevAnswers({ ...body, usage: {} }, questions), /input tokens/);
});

test('the Jev client sends the pinned model with the key, and names a refused key', async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let status = 200;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init: init! });
    const probabilities = Object.fromEntries(Object.keys(LABELS).map(label => [label, label === 'keep' ? 1 : 0]));
    return new Response(JSON.stringify(status === 200
      ? { model: JEV_MODEL, answers: { page: { type: 'choice', choice: 'keep', probabilities, confidence: 1 } }, usage: { input_tokens: 10, output_tokens: 1 } }
      : { error: 'unauthorized' }), { status, headers: { 'content-type': 'application/json' } });
  };
  try {
    const answers = await jevClient('secret-key')({ title: 'Tickets' }, { page: PAGE_QUESTION });
    assert.equal(answers.inputTokens, 10);
    assert.equal(requests[0].url, JEV_URL);
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer secret-key');
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { model: JEV_MODEL, state: { title: 'Tickets' }, questions: { page: PAGE_QUESTION } });
    status = 401;
    await assert.rejects(jevClient('wrong-key')({}, { page: PAGE_QUESTION }), /Jev answered 401: the API key was refused/);
  } finally {
    globalThis.fetch = original;
  }
});
