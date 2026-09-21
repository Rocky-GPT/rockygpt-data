import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMenuData } from '../../ingestion/schema';
import { dietaryLabels } from './dietary-labels';
import { filterMenuMarkdown, menuCalories } from './menu-normalization';

test('calories are nonnegative integers and preserve zero without guessing units', () => {
  for (const value of ['244', 244, ' 244 ']) assert.equal(menuCalories(value), 244);
  assert.equal(menuCalories('0'), 0);
  for (const value of ['', null, false, '-1', '2.5', '140 kcal', 'unknown']) {
    assert.equal(menuCalories(value), undefined);
  }
});

test('normalization keeps components, source spelling, portions and occurrence nutrition', () => {
  const normalized = validateMenuData([{ name: 'Dinner', groups: [{ name: 'Showcase', items: [
    { formalName: 'Have a Nice Day' },
    { formalName: 'Sliced Tomato', calories: '0', isVegan: false, allergens: [] },
    { formalName: 'French Toash' },
    { formalName: 'Penne Pasta', calories: '197', portionSize: '1/2 CUP' },
    { formalName: 'Penne Pasta', calories: '394', portionSize: '1 CUP' },
  ] }] }]);
  const items = normalized[0].groups[0].items;
  assert.deepEqual(items.map(i => i.formalName), ['Sliced Tomato', 'French Toash', 'Penne Pasta', 'Penne Pasta']);
  assert.deepEqual(items.map(i => i.calories), [0, undefined, 197, 394]);
  assert.equal(items[2].portionSize, '1/2 CUP');
  assert.deepEqual(dietaryLabels(items[0] as unknown as Record<string, unknown>), {
    vegan: false, vegetarian: null,
    coverage: { vegan: 'published', vegetarian: 'not_published', allergens: 'published' },
  });
  assert.equal(items[1].allergens, undefined);
  assert.deepEqual(validateMenuData(normalized), normalized);
});

test('known source messages are removed from menu prose without losing real food', () => {
  const content = '# Menu\n- **Have a Nice Day**\n  > Have a Nice Day\n- **Sliced Tomato** (0 cal)\n';
  assert.equal(filterMenuMarkdown(content), '# Menu\n- **Sliced Tomato** (0 cal)\n');
  assert.equal(filterMenuMarkdown(filterMenuMarkdown(content)), filterMenuMarkdown(content));
});
