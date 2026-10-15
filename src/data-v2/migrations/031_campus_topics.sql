-- A topic: a ramapo.edu site with no office behind it (Scholarships, Summer Session), with the
-- offices its own page names (exact graph names) and the quoted words that name them; a retired
-- topic says in its page's words that it ended.
CREATE TABLE IF NOT EXISTS rockygpt_v2.campus_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id UUID NOT NULL REFERENCES rockygpt_v2.dataset_versions(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES rockygpt_v2.sources(id),
  source_record_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'retired')),
  handled_by JSONB NOT NULL,
  url TEXT NOT NULL,
  section TEXT NOT NULL,
  quote TEXT NOT NULL,
  refer_url TEXT,
  checked_at TIMESTAMPTZ NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL
);
