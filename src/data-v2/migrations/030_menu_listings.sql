-- Which menus each dining venue's Sodexo listing names: a menu page (dated menus) or only files,
-- or none. A venue whose listing names no menu page publishes no dated menu.
CREATE TABLE IF NOT EXISTS rockygpt_v2.menu_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id UUID NOT NULL REFERENCES rockygpt_v2.dataset_versions(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES rockygpt_v2.sources(id),
  source_record_key TEXT NOT NULL,
  name TEXT NOT NULL,
  dated BOOLEAN NOT NULL,
  menus JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL
);
