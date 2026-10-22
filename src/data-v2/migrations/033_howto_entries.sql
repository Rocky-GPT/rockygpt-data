-- How-to entries a model listed from each office page, each step held to a quote on the page
-- (src/data-v2/howto-entries.ts). Empty when the page has none or was not read for its content.
ALTER TABLE rockygpt_v2.office_sections
  ADD COLUMN IF NOT EXISTS howto_entries JSONB NOT NULL DEFAULT '[]'::jsonb;
