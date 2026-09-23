import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMenuDates, normalizeMenuSnapshot, normalizeMenuWeek } from './menu-data';

const meal = [{ name: 'Lunch', groups: [{ name: 'Station', items: [{
  formalName: 'Published Dish', calories: '0', portionSize: '1 CUP',
}] }] }];

test('an empty source response stays empty while malformed menu responses fail closed', () => {
  assert.deepEqual(normalizeMenuSnapshot([]), []);
  for (const malformed of [{ error: 'unavailable' }, null, [{ name: 'Lunch', groups: 'changed' }]]) {
    assert.throws(() => normalizeMenuSnapshot(malformed));
  }
});

test('future-day request failures do not become false empty captures', async () => {
  const dates = ['2026-09-23', '2026-09-24'];
  await assert.rejects(collectMenuDates(dates, async (date) => {
    if (date === dates[1]) throw new Error('HTTP 503');
    return meal;
  }), /HTTP 503/);
  assert.deepEqual(await collectMenuDates(dates, async () => []), dates.map((date) => ({
    date, sections: [],
  })));
});

test('offline normalization preserves service dates, portions, zero calories and unknown diet', () => {
  const raw = { version: 1, collectedAt: '2026-09-24T01:00:00Z', dates: [
    { date: '2026-09-23', sections: meal }, { date: '2026-09-24', sections: [] },
  ] };
  const normalized = normalizeMenuWeek(raw);
  assert.deepEqual(normalizeMenuWeek(normalized), normalized);
  assert.equal(normalized.dates[0].date, '2026-09-23');
  const item = normalized.dates[0].sections[0].groups[0].items[0];
  assert.equal(item.calories, 0);
  assert.equal(item.portionSize, '1 CUP');
  assert.equal(item.isVegan, undefined);
  assert.equal(item.allergens, undefined);
  assert.throws(() => normalizeMenuWeek({ ...raw, dates: [{ date: '2026-02-30', sections: [] }] }));
  assert.throws(() => normalizeMenuWeek({ ...raw, dates: [raw.dates[0], raw.dates[0]] }));
});
