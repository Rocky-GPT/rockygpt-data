import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMenuMarkdown } from './generate-menu-md';
import { normalizeMenuSnapshot } from './menu-data';

test('menu context retains full ingredients, descriptions, portions and source nutrition units', () => {
  const description = `${'Published description. '.repeat(20)}Final preparation detail.`;
  const ingredients = `${'Published ingredient, '.repeat(30)}Last Ingredient (Subingredient)`;
  const menu = normalizeMenuSnapshot([{ name: 'Lunch', groups: [{ name: 'Station', items: [{
    formalName: 'Dish', description, ingredients, portionSize: '1/2 CUP',
    calories: '205', fat: '6', saturatedFat: '3g', sodium: '402mg',
    protein: '6g', vitaminA: '0mcg', addedSugar: '',
  }] }] }]);
  const markdown = renderMenuMarkdown(menu, '2026-09-23T20:00:00Z');
  assert.ok(markdown.includes(description));
  assert.ok(markdown.includes(ingredients));
  for (const text of ['Portion size (source value): 1/2 CUP', 'Calories: 205', 'Fat: 6;',
    'Saturated Fat: 3g', 'Sodium: 402mg', 'Vitamin A: 0mcg', 'Added Sugar: [empty source value]']) {
    assert.ok(markdown.includes(text), `Missing exact source value: ${text}`);
  }
  assert.doesNotMatch(markdown, /Fat: 6g|205 cal|Vegan|Vegetarian|allergen/i);
});

test('unknown menu evidence is not rendered as zero nutrition or an ingredient-free dish', () => {
  const menu = normalizeMenuSnapshot([{ name: 'Lunch', groups: [{ name: 'Station', items: [{
    formalName: 'Unknown Dish',
  }] }] }]);
  const markdown = renderMenuMarkdown(menu, '2026-09-23T20:00:00Z');
  assert.doesNotMatch(markdown, /Nutrients|Ingredients|Calories/);
  assert.match(renderMenuMarkdown([], '2026-09-23T20:00:00Z'), /Menu is not currently available/);
});
