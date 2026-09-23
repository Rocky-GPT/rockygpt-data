-- Missing communication preference is unknown, not an explicit preference against email.
-- Keep immutable old releases untouched; the runtime read model treats their legacy
-- default false as unknown. Newly published contacts can now store NULL.
ALTER TABLE rockygpt_v2.campus_contacts
  ALTER COLUMN prefers_email DROP NOT NULL,
  ALTER COLUMN prefers_email DROP DEFAULT;
