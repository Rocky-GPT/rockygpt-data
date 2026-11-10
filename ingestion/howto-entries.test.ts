import assert from 'node:assert/strict';
import test from 'node:test';
import { countReads, pageReads, pickPages, ReadBudget } from './howto-entries';
import type { OfficeSectionsPage } from '../src/data-v2/office-sections';

const page = (key: string, text: string): OfficeSectionsPage => ({ key, folder: 'registrar', url: `https://${key}`,
  fetchedAt: '2026-11-10T12:00:00.000Z', sections: [{ heading: 'Transcripts', text }], contentHash: text });

test('a page is read again only when its own words changed', () => {
  const before = pageReads([page('www.ramapo.edu/registrar/a', 'Order online.'), page('www.ramapo.edu/registrar/b', 'Bring your ID.'),
    page('www.ramapo.edu/registrar/c', 'Closed.')]);
  const after = pageReads([
    // The same words collected on a later night: not read again.
    { ...page('www.ramapo.edu/registrar/a', 'Order online.'), fetchedAt: '2026-11-11T12:00:00.000Z' },
    page('www.ramapo.edu/registrar/b', 'Bring your ID and $5.'),
    page('www.ramapo.edu/registrar/d', 'New page.'),
  ]);
  const count = countReads(before, after);
  assert.deepEqual({ ...count, charsToRead: 0 }, { pages: 3, same: 1, changed: 1, added: 1, gone: 1, charsToRead: 0 });
  assert.equal(count.charsToRead, after.get('www.ramapo.edu/registrar/b')!.chars + after.get('www.ramapo.edu/registrar/d')!.chars);
});

const DOLLAR = 1_000_000_000;
const rates = { input: 100, output: 500 };

test('a page is sent only while its worst case fits under the cap', () => {
  // Worst case of a 2,000-character page with a 1,000-token reply: 1,000 x 100 + 1,000 x 500 = 600,000.
  const budget = new ReadBudget(1_500_000, rates);
  const first = budget.hold(2000, 1000);
  const second = budget.hold(2000, 1000);
  assert.equal(first, 600_000);
  assert.equal(second, 600_000);
  assert.equal(budget.hold(2000, 1000), null, 'a third page out at once could pass the cap');
  // The first comes back far under its worst case, which frees room for another.
  budget.settle(first!, 400, 200);
  assert.equal(budget.hold(2000, 1000), 600_000);
  assert.equal(budget.spentUsd, (400 * 100 + 200 * 500) / DOLLAR);
});

test('what was spent never passes the cap, whatever the replies cost', () => {
  const cap = 2_000_000;
  const budget = new ReadBudget(cap, rates);
  let sent = 0;
  for (let page = 0; page < 50; page++) {
    const held = budget.hold(2000, 1000);
    if (held === null) break;
    // Every reply is as costly as it can be: all input characters as tokens' worth, a full reply.
    budget.settle(held, 1000, 1000);
    sent++;
  }
  assert.equal(sent, 3);
  assert.ok(budget.spentUsd * DOLLAR <= cap);
});

test('a call that never reached the model gives its hold back', () => {
  const budget = new ReadBudget(600_000, rates);
  const held = budget.hold(2000, 1000);
  assert.equal(budget.hold(2000, 1000), null);
  budget.settle(held!, 0, 0);
  assert.equal(budget.spentUsd, 0);
  assert.equal(budget.hold(2000, 1000), 600_000);
});

test('a sample is the first pages, or spaced evenly across them', () => {
  const pages = Array.from({ length: 10 }, (_, index) => index);
  assert.deepEqual(pickPages(pages, 3, false), [0, 1, 2]);
  assert.deepEqual(pickPages(pages, 5, true), [0, 2, 4, 6, 8]);
  assert.deepEqual(pickPages(pages, 3, true), [0, 3, 6]);
  assert.deepEqual(pickPages(pages, Infinity, true), pages);
  assert.deepEqual(pickPages(pages, 20, false), pages);
  assert.deepEqual(pickPages(pages, 0, true), []);
});
