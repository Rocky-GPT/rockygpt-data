-- What an office's own site says, one row per captured page under a reviewed office site's folder
-- (office-sites.json), with its headed sections less the reviewed cuts. The identity compile links
-- each office to the pages of the folder its reviewed website names.
CREATE TABLE IF NOT EXISTS rockygpt_v2.office_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id UUID NOT NULL REFERENCES rockygpt_v2.dataset_versions(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES rockygpt_v2.sources(id),
  source_record_key TEXT NOT NULL,
  site_folder TEXT NOT NULL,
  url TEXT NOT NULL,
  sections JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL
);
