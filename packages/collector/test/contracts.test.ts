import { describe, expect, it } from "vitest";
import { calculateLevelPercent, compareFleetPriority, deriveStaleState, emptyOfflineObservation, normalizeHealth, type FleetPrinterState, type PrinterObservation } from "@printer-fleet/shared";
import { parseInventory } from "../src/inventory.js";
import { resolvePrinter } from "../src/dns.js";
import { detectVendor } from "../src/vendor.js";
import { normalizeRawSnmp, OIDS } from "../src/snmp.js";

const identity = { inventoryId: "site-a-abc", hostname: "printer-a.example.invalid", displayName: "Printer A" };
const base = (overrides: Partial<PrinterObservation> = {}): PrinterObservation => ({
  identity,
  reachability: { reachable: true, lastAttempt: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" },
  consumables: [], alerts: [], counters: {}, normalizedHealth: "unknown", collectedAt: "2026-01-01T00:00:00.000Z",
  provenance: { collector: "test", version: "0", adapter: "generic", protocol: "mock" },
  ...overrides
});

describe("inventory validation", () => {
  it("accepts hostnames and creates stable opaque inventory ids", () => {
    const yaml = `site:\n  id: site-a\n  name: Site A\nprinters:\n  - id: printer-a\n    hostname: printer-a.example.invalid\n    displayName: Printer A\n`;
    const first = parseInventory(yaml);
    const second = parseInventory(yaml);
    expect(first.printers[0]!.inventoryId).toBe("printer-a");
    expect(first.printers[0]!.inventoryId).toBe(second.printers[0]!.inventoryId);
    expect(first.printers[0]!.enabled).toBe(true);
  });

  it("rejects fixed IPv4 addresses and duplicate hostnames", () => {
    const fixedIp = `site: { id: site-a, name: Site A }\nprinters:\n  - { id: bad, hostname: 192.0.2.10, displayName: Bad }`;
    expect(() => parseInventory(fixedIp)).toThrow(/DNS hostname/);
    const duplicate = `site: { id: site-a, name: Site A }\nprinters:\n  - { id: a, hostname: Print-A.example.invalid, displayName: A }\n  - { id: b, hostname: print-a.example.invalid, displayName: B }`;
    expect(() => parseInventory(duplicate)).toThrow(/duplicate canonical hostname/);
  });

  it("rejects duplicate ids and accepts disabled printers with optional display names", () => {
    const duplicate = `site: { id: site-a, name: Site A }\nprinters:\n  - { id: same, hostname: a.example.invalid }\n  - { id: same, hostname: b.example.invalid, enabled: false }`;
    expect(() => parseInventory(duplicate)).toThrow(/duplicate printer id/);
    const valid = parseInventory(`site: { id: site-a, name: Site A }\nprinters:\n  - { id: a, hostname: A.example.invalid }\n  - { id: b, hostname: b.example.invalid, enabled: false }`);
    expect(valid.printers).toMatchObject([
      { inventoryId: "a", hostname: "a.example.invalid", displayName: "a.example.invalid", enabled: true },
      { inventoryId: "b", hostname: "b.example.invalid", enabled: false }
    ]);
    expect(parseInventory(`printers:\n  - { id: standalone, hostname: standalone.example.invalid }`).site).toEqual({ id: "default", name: "Default Site" });
  });
});

describe("DNS normalization", () => {
  it("returns an offline observation without throwing on DNS failure", async () => {
    const error = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const result = await resolvePrinter(identity, async () => { throw error; });
    expect("observation" in result && result.observation.normalizedHealth).toBe("offline");
    expect("observation" in result && result.observation.reachability.failureReason).toContain("ENOTFOUND");
    expect("observation" in result && result.observation.provenance.protocol).toBe("dns");
  });
});

describe("health normalization", () => {
  it.each([
    [base({ reachability: { reachable: false, lastAttempt: "2026-01-01T00:00:00.000Z" } }), "offline"],
    [base({ alerts: [{ severity: "critical", category: "printer", message: "Paper jam" }] }), "critical"],
    [base({ consumables: [{ type: "toner", description: "Black toner", levelPercent: 15 }] }), "warning"],
    [base({ consumables: [{ type: "toner", description: "Yellow toner", levelPercent: 1 }] }), "warning"],
    [base({ alerts: [{ severity: "info", category: "printer", message: "Sleep" }] }), "healthy"],
    [base({ consumables: [{ type: "toner", description: "Black toner", levelPercent: 75 }] }), "healthy"],
    [base(), "unknown"]
  ])("normalizes evidence to %s", (observation, expected) => expect(normalizeHealth(observation)).toBe(expected));
});

describe("consumable percentages", () => {
  it("calculates, rounds and bounds ordinary values", () => {
    expect(calculateLevelPercent(33, 100)).toBe(33);
    expect(calculateLevelPercent(2, 3)).toBe(67);
    expect(calculateLevelPercent(120, 100)).toBe(100);
  });
  it("does not invent percentages from missing, sentinel, or invalid values", () => {
    expect(calculateLevelPercent(undefined, 100)).toBeUndefined();
    expect(calculateLevelPercent(-3, 100)).toBeUndefined();
    expect(calculateLevelPercent(4, 0)).toBeUndefined();
  });
});

describe("vendor detection", () => {
  it.each([
    [{ sysObjectId: "1.3.6.1.4.1.367.3.2.1" }, "ricoh"],
    [{ sysObjectId: "1.3.6.1.4.1.1602.1.3" }, "canon"],
    [{ sysDescr: "KONICA MINOLTA bizhub" }, "konica-minolta"],
    [{ model: "KYOCERA ECOSYS M3645idn" }, "kyocera"],
    [{ sysDescr: "Standards Printer" }, "generic"]
  ] as const)("detects %s", (evidence, expected) => expect(detectVendor(evidence)).toBe(expected));
});

describe("partial SNMP normalization", () => {
  it("preserves useful values while leaving absent values undefined", () => {
    const raw = {
      scalars: { [OIDS.sysDescr]: Buffer.from("RICOH Example") },
      tables: {
        [OIDS.suppliesDescription]: { [`${OIDS.suppliesDescription}.1.1`]: Buffer.from("Black Toner") },
        [OIDS.suppliesMaxCapacity]: { [`${OIDS.suppliesMaxCapacity}.1.1`]: 100 },
        [OIDS.suppliesLevel]: {},
        [OIDS.hrDeviceDescr]: {},
        [OIDS.prtMarkerLifeCount]: {}
      }
    };
    const result = normalizeRawSnmp({ ...identity, resolvedIp: "192.0.2.20" }, raw, 12, "2026-01-01T00:00:00.000Z");
    expect(result.identity.manufacturer).toBe("Ricoh");
    expect(result.consumables[0]).toMatchObject({ colour: "black", levelPercent: undefined });
    expect(result.counters.total).toBeUndefined();
    expect(result.normalizedHealth).toBe("healthy");
  });
});

describe("offline observations", () => {
  it("contain no fabricated live values and retain the resolved address evidence", () => {
    const result = emptyOfflineObservation({ ...identity, resolvedIp: "192.0.2.21" }, "SNMP request timed out");
    expect(result).toMatchObject({
      identity: { resolvedIp: "192.0.2.21" },
      reachability: { reachable: false, failureReason: "SNMP request timed out" },
      normalizedHealth: "offline",
      consumables: [], alerts: [], counters: {}
    });
  });
});

describe("fleet freshness and ordering", () => {
  it("derives stale state independently from reachability and health", () => {
    expect(deriveStaleState("2026-01-01T00:08:01.000Z", 300, new Date("2026-01-01T00:10:00.000Z")).isStale).toBe(false);
    const stale = deriveStaleState("2026-01-01T00:00:00.000Z", 300, new Date("2026-01-01T00:10:01.000Z"));
    expect(stale).toMatchObject({ isStale: true, ageSeconds: 601, staleSince: "2026-01-01T00:10:00.000Z" });
  });

  it("orders offline, critical, warning, pending, healthy, then unknown explicitly", () => {
    const state = (name: string, health: FleetPrinterState["normalizedHealth"], reachable = true, operationalState: FleetPrinterState["operationalState"] = health): FleetPrinterState => ({
      ...base({ identity: { ...identity, displayName: name }, normalizedHealth: health, reachability: { reachable, lastAttempt: "2026-01-01T00:00:00.000Z" } }),
      site: { id: "site", name: "Site" }, enabled: true, configured: true, configuredAt: "2026-01-01T00:00:00.000Z", operationalState,
      isStale: false, staleSince: null, ageSeconds: 0, latestAttemptAt: "2026-01-01T00:00:00.000Z", lastSuccessfulCollectionAt: null, collectionDurationMs: null, lastKnownData: false
    });
    const pending = { ...state("Pending", "unknown", true, "pending"), reachability: null, collectedAt: null, provenance: null, ageSeconds: null, latestAttemptAt: null };
    const sorted = [state("Unknown", "unknown"), state("Healthy", "healthy"), pending, state("Warning", "warning"), state("Critical", "critical"), state("Offline", "offline", false)].sort(compareFleetPriority);
    expect(sorted.map((item) => item.operationalState)).toEqual(["offline", "critical", "warning", "pending", "healthy", "unknown"]);
  });
});
