PRAGMA foreign_keys = OFF;
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
DROP TABLE printers;
ALTER TABLE printers_new RENAME TO printers;
CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_site_target ON printers(site_id, target_value);
PRAGMA foreign_keys = ON;
