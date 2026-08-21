-- Migration marker for the snapshot/release cutover. Fresh databases are
-- bootstrapped from schema.sql; these additive statements make the rollout
-- explicit and safe for databases created before release manifests existed.
ALTER TABLE rockygpt_v2.feedback
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days');

ALTER TABLE rockygpt_v2.feedback ALTER COLUMN question SET DEFAULT '';
ALTER TABLE rockygpt_v2.feedback ALTER COLUMN answer SET DEFAULT '';

-- Retention may prune an old retired release that is still named as the
-- predecessor of a newer release. Preserve the newer release and clear only
-- its optional rollback pointer.
ALTER TABLE rockygpt_v2.releases
  DROP CONSTRAINT IF EXISTS releases_previous_release_id_fkey;
ALTER TABLE rockygpt_v2.releases
  ADD CONSTRAINT releases_previous_release_id_fkey
  FOREIGN KEY (previous_release_id)
  REFERENCES rockygpt_v2.releases(id)
  ON DELETE SET NULL;
