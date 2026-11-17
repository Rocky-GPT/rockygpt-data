# Menu normalization

`menuCalories` accepts nonnegative integral source values (including zero); malformed values stay unknown. `validateMenuData` retains explicit true/false flags, distinguishes absent allergens from a published empty list, preserves source spelling and serving sizes, and excludes the exact non-food message `Have a Nice Day`. Raw collector snapshots remain unmodified. No calorie threshold or AI classifier labels dishes/components.

Nutrition belongs to a dated menu occurrence. Never collapse it into one value per food name. `course` in the inspected raw menu payload repeated station names and did not establish a usable recipe hierarchy. `portionSize` (or the source `portion` fallback) is retained for future releases; missing portions cannot be reconstructed from an already normalized snapshot.

Database migration `020_menu_nutrition.sql` makes calories integers and adds `portion_size`. Unexpected non-integral historical values stop migration rather than being silently discarded.

Known non-food records are excluded from student-facing retrieval and normalized artifacts. (The one-off script that cleaned releases published before migration 020 was removed on 2026-11-17.)

Dietary source booleans may be explicitly false; absence is unknown. A missing allergen field is unknown, while a published empty list means none listed. Neither is an allergy-safety guarantee.

The Brain exports `name` without duplicate `title`, links dated offerings to their venue identity, and reserves exhaustive exact formatting for explicit menu/list requests. Broad meal questions use reviewed summaries emphasizing prepared dishes while keeping components available for topping/full-menu requests.

Course ingestion also preserves complete credit-hour objects instead of discarding an upper bound when `min` is nonzero. Credit display retains explicit zero-to-maximum ranges.
