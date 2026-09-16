/** Preserve missing dietary attributes instead of publishing false/empty assertions. */
export function dietaryLabels(item: Record<string, unknown>) {
  const vegan = typeof item.isVegan === 'boolean' ? item.isVegan : null;
  const vegetarian = typeof item.isVegetarian === 'boolean' ? item.isVegetarian : null;
  const allergensPublished = Array.isArray(item.allergens);
  return {
    vegan,
    vegetarian,
    coverage: {
      vegan: vegan === null ? 'not_published' : 'published',
      vegetarian: vegetarian === null ? 'not_published' : 'published',
      allergens: allergensPublished ? 'published' : 'not_published',
    },
  };
}
