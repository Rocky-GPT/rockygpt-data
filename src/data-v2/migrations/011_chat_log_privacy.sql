-- Chat telemetry is still physically hosted in the v2 schema during service
-- isolation. New writes are redacted and HMAC-pseudonymized by the logger;
-- this migration bounds and pseudonymizes rows created by older releases.
DO $$
BEGIN
  IF to_regclass('rockygpt_v2.chat_logs') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE rockygpt_v2.chat_logs
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

  UPDATE rockygpt_v2.chat_logs
     SET expires_at = created_at + interval '30 days'
   WHERE expires_at IS NULL;

  ALTER TABLE rockygpt_v2.chat_logs
    ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days'),
    ALTER COLUMN expires_at SET NOT NULL;

  -- Existing raw identifiers cannot be HMACed without putting the application
  -- secret into SQL. One-way legacy pseudonyms remove the raw value; all new
  -- records use the keyed v1 format in src/db/privacy.ts.
  UPDATE rockygpt_v2.chat_logs
     SET session_id = 'legacy_' || md5(session_id),
         visitor_id = CASE
           WHEN visitor_id IS NULL THEN NULL
           ELSE 'legacy_' || md5(visitor_id)
         END
   WHERE session_id NOT LIKE 'v1_%'
     AND session_id NOT LIKE 'legacy_%';

  CREATE INDEX IF NOT EXISTS idx_chat_logs_expires_at
    ON rockygpt_v2.chat_logs(expires_at);
END
$$;
