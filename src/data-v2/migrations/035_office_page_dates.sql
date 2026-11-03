-- When each office page says it was last changed (its article:modified_time), so the Brain can
-- prefer the newer of two pages that disagree. Null when the page does not say.
ALTER TABLE rockygpt_v2.office_sections
  ADD COLUMN IF NOT EXISTS page_modified_at TIMESTAMPTZ;
