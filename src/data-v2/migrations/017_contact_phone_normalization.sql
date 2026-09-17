-- Structured phone data, communication preferences, and immutable raw source text for campus_contacts.
ALTER TABLE rockygpt_v2.campus_contacts
  ADD COLUMN IF NOT EXISTS raw_phone text,
  ADD COLUMN IF NOT EXISTS phones jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preferred_contact text,
  ADD COLUMN IF NOT EXISTS contact_note text,
  ADD COLUMN IF NOT EXISTS phone_normalization_status text NOT NULL DEFAULT 'none';
