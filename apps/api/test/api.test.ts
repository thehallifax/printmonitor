import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetDatabase } from "@printer-fleet/storage";
import { emptyOfflineObservation, type NormalizedHealth, type PrinterObservation } from "@printer-fleet/shared";
import { buildApp } from "../src/app.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function observation(id: string, health: NormalizedHealth, at: string): PrinterObservation {
  return {
    identity: { inventoryId: id, hostname: `${id}.example.invalid`, displayName: id.replace("printer-", "Printer "), location: id === "printer-warning" ? "Library" : "Office", manufacturer: "Example", model: "Model" },
    reachability: { reachable: true, latencyMs: 12, lastAttempt: at, lastSeen: at },
    consumables: health === "warning" ? [{ type: "toner", description: "Black toner", levelPercent: 10 }] : [],
    alerts: health === "critical" ? [{ severity: "critical", category: "printer", message: "Paper path fault" }] : [],
    counters: { total: 1000 }, normalizedHealth: health, collectedAt: at,
    provenance: { collector: "fixture", version: "0", adapter: "generic", protocol: "mock", collectionStatus: "complete", rawEvidence: { vendorDetection: { vendor: "generic" } } }
  };
}

describe("stored-state fleet API", () => {
  it("filters and orders printers, returns detail and bounded history, and never collects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-api-")); directories.push(directory);
    const databasePath = join(directory, "fleet.sqlite");
    const db = new FleetDatabase(databasePath);
    const ids = ["printer-healthy", "printer-warning", "printer-critical", "printer-offline", "printer-pending"];
    db.syncInventory({ id: "example-site", name: "Example Site" }, ids.map((id) => ({ inventoryId: id, siteId: "example-site", hostname: `${id}.example.invalid`, displayName: id.replace("printer-", "Printer "), location: id === "printer-warning" ? "Library" : "Office", enabled: true })));
    const fresh = "2026-01-01T00:59:00.000Z";
    db.saveObservation(observation("printer-healthy", "healthy", fresh));
    db.saveObservation(observation("printer-warning", "warning", fresh));
    db.saveObservation(observation("printer-critical", "critical", fresh));
    db.saveObservation(observation("printer-offline", "healthy", "2026-01-01T00:50:00.000Z"));
    db.saveObservation(emptyOfflineObservation({ inventoryId: "printer-offline", hostname: "printer-offline.example.invalid", displayName: "Printer offline" }, "SNMP timeout", "snmp-v2c", fresh, "timeout"));
    const observationCount = (db.db.prepare("SELECT COUNT(*) AS count FROM observations").get() as { count: number }).count;
    db.registerCollectorRuntime("runtime-test", true, 300, "2026-01-01T00:59:50.000Z");
    db.scheduleCollectorRun("runtime-test", "2026-01-01T01:05:00.000Z", "2026-01-01T00:59:50.000Z");
    db.close();

    const app = await buildApp({ databasePath, logger: false, pollIntervalSeconds: 300, now: () => new Date("2026-01-01T01:00:00.000Z") });
    const list = await app.inject({ method: "GET", url: "/api/printers" });
    expect(list.statusCode).toBe(200);
    expect(list.json().printers.map((printer: FleetPrinter) => printer.operationalState)).toEqual(["offline", "critical", "warning", "pending", "healthy"]);
    expect((await app.inject({ method: "GET", url: "/api/fleet" })).json().summary).toMatchObject({ total: 5, pending: 1, offline: 1, reachable: 3 });

    const filtered = await app.inject({ method: "GET", url: "/api/printers?search=warning&site=example-site&location=library&health=warning&reachable=true&stale=false" });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().printers.map((printer: FleetPrinter) => printer.identity.inventoryId)).toEqual(["printer-warning"]);
    expect((await app.inject({ method: "GET", url: "/api/printers?health=broken" })).statusCode).toBe(400);

    const detail = await app.inject({ method: "GET", url: "/api/printers/printer-offline" });
    expect(detail.json()).toMatchObject({ enabled: true, isStale: false, lastKnownData: true, site: { id: "example-site" }, reachability: { reachable: false, lastSeen: "2026-01-01T00:50:00.000Z" }, counters: { total: 1000 } });

    const history = await app.inject({ method: "GET", url: "/api/printers/printer-offline/history?limit=999" });
    expect(history.json()).toMatchObject({ limit: 100, history: [{ reachable: false }, { reachable: true, totalPages: 1000 }] });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    const pendingDetail = await app.inject({ method: "GET", url: "/api/printers/printer-pending" });
    expect(pendingDetail.statusCode).toBe(200);
    expect(pendingDetail.json()).toMatchObject({ operationalState: "pending", reachability: null, collectedAt: null, provenance: null, isStale: false, latestAttemptAt: null, lastSuccessfulCollectionAt: null, consumables: [], alerts: [], counters: {} });
    expect((await app.inject({ method: "GET", url: "/api/printers/printer-pending/history" })).json()).toMatchObject({ history: [] });
    expect((await app.inject({ method: "GET", url: "/api/printers?state=pending" })).json().printers).toHaveLength(1);
    expect(health.json()).toMatchObject({ status: "ok", database: { status: "ok" }, collector: { status: "running", running: true, nextScheduledRunAt: "2026-01-01T01:05:00.000Z" } });
    expect((await app.inject({ method: "POST", url: "/api/runs" })).statusCode).toBe(404);
    expect(list.body).not.toContain("SNMP_COMMUNITY");
    await app.close();

    const verification = new FleetDatabase(databasePath);
    expect((verification.db.prepare("SELECT COUNT(*) AS count FROM observations").get() as { count: number }).count).toBe(observationCount);
    verification.close();
  });
});

interface FleetPrinter { identity: { inventoryId: string }; normalizedHealth: string; operationalState: string }
