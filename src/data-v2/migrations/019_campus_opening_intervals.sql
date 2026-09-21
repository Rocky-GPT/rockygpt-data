-- NULL means unknown; [] means explicitly closed. Keep source schedule text intact.
ALTER TABLE rockygpt_v2.campus_hours ADD COLUMN IF NOT EXISTS hours jsonb;
