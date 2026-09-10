PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS printers (
  inventory_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  hostname TEXT NOT NULL,
  display_name TEXT NOT NULL,
  location TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(site_id, hostname)
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  error TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id TEXT NOT NULL REFERENCES printers(inventory_id),
  run_id TEXT REFERENCES collection_runs(id),
  collected_at TEXT NOT NULL,
  reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
  normalized_health TEXT NOT NULL CHECK (normalized_health IN ('healthy','warning','critical','offline','unknown')),
  resolved_ip TEXT,
  latency_ms INTEGER,
  adapter TEXT NOT NULL,
  observation_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS latest_printer_state (
  inventory_id TEXT PRIMARY KEY REFERENCES printers(inventory_id),
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  collected_at TEXT NOT NULL,
  reachable INTEGER NOT NULL,
  normalized_health TEXT NOT NULL,
  resolved_ip TEXT,
  observation_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_printer_collected
  ON observations(inventory_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_run
  ON observations(run_id);
CREATE INDEX IF NOT EXISTS idx_latest_health
  ON latest_printer_state(normalized_health);
