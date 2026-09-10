import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeRawSnmp, type RawSnmpData } from "../src/snmp.js";

const fixturePath = fileURLToPath(new URL("fixtures/konica-minolta/bizhub-c3321i-standard-mib.json", import.meta.url));
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as { expectedCollectionStatus: string; raw: RawSnmpData };
const observation = normalizeRawSnmp({
  inventoryId: "fixture-printer",
  hostname: "printer.example.invalid",
  displayName: "Fixture Printer",
  resolvedIp: "192.0.2.10"
}, fixture.raw, 10, "2026-01-01T00:00:00.000Z");

const suppliesByDescription = new Map(observation.consumables.map((supply) => [supply.description, supply]));

describe("sanitized Konica Minolta bizhub C3321i live fixture", () => {
  it("retains enterprise-OID adapter detection and conservatively normalizes identity", () => {
    expect(observation.provenance.adapter).toBe("konica-minolta");
    expect(observation.identity.manufacturer).toBe("Konica Minolta");
    expect(observation.identity.model).toBe("bizhub C3321i");
    expect(observation.provenance.rawEvidence?.vendorDetection).toMatchObject({
      vendor: "konica-minolta",
      confidence: "enterprise-oid",
      signals: ["sysObjectID enterprise 18334"]
    });
  });

  it("preserves the four observed toner percentages", () => {
    expect(Object.fromEntries(["Toner (Cyan)", "Toner (Magenta)", "Toner (Yellow)", "Toner (Black)"].map((name) => [name, suppliesByDescription.get(name)?.levelPercent]))).toEqual({
      "Toner (Cyan)": 45,
      "Toner (Magenta)": 57,
      "Toner (Yellow)": 55,
      "Toner (Black)": 12
    });
  });

  it("preserves the four observed imaging-unit percentages", () => {
    expect(Object.fromEntries(["Imaging Unit (Cyan)", "Imaging Unit (Magenta)", "Imaging Unit (Yellow)", "Imaging Unit (Black)"].map((name) => [name, suppliesByDescription.get(name)?.levelPercent]))).toEqual({
      "Imaging Unit (Cyan)": 91,
      "Imaging Unit (Magenta)": 91,
      "Imaging Unit (Yellow)": 91,
      "Imaging Unit (Black)": 88
    });
    for (const name of ["Imaging Unit (Cyan)", "Imaging Unit (Magenta)", "Imaging Unit (Yellow)", "Imaging Unit (Black)"]) {
      expect(suppliesByDescription.get(name)?.type).toBe("drum");
    }
  });

  it("preserves waste, fuser, and transfer semantics", () => {
    expect(suppliesByDescription.get("Waste Toner Box")).toMatchObject({ type: "waste-toner", rawLevel: -3, rawMaximum: -2, levelPercent: undefined });
    expect(suppliesByDescription.get("Fusing Unit")).toMatchObject({ type: "fuser", levelPercent: 93 });
    expect(suppliesByDescription.get("Image Transfer Belt Unit")).toMatchObject({ type: "transfer", levelPercent: 83 });
    expect(suppliesByDescription.get("Transfer Roller Unit")).toMatchObject({ type: "transfer", levelPercent: 83 });
  });

  it("classifies Toner Filter as a neutral maintenance item while retaining its percentage", () => {
    expect(suppliesByDescription.get("Toner Filter")).toMatchObject({ type: "other", rawLevel: 81, rawMaximum: 100, levelPercent: 81 });
  });

  it("preserves alert, warning health, reachability, and the total counter", () => {
    expect(observation.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Toner Near Empty Black" })]));
    expect(observation.normalizedHealth).toBe("warning");
    expect(observation.reachability.reachable).toBe(true);
    expect(observation.counters).toEqual({ total: 28996 });
  });

  it("retains complete standard-OID collection evidence", () => {
    expect(observation.provenance.collectionStatus).toBe(fixture.expectedCollectionStatus);
    expect(observation.provenance.oidEvidence).toHaveLength(20);
    expect(observation.provenance.oidEvidence?.every((entry) => entry.status === "succeeded")).toBe(true);
  });

  it("contains no customer-specific identifier patterns", () => {
    const standaloneIpv4 = fixtureText.match(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g) ?? [];
    expect(standaloneIpv4).toEqual([]);
    expect(fixtureText).not.toMatch(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i);
    expect(fixtureText).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    expect(fixtureText).not.toMatch(/"(?:hostname|resolvedIp|ip|location|displayName|capturedAt|durationMs|community|credential)"/);
    expect(fixtureText).toContain("EXAMPLE-SERIAL");
  });
});
