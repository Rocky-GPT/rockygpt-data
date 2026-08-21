-- Keep the newest vote if legacy clients submitted more than one feedback
-- row for a response before request_id uniqueness was enforced.
WITH ranked_feedback AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY request_id
      ORDER BY created_at DESC, id DESC
    ) AS duplicate_position
  FROM rockygpt_v2.feedback
)
DELETE FROM rockygpt_v2.feedback AS feedback
USING ranked_feedback
WHERE feedback.id = ranked_feedback.id
  AND ranked_feedback.duplicate_position > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'feedback_request_id_unique'
      AND conrelid = 'rockygpt_v2.feedback'::regclass
  ) THEN
    ALTER TABLE rockygpt_v2.feedback
      ADD CONSTRAINT feedback_request_id_unique UNIQUE (request_id);
  END IF;
END
$$;
