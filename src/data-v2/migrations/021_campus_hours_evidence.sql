-- Keep schedule qualifications and the facility's actual source together.
ALTER TABLE rockygpt_v2.campus_hours
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT;
