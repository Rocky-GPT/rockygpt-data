-- A menu file a dining venue publishes instead of dated menus (a PDF menu board), by the
-- venue's name, with the file's own title and address.
CREATE TABLE IF NOT EXISTS rockygpt_v2.menu_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id UUID NOT NULL REFERENCES rockygpt_v2.dataset_versions(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES rockygpt_v2.sources(id),
  source_record_key TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL
);
