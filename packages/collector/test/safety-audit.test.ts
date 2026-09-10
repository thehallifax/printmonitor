import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetDatabase } from "@printer-fleet/storage";
import type { PrinterObservation } from "@printer-fleet/shared";
import { collectFleet } from "../src/runner.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("collector safety invariants", () => {
  it("exposes only GET and subtree session operations", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/snmp.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/session\s*\.\s*set\s*\(/);
    expect([...source.matchAll(/session\s*\.\s*(get|subtree|set|walk|getBulk|getNext)\s*\(/g)].map((match) => match[1]).sort()).toEqual(["get", "subtree"]);
  });

  it("resolves every hostname and isolates one printer failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "printer-fleet-safety-")); directories.push(directory);
    const db = new FleetDatabase(join(directory, "fleet.sqlite"));
    const printers = ["a", "b"].map((name) => ({
      inventoryId: `site-${name}`, siteId: "site", hostname: `printer-${name}.example.invalid`, displayName: `Printer ${name.toUpperCase()}`, enabled: true
    }));
    db.syncInventory({ id: "site", name: "Fixture Site" }, printers);
    const resolved: string[] = [];
    const result = await collectFleet(db, printers, { community: "fixture-secret", timeoutMs: 100, retries: 0, concurrency: 2 }, {
      resolve: async (hostname) => { resolved.push(hostname); return { address: hostname.includes("-a.") ? "192.0.2.10" : "192.0.2.11", family: 4 }; },
      collect: async (identity): Promise<PrinterObservation> => {
        if (identity.hostname.includes("-a.")) throw new Error("Request timed out for fixture-secret");
        const at = "2026-01-01T00:00:00.000Z";
        return {
          identity, reachability: { reachable: true, lastAttempt: at, lastSeen: at }, consumables: [], alerts: [], counters: {},
          normalizedHealth: "unknown", collectedAt: at,
          provenance: { collector: "fixture", version: "0", adapter: "generic", protocol: "mock" }
        };
      }
    });
    expect(resolved.sort()).toEqual(printers.map((printer) => printer.hostname).sort());
    expect(result).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
    expect(db.getPrinter("site-a")?.reachability).toMatchObject({ reachable: false, failureKind: "timeout" });
    expect(db.getPrinter("site-a")?.reachability.failureReason).not.toContain("fixture-secret");
    expect(db.getPrinter("site-b")?.reachability.reachable).toBe(true);
    db.close();
  });
});
