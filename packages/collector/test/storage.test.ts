import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetDatabase } from "@printer-fleet/storage";
import { emptyOfflineObservation, type PrinterObservation } from "@printer-fleet/shared";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("offline state retention", () => {
  it("retains last-known device identity and last-seen time", () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-test-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const inventory = { inventoryId: "site-a-printer", siteId: "site-a", hostname: "printer.example.invalid", displayName: "Printer", enabled: true };
    db.syncInventory({ id: "site-a", name: "Site A" }, [inventory]);
    const online: PrinterObservation = {
      identity: { ...inventory, resolvedIp: "192.0.2.10", manufacturer: "Ricoh", model: "Example 5000" },
      reachability: { reachable: true, lastAttempt: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" },
      consumables: [{ type: "toner", description: "Black toner", levelPercent: 55 }], alerts: [], counters: { total: 1200 }, normalizedHealth: "healthy", collectedAt: "2026-01-01T00:00:00.000Z",
      provenance: { collector: "test", version: "0", adapter: "ricoh", protocol: "mock" }
    };
    db.saveObservation(online);
    db.saveObservation(emptyOfflineObservation({ inventoryId: inventory.inventoryId, hostname: inventory.hostname, displayName: inventory.displayName }, "DNS resolution failed", "dns", "2026-01-01T01:00:00.000Z"));
    const stored = db.getPrinter(inventory.inventoryId)!;
    expect(stored.identity).toMatchObject({ manufacturer: "Ricoh", model: "Example 5000", resolvedIp: "192.0.2.10" });
    expect(stored.reachability.lastSeen).toBe("2026-01-01T00:00:00.000Z");
    expect(stored.consumables[0]?.levelPercent).toBe(55);
    expect(stored.counters.total).toBe(1200);
    expect(db.getFleet().summary.offline).toBe(1);
    db.close();
  });
});
