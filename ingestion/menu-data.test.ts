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

test('source ingredients and nutrients survive raw and normalized replay without invented units', () => {
  const ingredients = 'Wheat Flour (Niacin, Iron),  Water; Soy Sauce\n(Soybeans, Salt)';
  const sourceItem = {
    formalName: 'Published Dish', ingredients,
    calories: '205', caloriesFromFat: '50', fat: '6', saturatedFat: '3g',
    sodium: '402mg', protein: '6g', vitaminA: '0mcg', addedSugar: '',
  };
  const sections = [{ name: 'Lunch', groups: [{ name: 'Station', items: [sourceItem] }] }];
  const normalized = normalizeMenuSnapshot(sections);
  const item = normalized[0].groups[0].items[0];
  assert.equal(item.ingredients, ingredients);
  assert.deepEqual(item.nutrients, {
    calories: '205', caloriesFromFat: '50', fat: '6', saturatedFat: '3g',
    sodium: '402mg', protein: '6g', vitaminA: '0mcg', addedSugar: '',
  });
  assert.equal(item.calories, 205);
  assert.equal(item.allergens, undefined);
  assert.equal(item.isVegan, undefined);
  assert.deepEqual(normalizeMenuSnapshot(normalized), normalized);
  const week = normalizeMenuWeek({ version: 1, collectedAt: '2026-09-23T20:00:00Z',
    dates: [{ date: '2026-09-23', sections }] });
  assert.deepEqual(week.dates[0].sections, normalized);
  assert.deepEqual(normalizeMenuWeek(week), week);
});

test('missing and malformed nutrition remain unknown, while explicit zero and empty source text survive', () => {
  const normalized = normalizeMenuSnapshot([{ name: 'Lunch', groups: [{ name: 'Station', items: [
    { formalName: 'Unknown Dish', ingredients: null, protein: false, fat: {}, sodium: null },
    { formalName: 'Published Zero', ingredients: '', protein: 0, fat: '', calories: '0' },
  ] }] }]);
  const [unknown, zero] = normalized[0].groups[0].items;
  assert.equal(unknown.ingredients, undefined);
  assert.equal(unknown.nutrients, undefined);
  assert.deepEqual(zero.nutrients, { calories: '0', fat: '', protein: 0 });
  assert.equal(zero.ingredients, '');
  assert.deepEqual(normalizeMenuSnapshot(normalized), normalized);
});
