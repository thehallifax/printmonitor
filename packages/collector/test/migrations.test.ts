import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetDatabase } from "@printer-fleet/storage";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("schema migrations", () => {
  it("rebuilds pre-004 inventory transactionally without losing dependent history", () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-migration-")); directories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    for (const version of ["001_initial.sql", "002_fleet_hardening.sql", "003_inventory_runtime.sql"]) {
      legacy.exec(readFileSync(resolve("packages/storage/migrations", version), "utf8"));
      legacy.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(version, "2026-01-01T00:00:00.000Z");
    }
    const at = "2026-01-01T00:00:00.000Z";
    const observation = JSON.stringify({
      identity: { inventoryId: "library", hostname: "library-printer.example.invalid", displayName: "Library Copier" },
      reachability: { reachable: true, lastAttempt: at, lastSeen: at }, consumables: [], alerts: [], counters: { total: 42 },
      normalizedHealth: "healthy", collectedAt: at,
      provenance: { collector: "fixture", version: "0", adapter: "generic", protocol: "mock", collectionStatus: "complete" }
    });
    legacy.prepare("INSERT INTO sites(id,name,created_at,updated_at) VALUES (?,?,?,?)").run("site", "Fixture Site", at, at);
    legacy.prepare("INSERT INTO printers(inventory_id,site_id,hostname,display_name,location,enabled,configured,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("library", "site", "library-printer.example.invalid", "Library Copier", "Library", 1, 1, at, at);
    legacy.prepare("INSERT INTO collection_runs(id,started_at,completed_at,configured_count,attempted_count,success_count,reachable_count,unreachable_count,partial_count,failure_count,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("run-1", at, at, 1, 1, 1, 1, 0, 0, 0, "completed");
    const inserted = legacy.prepare("INSERT INTO observations(inventory_id,run_id,collected_at,reachable,normalized_health,resolved_ip,adapter,observation_json) VALUES (?,?,?,?,?,?,?,?)")
      .run("library", "run-1", at, 1, "healthy", "192.0.2.10", "generic", observation);
    legacy.prepare("INSERT INTO latest_printer_state(inventory_id,observation_id,collected_at,reachable,normalized_health,resolved_ip,observation_json) VALUES (?,?,?,?,?,?,?)")
      .run("library", inserted.lastInsertRowid, at, 1, "healthy", "192.0.2.10", observation);
    expect(legacy.pragma("foreign_key_check")).toEqual([]);
    legacy.close();

    const migrated = new FleetDatabase(path);
    expect(migrated.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: "001_initial.sql" }, { version: "002_fleet_hardening.sql" }, { version: "003_inventory_runtime.sql" }, { version: "004_inventory_targets.sql" }
    ]);
    expect((migrated.db.prepare("PRAGMA table_info(printers)").all() as { name: string }[]).map((column) => column.name)).toEqual(expect.arrayContaining(["configured", "target_type", "target_value"]));
    expect(migrated.db.prepare("SELECT inventory_id,hostname,target_type,target_value FROM printers").all()).toEqual([
      { inventory_id: "library", hostname: "library-printer.example.invalid", target_type: "hostname", target_value: "library-printer.example.invalid" }
    ]);
    expect(migrated.db.prepare("SELECT inventory_id,run_id FROM observations").all()).toEqual([{ inventory_id: "library", run_id: "run-1" }]);
    expect(migrated.db.prepare("SELECT inventory_id,observation_id FROM latest_printer_state").all()).toEqual([{ inventory_id: "library", observation_id: inserted.lastInsertRowid }]);
    expect(migrated.db.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.db.pragma("foreign_keys", { simple: true })).toBe(1);

    migrated.syncInventory({ id: "site", name: "Fixture Site" }, [{ inventoryId: "library", siteId: "site", ip: "192.0.2.42", targetType: "ip", targetValue: "192.0.2.42", displayName: "Library Copier", enabled: true }]);
    expect(migrated.db.prepare("SELECT inventory_id,hostname,target_type,target_value FROM printers").get()).toEqual({ inventory_id: "library", hostname: null, target_type: "ip", target_value: "192.0.2.42" });
    expect(migrated.getHistory("library")).toHaveLength(1);
    expect(() => migrated.db.prepare("INSERT INTO observations(inventory_id,collected_at,reachable,normalized_health,adapter,observation_json) VALUES (?,?,?,?,?,?)").run("missing", at, 0, "offline", "generic", "{}"))
      .toThrow(/FOREIGN KEY constraint failed/);
    expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collector_runtime'").get()).toEqual({ name: "collector_runtime" });
    migrated.close();

    const reopened = new FleetDatabase(path);
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='004_inventory_targets.sql'").get()).toEqual({ count: 1 });
    expect(reopened.getHistory("library")).toHaveLength(1);
    expect(reopened.db.pragma("foreign_key_check")).toEqual([]);
    expect(reopened.db.pragma("foreign_keys", { simple: true })).toBe(1);
    reopened.close();
  });
});
