import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetDatabase } from "@printer-fleet/storage";
import type { PrinterIdentity, PrinterObservation } from "@printer-fleet/shared";
import { CollectionAlreadyRunningError, collectFleet } from "../src/runner.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const makePrinter = (index: number, enabled = true) => ({
  inventoryId: `printer-${index}`, siteId: "site", hostname: `printer-${index}.example.invalid`, displayName: `Printer ${index}`, enabled
});

function observation(identity: PrinterIdentity, collectionStatus: "complete" | "partial" = "complete"): PrinterObservation {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    identity, reachability: { reachable: true, lastAttempt: at, lastSeen: at }, consumables: [], alerts: [], counters: {},
    normalizedHealth: "healthy", collectedAt: at,
    provenance: { collector: "fixture", version: "0", adapter: "generic", protocol: "mock", collectionStatus, issues: collectionStatus === "partial" ? [{ kind: "protocol", message: "optional read failed" }] : [] }
  };
}

describe("fleet collection orchestration", () => {
  it("bounds concurrency, skips disabled devices, isolates failures, and records run counts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-runner-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const printers = [makePrinter(1), makePrinter(2), makePrinter(3), makePrinter(4), makePrinter(5, false)];
    db.syncInventory({ id: "site", name: "Fixture Site" }, printers);
    let active = 0;
    let maximumActive = 0;
    const collected: string[] = [];
    const lifecycle: string[] = [];
    const result = await collectFleet(db, printers, { community: "fixture-secret", timeoutMs: 100, retries: 0, concurrency: 2 }, {
      resolve: async (hostname) => ({ address: hostname.endsWith("1.example.invalid") ? "192.0.2.1" : "192.0.2.2", family: 4 }),
      collect: async (identity) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        collected.push(identity.inventoryId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (identity.inventoryId === "printer-2") throw new Error("Request timed out for fixture-secret");
        return observation(identity, identity.inventoryId === "printer-3" ? "partial" : "complete");
      },
      onRunStarted: (runId) => lifecycle.push(`started:${runId}`),
      onRunFinished: (runId) => lifecycle.push(`finished:${runId}`)
    });
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(collected).not.toContain("printer-5");
    expect(result).toMatchObject({ configured: 5, attempted: 4, succeeded: 3, reachable: 3, unreachable: 1, partial: 1, failed: 1 });
    expect(db.getPrinter("printer-1")?.reachability.reachable).toBe(true);
    expect(db.getPrinter("printer-2")?.reachability).toMatchObject({ reachable: false, failureKind: "timeout" });
    expect(db.getRuns(1)[0]).toMatchObject({ configured: 5, attempted: 4, reachable: 3, unreachable: 1, partial: 1, failed: 1, status: "completed" });
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[1]).toBe(lifecycle[0]?.replace("started:", "finished:"));
    db.close();
  });

  it("prevents overlapping runs for the same collector process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-overlap-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const printers = [makePrinter(1)];
    db.syncInventory({ id: "site", name: "Fixture Site" }, printers);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = collectFleet(db, printers, { community: "fixture", timeoutMs: 100, retries: 0, concurrency: 1 }, {
      resolve: async () => ({ address: "192.0.2.1", family: 4 }),
      collect: async (identity) => { await gate; return observation(identity); }
    });
    await expect(collectFleet(db, printers, { community: "fixture", timeoutMs: 100, retries: 0, concurrency: 1 })).rejects.toBeInstanceOf(CollectionAlreadyRunningError);
    release();
    await first;
    db.close();
  });

  it("polls IP targets directly without invoking DNS", async () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-ip-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const printers = [{ ...makePrinter(9), hostname: undefined, ip: "192.0.2.9", targetType: "ip" as const, targetValue: "192.0.2.9" }];
    db.syncInventory({ id: "site", name: "Fixture Site" }, printers);
    let resolved = false;
    await collectFleet(db, printers, { community: "fixture", timeoutMs: 100, retries: 0, concurrency: 1 }, {
      resolve: async () => { resolved = true; return { address: "192.0.2.99", family: 4 }; },
      collect: async (identity) => observation(identity)
    });
    expect(resolved).toBe(false);
    expect(db.getPrinter("printer-9")?.identity.ip).toBe("192.0.2.9");
    db.close();
  });

  it("keeps stable history when an inventory target changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-target-change-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const hostnamePrinter = makePrinter(10);
    db.syncInventory({ id: "site", name: "Fixture Site" }, [hostnamePrinter]);
    await collectFleet(db, [hostnamePrinter], { community: "fixture", timeoutMs: 100, retries: 0, concurrency: 1 }, { collect: async (identity) => observation(identity) });
    const ipPrinter = { ...hostnamePrinter, hostname: undefined, ip: "192.0.2.10", targetType: "ip" as const, targetValue: "192.0.2.10" };
    db.syncInventory({ id: "site", name: "Fixture Site" }, [ipPrinter]);
    expect(db.getHistory("printer-10")).toHaveLength(1);
    expect(db.getPrinterState("printer-10")?.identity.inventoryId).toBe("printer-10");
    db.close();
  });
});
