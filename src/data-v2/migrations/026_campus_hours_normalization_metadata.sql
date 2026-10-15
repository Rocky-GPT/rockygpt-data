-- Preserve source-labeled seasons and conflicting/unknown schedule evidence.
-- A capture time does not establish a source's applicability dates.
ALTER TABLE rockygpt_v2.campus_hours
  ADD COLUMN IF NOT EXISTS normalization_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
