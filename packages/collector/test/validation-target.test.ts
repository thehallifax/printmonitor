import { describe, expect, it } from "vitest";
import { parseInventory } from "../src/inventory.js";
import { parseValidationArguments, resolveValidationTarget } from "../src/validation-target.js";

describe("single-target live validation arguments", () => {
  it("accepts one explicit IPv4 target", () => {
    expect(parseValidationArguments(["--ip", "172.18.0.19"])).toEqual({
      target: { mode: "explicit-ip", ip: "172.18.0.19" },
      capture: false
    });
  });

  it("keeps hostname validation available", () => {
    expect(parseValidationArguments(["--hostname", "printer.example.invalid", "--capture"])).toEqual({
      target: { mode: "hostname", hostname: "printer.example.invalid" },
      capture: true
    });
  });

  it("skips DNS for explicit IPv4 but resolves hostname mode", async () => {
    const calls: string[] = [];
    const resolver = async (hostname: string) => { calls.push(hostname); return { address: "192.0.2.20", family: 4 }; };
    await expect(resolveValidationTarget({ mode: "explicit-ip", ip: "172.18.0.19" }, resolver)).resolves.toEqual({ address: "172.18.0.19", family: 4, dns: "skipped" });
    expect(calls).toEqual([]);
    await expect(resolveValidationTarget({ mode: "hostname", hostname: "printer.example.invalid" }, resolver)).resolves.toEqual({ address: "192.0.2.20", family: 4, dns: "resolved" });
    expect(calls).toEqual(["printer.example.invalid"]);
  });

  it("rejects hostname and IP together", () => {
    expect(() => parseValidationArguments(["--hostname", "printer.example.invalid", "--ip", "172.18.0.19"])).toThrow(/Exactly one/);
  });

  it("rejects a missing target", () => {
    expect(() => parseValidationArguments([])).toThrow(/Exactly one/);
    expect(() => parseValidationArguments(["--capture"])).toThrow(/Exactly one/);
  });

  it.each([
    ["CIDR", "172.18.0.0/24"],
    ["range", "172.18.0.10-20"],
    ["wildcard", "172.18.0.*"],
    ["IPv6", "2001:db8::19"]
  ])("rejects %s IP input", (_description, target) => {
    expect(() => parseValidationArguments(["--ip", target])).toThrow(/one explicit IPv4/);
  });

  it("rejects extra positional targets", () => {
    expect(() => parseValidationArguments(["--ip", "172.18.0.19", "172.18.0.20"])).toThrow(/Unexpected positional/);
  });

  it("does not weaken hostname-only production inventory", () => {
    const source = `site:\n  id: fixture-site\n  name: Fixture Site\nprinters:\n  - hostname: 172.18.0.19\n    displayName: Invalid IP Inventory\n`;
    expect(() => parseInventory(source)).toThrow(/DNS hostname/);
  });
});
