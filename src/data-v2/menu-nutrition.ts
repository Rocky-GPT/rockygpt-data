/** Published API keys. Values retain the source's units (including omitted units). */
export const MENU_NUTRIENT_FIELDS = [
  'calories', 'caloriesFromFat', 'fat', 'saturatedFat', 'transFat', 'polyunsaturatedFat',
  'cholesterol', 'sodium', 'carbohydrates', 'dietaryFiber', 'sugar', 'protein',
  'potassium', 'iron', 'calcium', 'vitaminA', 'vitaminC', 'vitaminD', 'addedSugar',
] as const;

export type MenuNutrient = (typeof MENU_NUTRIENT_FIELDS)[number];
export type MenuNutrients = Partial<Record<MenuNutrient, string | number>>;

/** Accept raw flat API values and replay the normalized nested representation unchanged. */
export function publishedMenuNutrients(item: Record<string, unknown>): MenuNutrients | undefined {
  const source = item.nutrients && typeof item.nutrients === 'object' && !Array.isArray(item.nutrients)
    ? item.nutrients as Record<string, unknown> : item;
  const nutrients: MenuNutrients = {};
  for (const key of MENU_NUTRIENT_FIELDS) {
    const value = source[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      nutrients[key] = value;
    }
  }
  return Object.keys(nutrients).length ? nutrients : undefined;
}
