-- Stable academic-calendar concepts replace guessed full-text vocabulary.
ALTER TABLE rockygpt_v2.academic_dates ADD COLUMN IF NOT EXISTS family TEXT;
ALTER TABLE rockygpt_v2.academic_dates ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE rockygpt_v2.academic_dates ADD COLUMN IF NOT EXISTS term_id TEXT;
ALTER TABLE rockygpt_v2.academic_dates ADD COLUMN IF NOT EXISTS session TEXT;
ALTER TABLE rockygpt_v2.academic_dates ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Existing active releases keep NULL here and use the repository's
-- deterministic compatibility classifier. Every newly published release
-- writes canonical values; no placeholder is allowed to masquerade as a real
-- classification during the transition.
