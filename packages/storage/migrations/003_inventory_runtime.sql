ALTER TABLE printers ADD COLUMN configured INTEGER NOT NULL DEFAULT 1 CHECK (configured IN (0, 1));

CREATE INDEX idx_printers_active_catalogue ON printers(configured, enabled, site_id);

CREATE TABLE collector_runtime (
  instance_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  current_run_id TEXT,
  current_run_started_at TEXT,
  last_run_id TEXT,
  last_run_started_at TEXT,
  last_run_finished_at TEXT,
  next_scheduled_run_at TEXT,
  watch_mode INTEGER NOT NULL CHECK (watch_mode IN (0, 1)),
  poll_interval_seconds INTEGER NOT NULL,
  stopped_at TEXT
);

CREATE INDEX idx_collector_runtime_heartbeat ON collector_runtime(last_heartbeat_at DESC);
