-- Brain document search matches a passage's heading path as well as its text.
-- With this index it finds those passages without building a heading vector for
-- every passage of the release on every query. The Brain checks for it by name
-- and searches the slower way where it is missing.
--
-- This is a numbered migration, not a line in schema.sql, so the first build runs
-- in its own transaction. schema.sql runs as one transaction whose ALTER TABLE
-- statements lock programs and shuttle_routes against the Brain's reads until it
-- commits; building this index there would hold those locks for the whole build.
-- CREATE INDEX itself only blocks writes to document_chunks, never reads.
CREATE INDEX IF NOT EXISTS document_chunks_heading_path_idx
  ON rockygpt_v2.document_chunks USING GIN (to_tsvector('english', metadata->>'headingPath'));
