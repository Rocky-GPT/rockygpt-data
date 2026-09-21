-- Clean contact fields; raw source strings and review findings stay in ingestion metadata.
ALTER TABLE rockygpt_v2.campus_contacts
  ADD COLUMN IF NOT EXISTS type text CHECK (type IN ('person', 'office')),
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS status text CHECK (status = 'retired'),
  ADD COLUMN IF NOT EXISTS offices jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS normalization_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
