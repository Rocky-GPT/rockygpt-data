-- Discovery vocabulary is separate from factual fields and identity aliases.
ALTER TABLE rockygpt_v2.campus_contacts ADD COLUMN IF NOT EXISTS search_text text;
