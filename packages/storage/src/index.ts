import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FleetSummary, PrinterIdentity, PrinterObservation } from "@printer-fleet/shared";

export interface InventoryRecord extends PrinterIdentity {
  siteId: string;
  enabled: boolean;
}

export interface RunResult {
  attempted: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

export class FleetDatabase {
  readonly db: Database.Database;

  constructor(path: string) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new Database(absolutePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const migrationDir = fileURLToPath(new URL("../migrations", import.meta.url));
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
    const record = this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
      if (applied.get(file)) continue;
      const sql = readFileSync(resolve(migrationDir, file), "utf8");
      this.db.transaction(() => { this.db.exec(sql); record.run(file, new Date().toISOString()); })();
    }
    this.db.pragma("optimize");
  }

  syncInventory(site: { id: string; name: string }, printers: InventoryRecord[]): void {
    const now = new Date().toISOString();
    const saveSite = this.db.prepare(`INSERT INTO sites(id,name,created_at,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`);
    const savePrinter = this.db.prepare(`INSERT INTO printers(inventory_id,site_id,hostname,display_name,location,enabled,created_at,updated_at)
      VALUES (@inventoryId,@siteId,@hostname,@displayName,@location,@enabled,@createdAt,@updatedAt)
      ON CONFLICT(inventory_id) DO UPDATE SET hostname=excluded.hostname, display_name=excluded.display_name,
      location=excluded.location, enabled=excluded.enabled, updated_at=excluded.updated_at`);
    this.db.transaction(() => {
      saveSite.run(site.id, site.name, now, now);
      for (const printer of printers) savePrinter.run({ ...printer, location: printer.location ?? null, enabled: Number(printer.enabled), createdAt: now, updatedAt: now });
    })();
  }

  startRun(attempted: number): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO collection_runs(id,started_at,attempted_count,status) VALUES (?,?,?,'running')")
      .run(id, new Date().toISOString(), attempted);
    return id;
  }

  finishRun(id: string, result: Omit<RunResult, "attempted"> & { attempted: number }, error?: string): void {
    this.db.prepare(`UPDATE collection_runs SET completed_at=?, duration_ms=?, attempted_count=?, success_count=?,
      failure_count=?, status=?, error=? WHERE id=?`).run(
      new Date().toISOString(), result.durationMs, result.attempted, result.succeeded, result.failed,
      error ? "failed" : "completed", error ?? null, id
    );
  }

  saveObservation(observation: PrinterObservation, runId?: string): PrinterObservation {
    const previous = this.getPrinter(observation.identity.inventoryId);
    const merged: PrinterObservation = previous && !observation.reachability.reachable ? {
      ...observation,
      identity: {
        ...previous.identity,
        ...observation.identity,
        manufacturer: observation.identity.manufacturer ?? previous.identity.manufacturer,
        model: observation.identity.model ?? previous.identity.model,
        serialNumber: observation.identity.serialNumber ?? previous.identity.serialNumber,
        resolvedIp: observation.identity.resolvedIp ?? previous.identity.resolvedIp
      },
      reachability: { ...observation.reachability, lastSeen: previous.reachability.lastSeen },
      consumables: observation.consumables.length ? observation.consumables : previous.consumables,
      counters: Object.keys(observation.counters).length ? observation.counters : previous.counters
    } : observation;
    const json = JSON.stringify(merged);
    const save = this.db.transaction(() => {
      const inserted = this.db.prepare(`INSERT INTO observations(inventory_id,run_id,collected_at,reachable,normalized_health,resolved_ip,latency_ms,adapter,observation_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        merged.identity.inventoryId, runId ?? null, merged.collectedAt, Number(merged.reachability.reachable),
        merged.normalizedHealth, merged.identity.resolvedIp ?? null, merged.reachability.latencyMs ?? null,
        merged.provenance.adapter, json
      );
      this.db.prepare(`INSERT INTO latest_printer_state(inventory_id,observation_id,collected_at,reachable,normalized_health,resolved_ip,observation_json)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(inventory_id) DO UPDATE SET observation_id=excluded.observation_id,
        collected_at=excluded.collected_at, reachable=excluded.reachable, normalized_health=excluded.normalized_health,
        resolved_ip=excluded.resolved_ip, observation_json=excluded.observation_json`).run(
        merged.identity.inventoryId, inserted.lastInsertRowid, merged.collectedAt, Number(merged.reachability.reachable),
        merged.normalizedHealth, merged.identity.resolvedIp ?? null, json
      );
    });
    save();
    return merged;
  }

  getPrinter(id: string): PrinterObservation | undefined {
    const row = this.db.prepare("SELECT observation_json FROM latest_printer_state WHERE inventory_id = ?").get(id) as { observation_json: string } | undefined;
    return row ? JSON.parse(row.observation_json) as PrinterObservation : undefined;
  }

  getPrinters(): PrinterObservation[] {
    const rows = this.db.prepare("SELECT observation_json FROM latest_printer_state ORDER BY collected_at DESC").all() as { observation_json: string }[];
    return rows.map((row) => JSON.parse(row.observation_json) as PrinterObservation);
  }

  getFleet(): { summary: FleetSummary; printers: PrinterObservation[] } {
    const printers = this.getPrinters();
    const count = (predicate: (p: PrinterObservation) => boolean) => printers.filter(predicate).length;
    return {
      summary: {
        total: printers.length,
        reachable: count((p) => p.reachability.reachable),
        offline: count((p) => !p.reachability.reachable),
        healthy: count((p) => p.normalizedHealth === "healthy"),
        warning: count((p) => p.normalizedHealth === "warning"),
        critical: count((p) => p.normalizedHealth === "critical"),
        unknown: count((p) => p.normalizedHealth === "unknown"),
        lowConsumables: count((p) => p.consumables.some((c) => c.levelPercent !== undefined && c.levelPercent <= 20))
      },
      printers
    };
  }

  close(): void { this.db.close(); }
}
