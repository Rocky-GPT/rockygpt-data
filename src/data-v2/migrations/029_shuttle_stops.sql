-- What each shuttle stop is and where to wait there, from the stop-descriptions page, under the
-- stop name the timetables use.
CREATE TABLE IF NOT EXISTS rockygpt_v2.shuttle_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id UUID NOT NULL REFERENCES rockygpt_v2.dataset_versions(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES rockygpt_v2.sources(id),
  source_record_key TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  pickup TEXT,
  collected_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL
);
