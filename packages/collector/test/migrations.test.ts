import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetDatabase } from "@printer-fleet/storage";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("schema migrations", () => {
  it("applies inventory/runtime migration to a database at the previous schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-migration-")); directories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const legacy = new Database(path);
    for (const version of ["001_initial.sql", "002_fleet_hardening.sql"]) {
      legacy.exec(readFileSync(resolve("packages/storage/migrations", version), "utf8"));
      legacy.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(version, "2026-01-01T00:00:00.000Z");
    }
    legacy.close();

    const migrated = new FleetDatabase(path);
    expect(migrated.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: "001_initial.sql" }, { version: "002_fleet_hardening.sql" }, { version: "003_inventory_runtime.sql" }
    ]);
    expect((migrated.db.prepare("PRAGMA table_info(printers)").all() as { name: string }[]).map((column) => column.name)).toContain("configured");
    expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collector_runtime'").get()).toEqual({ name: "collector_runtime" });
    migrated.close();
  });
});
