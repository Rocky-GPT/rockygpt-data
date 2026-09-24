-- Feedback is kept. The Brain logins insert ratings and update them when a
-- student changes a rating or adds a reason (INSERT ... ON CONFLICT DO UPDATE);
-- they never need to remove a row. Only the table owner can delete one, for a
-- student who asks to have their feedback removed.
-- The logins exist only where they were provisioned (production Neon).
DO $$
DECLARE
  runtime TEXT;
BEGIN
  FOREACH runtime IN ARRAY ARRAY['rockygpt_brain_app', 'rockygpt_brain_development'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime) THEN
      EXECUTE format('REVOKE DELETE ON rockygpt_v2.feedback FROM %I', runtime);
    END IF;
  END LOOP;
END $$;
