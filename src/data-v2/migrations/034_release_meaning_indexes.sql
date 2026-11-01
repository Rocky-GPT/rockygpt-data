-- The Brain's meaning index for a release (rockygpt-brain scripts/publish_meaning_index.py): each
-- how-to unit's, office card's and program, course, event, club and person card's embedding, in
-- 8 bits with one float32 scale per vector, and the index's JSON (units, labels, cards). The Brain
-- uses it only while its release and identity publication are active; it goes with its release.
CREATE TABLE IF NOT EXISTS rockygpt_v2.release_meaning_indexes (
  dataset_version_id UUID PRIMARY KEY REFERENCES rockygpt_v2.dataset_versions(id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  meta JSONB NOT NULL,
  vectors BYTEA NOT NULL,
  scales BYTEA NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Brain's campus login reads it, as it reads the rest of a release.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_campus_reader') THEN
    GRANT SELECT ON rockygpt_v2.release_meaning_indexes TO brain_campus_reader;
  END IF;
END $$;
