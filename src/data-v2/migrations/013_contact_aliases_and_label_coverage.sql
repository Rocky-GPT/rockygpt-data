-- Additive publication metadata. No backfill fabricates historical coverage.
ALTER TABLE rockygpt_v2.campus_contacts
  ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rockygpt_v2.menu_items
  ALTER COLUMN vegan DROP NOT NULL,
  ALTER COLUMN vegan DROP DEFAULT,
  ALTER COLUMN vegetarian DROP NOT NULL,
  ALTER COLUMN vegetarian DROP DEFAULT,
  ADD COLUMN IF NOT EXISTS label_coverage JSONB NOT NULL DEFAULT '{}'::jsonb;
