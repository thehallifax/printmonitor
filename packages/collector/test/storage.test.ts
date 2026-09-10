import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTOR_HEARTBEAT_FRESH_SECONDS, FleetDatabase } from "@printer-fleet/storage";
import { emptyOfflineObservation, type PrinterObservation } from "@printer-fleet/shared";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("latest state and immutable history", () => {
  it("retains last-known evidence in latest state without rewriting the failed observation", () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-test-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const inventory = { inventoryId: "site-a-printer", siteId: "site-a", hostname: "printer.example.invalid", displayName: "Printer", enabled: true };
    const retired = { inventoryId: "retired-printer", siteId: "site-a", hostname: "retired.example.invalid", displayName: "Retired", enabled: true };
    db.syncInventory({ id: "site-a", name: "Site A" }, [inventory, retired]);
    db.syncInventory({ id: "site-a", name: "Site A" }, [inventory]);
    expect(db.db.prepare("SELECT enabled FROM printers WHERE inventory_id=?").get(retired.inventoryId)).toEqual({ enabled: 0 });
    const online: PrinterObservation = {
      identity: { ...inventory, resolvedIp: "192.0.2.10", manufacturer: "Ricoh", model: "Example 5000" },
      reachability: { reachable: true, lastAttempt: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" },
      consumables: [{ type: "toner", description: "Black toner", levelPercent: 55 }], alerts: [], counters: { total: 1200 }, normalizedHealth: "healthy", collectedAt: "2026-01-01T00:00:00.000Z",
      provenance: { collector: "test", version: "0", adapter: "ricoh", protocol: "mock", rawEvidence: { vendorDetection: { vendor: "ricoh", confidence: "enterprise-oid" } } }
    };
    db.saveObservation(online);
    db.saveObservation(emptyOfflineObservation({ inventoryId: inventory.inventoryId, hostname: inventory.hostname, displayName: inventory.displayName }, "DNS resolution failed", "dns", "2026-01-01T01:00:00.000Z"));
    const stored = db.getPrinter(inventory.inventoryId)!;
    expect(stored.identity).toMatchObject({ manufacturer: "Ricoh", model: "Example 5000", resolvedIp: "192.0.2.10" });
    expect(stored.reachability.lastSeen).toBe("2026-01-01T00:00:00.000Z");
    expect(stored.consumables[0]?.levelPercent).toBe(55);
    expect(stored.counters.total).toBe(1200);
    expect(stored.provenance).toMatchObject({ adapter: "ricoh", rawEvidence: { lastKnownVendorDetection: { vendor: "ricoh", confidence: "enterprise-oid" } } });
    const state = db.getPrinterState(inventory.inventoryId, 300, new Date("2026-01-01T01:02:00.000Z"))!;
    expect(state).toMatchObject({ enabled: true, site: { id: "site-a", name: "Site A" }, isStale: false, lastKnownData: true, lastSuccessfulCollectionAt: "2026-01-01T00:00:00.000Z" });
    expect(state.reachability).toMatchObject({ reachable: false, lastAttempt: "2026-01-01T01:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" });
    const history = db.getHistory(inventory.inventoryId, 10);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ reachability: { reachable: false }, consumables: [], counters: {} });
    expect(history[1]).toMatchObject({ reachability: { reachable: true }, counters: { total: 1200 } });
    expect(db.getFleet(300, new Date("2026-01-01T01:02:00.000Z")).summary.offline).toBe(1);
    const columns = db.db.prepare("PRAGMA table_info(collection_runs)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["configured_count", "reachable_count", "unreachable_count", "partial_count"]));
    db.close();
  });
});

describe("inventory catalogue states", () => {
  it("stores pending metadata before polling and reconciles by stable id without deleting history", () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-catalogue-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    db.syncInventory({ id: "site-a", name: "Site A" }, [{ inventoryId: "stable-id", siteId: "site-a", hostname: "old.example.invalid", displayName: "Old name", location: "Old", enabled: true }]);
    const pending = db.getPrinterState("stable-id")!;
    expect(pending).toMatchObject({ operationalState: "pending", configured: true, enabled: true, normalizedHealth: "unknown", reachability: null, collectedAt: null, provenance: null, consumables: [], alerts: [], counters: {}, isStale: false, staleSince: null, ageSeconds: null, latestAttemptAt: null, lastSuccessfulCollectionAt: null, collectionDurationMs: null, lastKnownData: false });
    expect(pending.configuredAt).toBeTruthy();
    expect(db.getHistory("stable-id")).toEqual([]);

    const success: PrinterObservation = {
      identity: { inventoryId: "stable-id", hostname: "old.example.invalid", displayName: "Old name", manufacturer: "Example", model: "Synthetic" },
      reachability: { reachable: true, lastAttempt: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" },
      consumables: [{ type: "toner", description: "Black", levelPercent: 70 }], alerts: [], counters: { total: 10 }, normalizedHealth: "healthy", collectedAt: "2026-01-01T00:00:00.000Z",
      provenance: { collector: "test", version: "0", adapter: "generic", protocol: "mock", collectionStatus: "complete" }
    };
    db.saveObservation(success);
    expect(db.getPrinterState("stable-id")?.operationalState).toBe("healthy");
    db.syncInventory({ id: "site-a", name: "Renamed Site" }, [{ inventoryId: "stable-id", siteId: "site-a", hostname: "new.example.invalid", displayName: "New name", location: "New", enabled: false }]);
    expect(db.getPrinterState("stable-id")).toMatchObject({ configured: true, enabled: false, site: { name: "Renamed Site" } });
    const catalogue = db.db.prepare("SELECT hostname,display_name,location FROM printers WHERE inventory_id='stable-id'").get();
    expect(catalogue).toEqual({ hostname: "new.example.invalid", display_name: "New name", location: "New" });
    db.syncInventory({ id: "site-a", name: "Renamed Site" }, []);
    expect(db.getPrinterState("stable-id")).toMatchObject({ configured: false, enabled: false });
    expect(db.getHistory("stable-id")).toHaveLength(1);
    expect(db.getFleet().printers).toEqual([]);
    db.close();
  });

  it("distinguishes an initial failure from failure after success", () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-transitions-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const record = (inventoryId: string) => ({ inventoryId, siteId: "site", hostname: `${inventoryId}.example.invalid`, displayName: inventoryId, enabled: true });
    db.syncInventory({ id: "site", name: "Site" }, [record("first-failure"), record("prior-success")]);
    db.saveObservation(emptyOfflineObservation({ inventoryId: "first-failure", hostname: "first-failure.example.invalid", displayName: "first-failure" }, "timeout", "snmp-v2c", "2026-01-01T01:00:00.000Z", "timeout"));
    const first = db.getPrinterState("first-failure")!;
    expect(first).toMatchObject({ operationalState: "offline", lastKnownData: false });
    expect(first.lastSuccessfulCollectionAt).toBeNull();

    const prior: PrinterObservation = {
      identity: { inventoryId: "prior-success", hostname: "prior-success.example.invalid", displayName: "prior-success", model: "Synthetic" },
      reachability: { reachable: true, lastAttempt: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" },
      consumables: [], alerts: [], counters: { total: 42 }, normalizedHealth: "healthy", collectedAt: "2026-01-01T00:00:00.000Z",
      provenance: { collector: "test", version: "0", adapter: "generic", protocol: "mock" }
    };
    db.saveObservation(prior);
    db.saveObservation(emptyOfflineObservation({ inventoryId: "prior-success", hostname: "prior-success.example.invalid", displayName: "prior-success" }, "timeout", "snmp-v2c", "2026-01-01T01:00:00.000Z", "timeout"));
    expect(db.getPrinterState("prior-success")).toMatchObject({ operationalState: "offline", lastKnownData: true, lastSuccessfulCollectionAt: "2026-01-01T00:00:00.000Z", counters: { total: 42 } });
    db.close();
  });
});

describe("persisted collector runtime", () => {
  it("expires heartbeats and hides abandoned current-run state", () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-runtime-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const started = "2026-01-01T00:00:00.000Z";
    db.registerCollectorRuntime("instance-a", true, 300, started);
    expect(db.getCollectorRuntime(new Date(started))).toMatchObject({ status: "running", watchMode: true, pollIntervalSeconds: 300 });
    db.beginCollectorRun("instance-a", "run-a", started);
    expect(db.getCollectorRuntime(new Date(started))).toMatchObject({ status: "running", currentRunId: "run-a" });
    const expired = new Date(Date.parse(started) + (COLLECTOR_HEARTBEAT_FRESH_SECONDS + 1) * 1000);
    expect(db.getCollectorRuntime(expired)).toMatchObject({ status: "stale", currentRunId: undefined, nextScheduledRunAt: undefined });
    const finished = "2026-01-01T00:00:05.000Z";
    db.finishCollectorRun("instance-a", "run-a", started, finished);
    db.scheduleCollectorRun("instance-a", "2026-01-01T00:05:05.000Z", finished);
    expect(db.getCollectorRuntime(new Date(finished))).toMatchObject({ status: "running", lastRunId: "run-a", nextScheduledRunAt: "2026-01-01T00:05:05.000Z" });
    db.stopCollectorRuntime("instance-a", "2026-01-01T00:00:06.000Z");
    expect(db.getCollectorRuntime(new Date("2026-01-01T00:00:06.000Z"))).toMatchObject({ status: "stopped", currentRunId: undefined, nextScheduledRunAt: undefined });
    db.close();
  });
});
