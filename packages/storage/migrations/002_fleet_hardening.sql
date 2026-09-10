ALTER TABLE collection_runs ADD COLUMN configured_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_runs ADD COLUMN reachable_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_runs ADD COLUMN unreachable_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_runs ADD COLUMN partial_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_collection_runs_started
  ON collection_runs(started_at DESC);
