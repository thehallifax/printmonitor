import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareFleetPriority, deriveStaleState, type FleetPrinterState, type FleetSummary, type PrinterIdentity, type PrinterObservation } from "@printer-fleet/shared";

export interface InventoryRecord extends PrinterIdentity {
  siteId: string;
  enabled: boolean;
}

export interface RunResult {
  configured: number;
  attempted: number;
  succeeded: number;
  reachable: number;
  unreachable: number;
  partial: number;
  failed: number;
  durationMs: number;
}

export interface CollectionRunRecord extends RunResult {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  error?: string;
}

export const COLLECTOR_HEARTBEAT_FRESH_SECONDS = 45;

export interface CollectorRuntimeRecord {
  instanceId: string;
  status: "running" | "stopped" | "stale";
  startedAt: string;
  lastHeartbeatAt: string;
  currentRunId?: string;
  currentRunStartedAt?: string;
  lastRunId?: string;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  nextScheduledRunAt?: string;
  watchMode: boolean;
  pollIntervalSeconds: number;
  stoppedAt?: string;
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
    const savePrinter = this.db.prepare(`INSERT INTO printers(inventory_id,site_id,hostname,target_type,target_value,display_name,location,enabled,configured,created_at,updated_at)
      VALUES (@inventoryId,@siteId,@hostname,@targetType,@targetValue,@displayName,@location,@enabled,1,@createdAt,@updatedAt)
      ON CONFLICT(inventory_id) DO UPDATE SET site_id=excluded.site_id, hostname=excluded.hostname, target_type=excluded.target_type, target_value=excluded.target_value, display_name=excluded.display_name,
      location=excluded.location, enabled=excluded.enabled, configured=1, updated_at=excluded.updated_at`);
    this.db.transaction(() => {
      saveSite.run(site.id, site.name, now, now);
      this.db.prepare("UPDATE printers SET configured=0, enabled=0, updated_at=? WHERE site_id=?").run(now, site.id);
      for (const printer of printers) savePrinter.run({ ...printer, targetType: printer.targetType ?? (printer.ip ? "ip" : "hostname"), targetValue: printer.targetValue ?? printer.ip ?? printer.hostname, location: printer.location ?? null, enabled: Number(printer.enabled), createdAt: now, updatedAt: now });
    })();
  }

  startRun(configured: number, attempted: number, startedAt = new Date().toISOString()): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO collection_runs(id,started_at,configured_count,attempted_count,status) VALUES (?,?,?,?,'running')")
      .run(id, startedAt, configured, attempted);
    return id;
  }

  finishRun(id: string, result: RunResult, error?: string): void {
    this.db.prepare(`UPDATE collection_runs SET completed_at=?, duration_ms=?, configured_count=?, attempted_count=?, success_count=?,
      reachable_count=?, unreachable_count=?, partial_count=?, failure_count=?, status=?, error=? WHERE id=?`).run(
      new Date().toISOString(), result.durationMs, result.configured, result.attempted, result.succeeded,
      result.reachable, result.unreachable, result.partial, result.failed,
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
      counters: Object.keys(observation.counters).length ? observation.counters : previous.counters,
      provenance: {
        ...observation.provenance,
        adapter: previous.provenance.adapter,
        rawEvidence: {
          ...(observation.provenance.rawEvidence ?? {}),
          lastKnownVendorDetection: previous.provenance.rawEvidence?.vendorDetection
        }
      }
    } : observation;
    const observationJson = JSON.stringify(observation);
    const latestJson = JSON.stringify(merged);
    const save = this.db.transaction(() => {
      const inserted = this.db.prepare(`INSERT INTO observations(inventory_id,run_id,collected_at,reachable,normalized_health,resolved_ip,latency_ms,adapter,observation_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        observation.identity.inventoryId, runId ?? null, observation.collectedAt, Number(observation.reachability.reachable),
        observation.normalizedHealth, observation.identity.resolvedIp ?? null, observation.reachability.latencyMs ?? null,
        observation.provenance.adapter, observationJson
      );
      this.db.prepare(`INSERT INTO latest_printer_state(inventory_id,observation_id,collected_at,reachable,normalized_health,resolved_ip,observation_json)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(inventory_id) DO UPDATE SET observation_id=excluded.observation_id,
        collected_at=excluded.collected_at, reachable=excluded.reachable, normalized_health=excluded.normalized_health,
        resolved_ip=excluded.resolved_ip, observation_json=excluded.observation_json`).run(
        merged.identity.inventoryId, inserted.lastInsertRowid, merged.collectedAt, Number(merged.reachability.reachable),
        merged.normalizedHealth, merged.identity.resolvedIp ?? null, latestJson
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

  getPrinterState(id: string, pollIntervalSeconds = 300, now = new Date()): FleetPrinterState | undefined {
    const row = this.db.prepare(`SELECT l.observation_json, p.inventory_id, p.hostname, p.target_type, p.target_value, p.display_name, p.location,
      p.enabled, p.configured, p.created_at, p.site_id, s.name AS site_name,
      (SELECT MAX(o.collected_at) FROM observations o WHERE o.inventory_id=p.inventory_id AND o.reachable=1) AS last_successful_at
      FROM printers p JOIN sites s ON s.id=p.site_id LEFT JOIN latest_printer_state l ON l.inventory_id=p.inventory_id
      WHERE p.inventory_id=?`).get(id) as { observation_json: string | null; inventory_id: string; hostname: string | null; target_type: "hostname" | "ip"; target_value: string; display_name: string; location: string | null; enabled: number; configured: number; created_at: string; site_id: string; site_name: string; last_successful_at: string | null } | undefined;
    if (!row) return undefined;
    if (!row.observation_json) return {
      identity: { inventoryId: row.inventory_id, ...(row.hostname ? { hostname: row.hostname } : { ip: row.target_value }), targetType: row.target_type, targetValue: row.target_value, displayName: row.display_name, location: row.location ?? undefined },
      site: { id: row.site_id, name: row.site_name }, enabled: Boolean(row.enabled), configured: Boolean(row.configured),
      configuredAt: row.created_at, operationalState: "pending", reachability: null, consumables: [], alerts: [], counters: {},
      normalizedHealth: "unknown", collectedAt: null, provenance: null, isStale: false, staleSince: null, ageSeconds: null,
      latestAttemptAt: null, lastSuccessfulCollectionAt: null, collectionDurationMs: null, lastKnownData: false
    };
    const observation = JSON.parse(row.observation_json) as PrinterObservation;
    const freshness = deriveStaleState(observation.reachability.lastAttempt, pollIntervalSeconds, now);
    return {
      ...observation,
      identity: {
        ...observation.identity,
        ...(row.hostname ? { hostname: row.hostname } : { ip: row.target_value }),
        targetType: row.target_type,
        targetValue: row.target_value,
        displayName: row.display_name,
        location: row.location ?? undefined
      },
      site: { id: row.site_id, name: row.site_name },
      enabled: Boolean(row.enabled),
      configured: Boolean(row.configured),
      configuredAt: row.created_at,
      operationalState: observation.reachability.reachable ? observation.normalizedHealth : "offline",
      ...freshness,
      latestAttemptAt: observation.reachability.lastAttempt,
      lastSuccessfulCollectionAt: row.last_successful_at,
      collectionDurationMs: observation.reachability.latencyMs ?? null,
      lastKnownData: !observation.reachability.reachable && (observation.consumables.length > 0 || Object.keys(observation.counters).length > 0)
    };
  }

  getPrinterStates(pollIntervalSeconds = 300, now = new Date()): FleetPrinterState[] {
    const ids = this.db.prepare("SELECT inventory_id FROM printers").all() as { inventory_id: string }[];
    return ids.map((row) => this.getPrinterState(row.inventory_id, pollIntervalSeconds, now)).filter((state): state is FleetPrinterState => Boolean(state)).sort(compareFleetPriority);
  }

  getHistory(id: string, limit = 25): PrinterObservation[] {
    const rows = this.db.prepare("SELECT observation_json FROM observations WHERE inventory_id=? ORDER BY id DESC LIMIT ?").all(id, limit) as { observation_json: string }[];
    return rows.map((row) => JSON.parse(row.observation_json) as PrinterObservation);
  }

  getRuns(limit = 20): CollectionRunRecord[] {
    const rows = this.db.prepare(`SELECT id, started_at, completed_at, duration_ms, configured_count, attempted_count,
      success_count, reachable_count, unreachable_count, partial_count, failure_count, status, error
      FROM collection_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : undefined,
      durationMs: Number(row.duration_ms ?? 0), configured: Number(row.configured_count), attempted: Number(row.attempted_count),
      succeeded: Number(row.success_count), reachable: Number(row.reachable_count), unreachable: Number(row.unreachable_count),
      partial: Number(row.partial_count), failed: Number(row.failure_count), status: row.status as CollectionRunRecord["status"],
      error: row.error ? String(row.error) : undefined
    }));
  }

  getRun(id: string): CollectionRunRecord | undefined {
    const row = this.db.prepare(`SELECT id, started_at, completed_at, duration_ms, configured_count, attempted_count,
      success_count, reachable_count, unreachable_count, partial_count, failure_count, status, error
      FROM collection_runs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : undefined,
      durationMs: Number(row.duration_ms ?? 0), configured: Number(row.configured_count), attempted: Number(row.attempted_count),
      succeeded: Number(row.success_count), reachable: Number(row.reachable_count), unreachable: Number(row.unreachable_count),
      partial: Number(row.partial_count), failed: Number(row.failure_count), status: row.status as CollectionRunRecord["status"],
      error: row.error ? String(row.error) : undefined
    };
  }

  isHealthy(): boolean {
    try { return (this.db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1; } catch { return false; }
  }

  registerCollectorRuntime(instanceId: string, watchMode: boolean, pollIntervalSeconds: number, at = new Date().toISOString()): void {
    this.db.prepare(`INSERT INTO collector_runtime(instance_id,started_at,last_heartbeat_at,watch_mode,poll_interval_seconds)
      VALUES (?,?,?,?,?)`).run(instanceId, at, at, Number(watchMode), pollIntervalSeconds);
  }

  heartbeatCollector(instanceId: string, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE collector_runtime SET last_heartbeat_at=? WHERE instance_id=? AND stopped_at IS NULL").run(at, instanceId);
  }

  beginCollectorRun(instanceId: string, runId: string, startedAt: string): void {
    this.db.prepare(`UPDATE collector_runtime SET last_heartbeat_at=?, current_run_id=?, current_run_started_at=?,
      next_scheduled_run_at=NULL WHERE instance_id=? AND stopped_at IS NULL`).run(startedAt, runId, startedAt, instanceId);
  }

  finishCollectorRun(instanceId: string, runId: string, startedAt: string, finishedAt = new Date().toISOString()): void {
    this.db.prepare(`UPDATE collector_runtime SET last_heartbeat_at=?, current_run_id=NULL, current_run_started_at=NULL,
      last_run_id=?, last_run_started_at=?, last_run_finished_at=? WHERE instance_id=? AND stopped_at IS NULL`)
      .run(finishedAt, runId, startedAt, finishedAt, instanceId);
  }

  scheduleCollectorRun(instanceId: string, nextScheduledRunAt: string, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE collector_runtime SET last_heartbeat_at=?, next_scheduled_run_at=? WHERE instance_id=? AND stopped_at IS NULL")
      .run(at, nextScheduledRunAt, instanceId);
  }

  stopCollectorRuntime(instanceId: string, at = new Date().toISOString()): void {
    this.db.prepare(`UPDATE collector_runtime SET last_heartbeat_at=?, stopped_at=?, current_run_id=NULL,
      current_run_started_at=NULL, next_scheduled_run_at=NULL WHERE instance_id=?`).run(at, at, instanceId);
  }

  getCollectorRuntime(now = new Date(), freshnessSeconds = COLLECTOR_HEARTBEAT_FRESH_SECONDS): CollectorRuntimeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM collector_runtime ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const heartbeatAge = (now.getTime() - Date.parse(String(row.last_heartbeat_at))) / 1000;
    const status: CollectorRuntimeRecord["status"] = row.stopped_at ? "stopped" : (!Number.isFinite(heartbeatAge) || heartbeatAge > freshnessSeconds ? "stale" : "running");
    const currentIsActive = status === "running";
    return {
      instanceId: String(row.instance_id), status, startedAt: String(row.started_at), lastHeartbeatAt: String(row.last_heartbeat_at),
      currentRunId: currentIsActive && row.current_run_id ? String(row.current_run_id) : undefined,
      currentRunStartedAt: currentIsActive && row.current_run_started_at ? String(row.current_run_started_at) : undefined,
      lastRunId: row.last_run_id ? String(row.last_run_id) : undefined,
      lastRunStartedAt: row.last_run_started_at ? String(row.last_run_started_at) : undefined,
      lastRunFinishedAt: row.last_run_finished_at ? String(row.last_run_finished_at) : undefined,
      nextScheduledRunAt: currentIsActive && row.next_scheduled_run_at ? String(row.next_scheduled_run_at) : undefined,
      watchMode: Boolean(row.watch_mode), pollIntervalSeconds: Number(row.poll_interval_seconds),
      stoppedAt: row.stopped_at ? String(row.stopped_at) : undefined
    };
  }

  getFleet(pollIntervalSeconds = 300, now = new Date()): { summary: FleetSummary & { stale: number }; printers: FleetPrinterState[] } {
    const printers = this.getPrinterStates(pollIntervalSeconds, now).filter((printer) => printer.configured && printer.enabled);
    const count = (predicate: (p: FleetPrinterState) => boolean) => printers.filter(predicate).length;
    return {
      summary: {
        total: printers.length,
        reachable: count((p) => p.reachability?.reachable === true),
        offline: count((p) => p.operationalState === "offline"),
        healthy: count((p) => p.normalizedHealth === "healthy"),
        warning: count((p) => p.normalizedHealth === "warning"),
        critical: count((p) => p.normalizedHealth === "critical"),
        unknown: count((p) => p.operationalState === "unknown"),
        pending: count((p) => p.operationalState === "pending"),
        lowConsumables: count((p) => p.consumables.some((c) => c.levelPercent !== undefined && c.levelPercent <= 20)),
        stale: printers.filter((printer) => printer.isStale).length
      },
      printers
    };
  }

  close(): void { this.db.close(); }
}
