-- Feedback is kept. Nothing expires it and nothing deletes it.
--
-- expires_at defaulted to 90 days after each rating, which implied a
-- retention job that never existed, and the decision (2026-09-24) is that
-- none should: feedback is how wrong answers get found and fixed. This drops
-- only that unused column and its index. No feedback row is removed.
DROP INDEX IF EXISTS rockygpt_v2.feedback_expires_at_idx;
ALTER TABLE rockygpt_v2.feedback DROP COLUMN IF EXISTS expires_at;
