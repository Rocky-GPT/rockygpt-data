-- The feedback comment column existed under two names. schema.sql created
-- `comment`, while the /api/feedback route created and wrote `comments` via a
-- runtime ADD COLUMN IF NOT EXISTS. Every write landed in `comments`; every
-- read (src/data-explorer) looked at `comment` and so always saw NULL, which
-- is why submitted comments never appeared anywhere in the app.
--
-- `comments` wins because that is where the real data is.

-- Make sure the winning column exists before anything reads it.
ALTER TABLE rockygpt_v2.feedback ADD COLUMN IF NOT EXISTS comments TEXT;
ALTER TABLE rockygpt_v2.feedback ADD COLUMN IF NOT EXISTS category TEXT;

-- Carry over anything that did land in the legacy column, so the drop below
-- cannot lose a comment. No-op when `comment` was never populated.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'rockygpt_v2'
      AND table_name = 'feedback'
      AND column_name = 'comment'
  ) THEN
    UPDATE rockygpt_v2.feedback
       SET comments = comment
     WHERE comments IS NULL
       AND comment IS NOT NULL;

    ALTER TABLE rockygpt_v2.feedback DROP COLUMN comment;
  END IF;
END
$$;
