import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeRawSnmp, type RawSnmpData } from "../src/snmp.js";

interface Fixture {
  deviceFamily: string;
  expectedCollectionStatus: string;
  raw: RawSnmpData;
}

const fixtureNames = [
  "bizhub-c301i-sleep-finisher.json",
  "bizhub-c451i-empty-alerts.json",
  "bizhub-c251i-low-toner.json",
  "bizhub-c3321i-standard-mib.json"
] as const;

const fixtureEntries = fixtureNames.map((name) => {
  const path = fileURLToPath(new URL(`fixtures/konica-minolta/${name}`, import.meta.url));
  const text = readFileSync(path, "utf8");
  return { name, text, fixture: JSON.parse(text) as Fixture };
});

const observations = Object.fromEntries(fixtureEntries.map(({ name, fixture }) => [name, normalizeRawSnmp({
  inventoryId: "fixture-printer",
  hostname: "printer.example.invalid",
  displayName: "Fixture Printer",
  resolvedIp: "192.0.2.10"
}, fixture.raw, 10, "2026-01-01T00:00:00.000Z")])) as Record<(typeof fixtureNames)[number], ReturnType<typeof normalizeRawSnmp>>;

describe("Konica Minolta i-Series fixture family", () => {
  it.each([
    ["bizhub-c301i-sleep-finisher.json", "bizhub C301i"],
    ["bizhub-c451i-empty-alerts.json", "bizhub C451i"],
    ["bizhub-c251i-low-toner.json", "bizhub C251i"],
    ["bizhub-c3321i-standard-mib.json", "bizhub C3321i"]
  ] as const)("normalizes %s without duplicating its manufacturer", (fixtureName, model) => {
    const observation = observations[fixtureName];
    expect(observation.provenance.adapter).toBe("konica-minolta");
    expect(observation.identity.manufacturer).toBe("Konica Minolta");
    expect(observation.identity.model).toBe(model);
    expect(observation.identity.model).not.toMatch(/^Konica Minolta/i);
    expect(observation.provenance.rawEvidence?.vendorDetection).toMatchObject({ vendor: "konica-minolta", confidence: "enterprise-oid" });
  });

  it("keeps a reachable sleeping C301i healthy and retains its informational alert", () => {
    const observation = observations["bizhub-c301i-sleep-finisher.json"];
    expect(observation.reachability.reachable).toBe(true);
    expect(observation.normalizedHealth).toBe("healthy");
    expect(observation.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "info", message: "Sleep" })]));
    expect(observation.consumables).toHaveLength(19);
  });

  it("preserves developer, drum, maintenance, and finisher classifications", () => {
    const supplies = new Map(observations["bizhub-c301i-sleep-finisher.json"].consumables.map((supply) => [supply.description, supply]));
    expect(supplies.get("Developer Cartridge (Cyan)")).toMatchObject({ type: "other", levelPercent: 99 });
    expect(supplies.get("Drum Cartridge (Cyan)")).toMatchObject({ type: "drum", levelPercent: 80 });
    expect(supplies.get("Fusing Unit")).toMatchObject({ type: "fuser", levelPercent: 93 });
    expect(supplies.get("Image Transfer Belt Unit")).toMatchObject({ type: "transfer", levelPercent: 82 });
    expect(supplies.get("Transfer Roller Unit")).toMatchObject({ type: "transfer", levelPercent: 82 });
    expect(supplies.get("Waste Toner Box")).toMatchObject({ type: "waste-toner", rawLevel: -3, rawMaximum: -2, levelPercent: undefined });
    for (const name of ["Staple Cartridge", "Saddle Staple Cartridge1", "Saddle Staple Cartridge2"]) {
      expect(supplies.get(name)).toMatchObject({ type: "other", rawLevel: -3, rawMaximum: -2, levelPercent: undefined });
    }
  });

  it("treats successfully completed zero-value alert walks as empty and collection as complete", () => {
    const observation = observations["bizhub-c451i-empty-alerts.json"];
    const alertEvidence = observation.provenance.oidEvidence?.filter((entry) => entry.symbol.startsWith("prtAlert"));
    expect(observation.consumables).toHaveLength(20);
    expect(observation.alerts).toEqual([]);
    expect(alertEvidence).toHaveLength(3);
    expect(alertEvidence?.every((entry) => entry.status === "empty" && entry.valueCount === 0)).toBe(true);
    expect(observation.provenance.collectionStatus).toBe("complete");
    expect(observation.provenance.issues).toEqual([]);
    expect(observation.normalizedHealth).toBe("healthy");
  });

  it("treats very low toner as consumable attention rather than an operational failure", () => {
    const observation = observations["bizhub-c251i-low-toner.json"];
    const supplies = new Map(observation.consumables.map((supply) => [supply.description, supply]));
    expect(supplies.get("Toner (Cyan)")?.levelPercent).toBe(12);
    expect(supplies.get("Toner (Yellow)")?.levelPercent).toBe(1);
    expect(observation.alerts.map((alert) => alert.message)).toEqual(expect.arrayContaining(["No Paper Tray4", "Toner Near Empty Cyan", "Toner Near Empty Yellow"]));
    expect(observation.alerts.every((alert) => alert.severity === "info")).toBe(true);
    expect(observation.reachability.reachable).toBe(true);
    expect(observation.normalizedHealth).toBe("warning");
    expect(observation.counters).toEqual({ total: 53377 });
    expect(observation.provenance.collectionStatus).toBe("complete");
  });

  it.each(fixtureEntries.map(({ name, text }) => [name, text] as const))("contains no customer identifiers in %s", (_name, text) => {
    const standaloneIpv4 = text.match(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g) ?? [];
    expect(standaloneIpv4).toEqual([]);
    expect(text).not.toMatch(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i);
    expect(text).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    expect(text).not.toMatch(/"(?:hostname|resolvedIp|ip|location|displayName|capturedAt|durationMs|community|credential)"/);
    expect(text).toContain("EXAMPLE-SERIAL");
  });
});
