CREATE TABLE printers_new (
  inventory_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  hostname TEXT,
  target_type TEXT NOT NULL DEFAULT 'hostname' CHECK (target_type IN ('hostname','ip')),
  target_value TEXT,
  display_name TEXT NOT NULL,
  location TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  configured INTEGER NOT NULL DEFAULT 1 CHECK (configured IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO printers_new(inventory_id,site_id,hostname,target_type,target_value,display_name,location,enabled,configured,created_at,updated_at)
  SELECT inventory_id,site_id,hostname,'hostname',hostname,display_name,location,enabled,COALESCE(configured,1),created_at,updated_at FROM printers;

CREATE TABLE observations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id TEXT NOT NULL REFERENCES printers_new(inventory_id),
  run_id TEXT REFERENCES collection_runs(id),
  collected_at TEXT NOT NULL,
  reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
  normalized_health TEXT NOT NULL CHECK (normalized_health IN ('healthy','warning','critical','offline','unknown')),
  resolved_ip TEXT,
  latency_ms INTEGER,
  adapter TEXT NOT NULL,
  observation_json TEXT NOT NULL
);
INSERT INTO observations_new(id,inventory_id,run_id,collected_at,reachable,normalized_health,resolved_ip,latency_ms,adapter,observation_json)
  SELECT id,inventory_id,run_id,collected_at,reachable,normalized_health,resolved_ip,latency_ms,adapter,observation_json FROM observations;

CREATE TABLE latest_printer_state_new (
  inventory_id TEXT PRIMARY KEY REFERENCES printers_new(inventory_id),
  observation_id INTEGER NOT NULL REFERENCES observations_new(id),
  collected_at TEXT NOT NULL,
  reachable INTEGER NOT NULL,
  normalized_health TEXT NOT NULL,
  resolved_ip TEXT,
  observation_json TEXT NOT NULL
);
INSERT INTO latest_printer_state_new(inventory_id,observation_id,collected_at,reachable,normalized_health,resolved_ip,observation_json)
  SELECT inventory_id,observation_id,collected_at,reachable,normalized_health,resolved_ip,observation_json FROM latest_printer_state;

DROP TABLE latest_printer_state;
DROP TABLE observations;
DROP TABLE printers;
ALTER TABLE printers_new RENAME TO printers;
ALTER TABLE observations_new RENAME TO observations;
ALTER TABLE latest_printer_state_new RENAME TO latest_printer_state;
CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_site_target ON printers(site_id, target_value);
CREATE INDEX IF NOT EXISTS idx_observations_printer_collected ON observations(inventory_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_run ON observations(run_id);
CREATE INDEX IF NOT EXISTS idx_latest_health ON latest_printer_state(normalized_health);
