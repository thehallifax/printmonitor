import { afterEach, describe, expect, it } from "vitest";
import type { PrinterObservation } from "@printer-fleet/shared";
import { calculateConsumableLevelPercent } from "@printer-fleet/shared";
import { boundedInteger } from "../src/config.js";
import { sanitizeCapture } from "../src/fixture-sanitizer.js";
import { validateExplicitHostname } from "../src/inventory.js";
import { classifySnmpError, classifyWalkStatus, normalizeRawSnmp, OIDS, type RawSnmpData } from "../src/snmp.js";
import { applyVendorEnrichment, type VendorAdapter } from "../src/vendor.js";

const identity = { inventoryId: "fixture-printer", hostname: "printer.example.invalid", displayName: "Fixture Printer", resolvedIp: "192.0.2.10" };

function supplyRaw(input: { description: string; type: number; unit: number; maximum: number; level: number; supplyClass?: number }): RawSnmpData {
  const index = "1.1";
  return {
    scalars: { [OIDS.sysDescr]: "Standards Printer" },
    tables: {
      [OIDS.hrDeviceDescr]: {},
      [OIDS.prtMarkerLifeCount]: {},
      [OIDS.suppliesDescription]: { [`${OIDS.suppliesDescription}.${index}`]: input.description },
      [OIDS.suppliesClass]: { [`${OIDS.suppliesClass}.${index}`]: input.supplyClass ?? 3 },
      [OIDS.suppliesType]: { [`${OIDS.suppliesType}.${index}`]: input.type },
      [OIDS.suppliesUnit]: { [`${OIDS.suppliesUnit}.${index}`]: input.unit },
      [OIDS.suppliesMaxCapacity]: { [`${OIDS.suppliesMaxCapacity}.${index}`]: input.maximum },
      [OIDS.suppliesLevel]: { [`${OIDS.suppliesLevel}.${index}`]: input.level }
    }
  };
}

describe("Printer-MIB consumable semantics", () => {
  it.each([
    ["other maximum", -1, 40],
    ["unknown maximum", -2, 40],
    ["zero maximum", 0, 40],
    ["other level", 100, -1],
    ["unknown level", 100, -2],
    ["partial level", 100, -3]
  ])("does not invent a toner percentage for %s", (_name, maximum, level) => {
    const result = normalizeRawSnmp(identity, supplyRaw({ description: "Black toner", type: 3, unit: 13, maximum, level }), 5);
    expect(result.consumables[0]).toMatchObject({ type: "toner", rawMaximum: maximum, rawLevel: level, levelPercent: undefined });
  });

  it("uses an explicit percent unit even when maximum is unknown", () => {
    expect(calculateConsumableLevelPercent({ type: "toner", rawLevel: 74, rawMaximum: -2, rawUnit: 19 })).toBe(74);
  });

  it("normalizes waste receptacle remaining capacity", () => {
    const result = normalizeRawSnmp(identity, supplyRaw({ description: "Waste toner bottle", type: 4, unit: 19, maximum: 100, level: 18, supplyClass: 4 }), 5);
    expect(result.consumables[0]).toMatchObject({ type: "waste-toner", rawClass: 4, levelPercent: 18 });
  });

  it("normalizes a drum lifecycle from a valid common-unit ratio", () => {
    const result = normalizeRawSnmp(identity, supplyRaw({ description: "Black imaging unit", type: 9, unit: 7, maximum: 100_000, level: 55_000 }), 5);
    expect(result.consumables[0]).toMatchObject({ type: "drum", levelPercent: 55 });
  });

  it("retains staple counts without claiming a percentage", () => {
    const result = normalizeRawSnmp(identity, supplyRaw({ description: "Staple cartridge", type: 32, unit: 18, maximum: 5_000, level: 2_000 }), 5);
    expect(result.consumables[0]).toMatchObject({ type: "other", rawType: 32, rawUnit: 18, rawMaximum: 5_000, rawLevel: 2_000, levelPercent: undefined });
  });
});

describe("failure and partial-response evidence", () => {
  it.each([
    [Object.assign(new Error("Request timed out"), { name: "RequestTimedOutError" }), "timeout"],
    [new Error("Authorization error: noAccess"), "authentication"],
    [Object.assign(new Error("genErr"), { name: "RequestFailedError" }), "protocol"],
    [new Error("Malformed BER response"), "malformed-response"],
    [new Error("EHOSTUNREACH socket error"), "network"],
    [new Error("unclassified failure"), "unknown"]
  ] as const)("classifies %s", (error, expected) => expect(classifySnmpError(error)).toBe(expected));

  it("marks a successful but incomplete collection as partial", () => {
    const raw = supplyRaw({ description: "Black toner", type: 3, unit: 19, maximum: 100, level: 80 });
    raw.oidEvidence = [{ symbol: "prtAlertDescription", oid: OIDS.alertDescription, operation: "walk", status: "failed", valueCount: 0, issueKind: "protocol", message: "genErr" }];
    raw.issues = [{ kind: "protocol", message: "genErr", oid: OIDS.alertDescription }];
    const result = normalizeRawSnmp(identity, raw, 8);
    expect(result.reachability.reachable).toBe(true);
    expect(result.provenance.collectionStatus).toBe("partial");
    expect(result.provenance.issues?.[0]?.kind).toBe("protocol");
  });

  it.each(["empty", "unsupported"] as const)("does not make an optional %s table partial", (status) => {
    const raw = supplyRaw({ description: "Black toner", type: 3, unit: 19, maximum: 100, level: 80 });
    raw.oidEvidence = [{ symbol: "prtAlertDescription", oid: OIDS.alertDescription, operation: "walk", status, valueCount: 0 }];
    const result = normalizeRawSnmp(identity, raw, 8);
    expect(result.provenance.collectionStatus).toBe("complete");
    expect(result.provenance.issues).toEqual([]);
  });

  it("distinguishes populated, empty, unsupported, and malformed walk outcomes", () => {
    expect(classifyWalkStatus(1, false, false)).toBe("succeeded");
    expect(classifyWalkStatus(0, false, false)).toBe("empty");
    expect(classifyWalkStatus(0, true, false)).toBe("unsupported");
    expect(classifyWalkStatus(0, false, true)).toBe("failed");
  });
});

describe("adapter enrichment", () => {
  it("augments standard values without discarding generic evidence", () => {
    const standard = normalizeRawSnmp(identity, supplyRaw({ description: "Black toner", type: 3, unit: 19, maximum: 100, level: 80 }), 8);
    const adapter: VendorAdapter = { id: "ricoh", detect: () => undefined, enrich: () => ({}) };
    const enriched = applyVendorEnrichment(standard, adapter, {
      identity: { model: "Validated Model Family" },
      consumables: [{ type: "drum", description: "Vendor drum", levelPercent: 60 }],
      alerts: [{ severity: "warning", category: "vendor", message: "Validated warning" }],
      counters: { mono: 42 },
      rawEvidence: { source: "sanitized fixture" }
    });
    expect(enriched.identity.hostname).toBe(identity.hostname);
    expect(enriched.identity.model).toBe("Validated Model Family");
    expect(enriched.consumables).toHaveLength(2);
    expect(enriched.alerts).toHaveLength(1);
    expect(enriched.counters.mono).toBe(42);
    expect(enriched.provenance.rawEvidence).toHaveProperty("standard");
    expect(enriched.provenance.rawEvidence).toHaveProperty("vendor");
  });
});

describe("validation safety boundaries", () => {
  const original = process.env.TEST_BOUND;
  afterEach(() => { if (original === undefined) delete process.env.TEST_BOUND; else process.env.TEST_BOUND = original; });

  it.each(["192.0.2.10", "2001:db8::1", "192.0.2.0/24", "192.0.2.10-20", "*.example.invalid"])("rejects non-host target %s", (target) => {
    expect(() => validateExplicitHostname(target)).toThrow(/one explicit DNS hostname/);
  });

  it("enforces an upper configuration bound", () => {
    process.env.TEST_BOUND = "33";
    expect(() => boundedInteger("TEST_BOUND", 4, 1, 32)).toThrow(/1 to 32/);
  });
});

describe("fixture sanitization", () => {
  it("redacts identifying values while preserving OIDs and parser evidence", () => {
    const fixture = sanitizeCapture({
      target: { hostname: "printer-7.customer.example", resolvedIp: "10.20.30.40" },
      observation: {
        identity: { inventoryId: "customer-printer-7", hostname: "printer-7.customer.example", resolvedIp: "10.20.30.40", displayName: "Customer School Library", location: "Customer School", serialNumber: "ABC123456", model: "Validated 5000" },
        provenance: { rawEvidence: { standard: { scalars: { [OIDS.sysObjectId]: "1.3.6.1.4.1.367.3", [OIDS.prtGeneralSerialNumber]: "ABC123456", note: "MAC 0a:1b:2c:3d:4e:5f at Customer School" } } } }
      }
    }, ["Customer School"]);
    const json = JSON.stringify(fixture);
    expect(json).not.toContain("customer.example");
    expect(json).not.toContain("10.20.30.40");
    expect(json).not.toContain("ABC123456");
    expect(json).not.toContain("Customer School");
    expect(json).not.toContain("0a:1b:2c:3d:4e:5f");
    expect(json).toContain("1.3.6.1.4.1.367.3");
    expect(json).toContain("Validated 5000");
  });
});
