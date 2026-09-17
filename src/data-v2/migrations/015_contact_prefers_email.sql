-- Explicit communication preferences separated from dialable telephone strings.
ALTER TABLE rockygpt_v2.campus_contacts ADD COLUMN IF NOT EXISTS prefers_email boolean NOT NULL DEFAULT false;
