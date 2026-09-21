-- Stop on unexpected values rather than silently erasing source nutrition.
ALTER TABLE rockygpt_v2.menu_items
  ALTER COLUMN calories TYPE INTEGER USING NULLIF(btrim(calories::text), '')::integer,
  ADD COLUMN IF NOT EXISTS portion_size TEXT;
