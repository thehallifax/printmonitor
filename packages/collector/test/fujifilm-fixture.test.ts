import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeRawSnmp, type RawSnmpData } from "../src/snmp.js";

const fixturePath = fileURLToPath(new URL("fixtures/fujifilm/apeos-c3567-standard-mib.json", import.meta.url));
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as { expectedCollectionStatus: string; raw: RawSnmpData };
const observation = normalizeRawSnmp({
  inventoryId: "fixture-printer",
  hostname: "printer.example.invalid",
  displayName: "Fixture Printer",
  resolvedIp: "192.0.2.10"
}, fixture.raw, 10, "2026-01-01T00:00:00.000Z");

const suppliesByDescription = new Map(observation.consumables.map((supply) => [supply.description, supply]));

describe("sanitized FUJIFILM Apeos C3567 live fixture", () => {
  it("normalizes manufacturer and model from generic standard identity evidence", () => {
    expect(observation.provenance.adapter).toBe("generic");
    expect(observation.identity.manufacturer).toBe("FUJIFILM");
    expect(observation.identity.model).toBe("Apeos C3567");
  });

  it("preserves observed toner percentages", () => {
    expect(Object.fromEntries(["Black Toner", "Yellow Toner", "Magenta Toner", "Cyan Toner"].map((name) => [name, suppliesByDescription.get(name)?.levelPercent]))).toEqual({
      "Black Toner": 86,
      "Yellow Toner": 84,
      "Magenta Toner": 87,
      "Cyan Toner": 80
    });
  });

  it("preserves observed drum percentages", () => {
    expect(Object.fromEntries(["Black Drum Cartridge", "Yellow Drum Cartridge", "Magenta Drum Cartridge", "Cyan Drum Cartridge"].map((name) => [name, suppliesByDescription.get(name)?.levelPercent]))).toEqual({
      "Black Drum Cartridge": 94,
      "Yellow Drum Cartridge": 95,
      "Magenta Drum Cartridge": 95,
      "Cyan Drum Cartridge": 95
    });
  });

  it("retains special raw values without fabricating percentages", () => {
    expect(suppliesByDescription.get("Waste Toner Container")).toMatchObject({ type: "waste-toner", rawLevel: -3, rawMaximum: 83000, levelPercent: undefined });
    expect(suppliesByDescription.get("Second Bias Transfer Roll")).toMatchObject({ type: "transfer", rawLevel: -3, rawMaximum: -2, levelPercent: undefined });
    expect(suppliesByDescription.get("Fusing Unit")).toMatchObject({ type: "fuser", rawLevel: -3, rawMaximum: -2, levelPercent: undefined });
    expect(suppliesByDescription.get("Transfer Belt Cleaner")).toMatchObject({ type: "transfer", rawLevel: -3, rawMaximum: -2, levelPercent: undefined });
  });

  it("preserves the standard alert and total counter", () => {
    expect(observation.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ message: "071-451 Tray 1 is out of paper. Load paper in Tray 1." })]));
    expect(observation.counters.total).toBe(7972);
  });

  it("retains complete per-OID collection evidence", () => {
    expect(observation.provenance.collectionStatus).toBe(fixture.expectedCollectionStatus);
    expect(observation.provenance.oidEvidence).toHaveLength(20);
    expect(observation.provenance.oidEvidence?.every((entry) => entry.status === "succeeded")).toBe(true);
  });

  it("contains no customer-specific identifier patterns", () => {
    const standaloneIpv4 = fixtureText.match(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g) ?? [];
    expect(standaloneIpv4).toEqual([]);
    expect(fixtureText).not.toMatch(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i);
    expect(fixtureText).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    expect(fixtureText).not.toMatch(/"(?:hostname|resolvedIp|ip|location|displayName|capturedAt|durationMs)"/);
    expect(fixtureText).toContain("EXAMPLE-SERIAL");
  });
});
