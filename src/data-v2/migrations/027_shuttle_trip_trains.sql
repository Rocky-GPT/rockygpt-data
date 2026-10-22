-- The NJ Transit trains a timetable row lists beside the trip ("Train Arrives from NYC",
-- "Train Leaves for NYC"), as published; empty when the row lists none.
ALTER TABLE rockygpt_v2.shuttle_trips
  ADD COLUMN IF NOT EXISTS trains JSONB NOT NULL DEFAULT '{}'::jsonb;
