import assert from 'node:assert/strict';
import test from 'node:test';
import { dietaryLabels } from './dietary-labels';

test('unknown labels remain distinct from explicit false and a published empty list', () => {
  assert.deepEqual(dietaryLabels({}), {
    vegan: null, vegetarian: null,
    coverage: { vegan: 'not_published', vegetarian: 'not_published', allergens: 'not_published' },
  });
  assert.deepEqual(dietaryLabels({ isVegan: false, isVegetarian: true, allergens: [] }), {
    vegan: false, vegetarian: true,
    coverage: { vegan: 'published', vegetarian: 'published', allergens: 'published' },
  });
  assert.equal(dietaryLabels({ isVegan: 'false' }).vegan, null);
});
