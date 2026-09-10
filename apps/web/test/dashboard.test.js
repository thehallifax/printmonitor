import { describe, expect, it } from "vitest";
import { failureLabel, groupPrinters } from "../public/view-model.js";

const printer = (name, normalizedHealth) => ({ identity: { displayName: name }, normalizedHealth });

describe("dashboard status sections", () => {
  it("keeps offline, critical, warning, and fleet devices separate", () => {
    const groups = groupPrinters([
      printer("Healthy", "healthy"), printer("Warning", "warning"), printer("Offline", "offline"),
      printer("Critical", "critical"), printer("Unknown", "unknown")
    ]);
    expect(groups.offline.map((item) => item.identity.displayName)).toEqual(["Offline"]);
    expect(groups.critical.map((item) => item.identity.displayName)).toEqual(["Critical"]);
    expect(groups.warning.map((item) => item.identity.displayName)).toEqual(["Warning"]);
    expect(groups.fleet.map((item) => item.identity.displayName)).toEqual(["Healthy", "Unknown"]);
  });

  it("distinguishes DNS and SNMP timeout failures from critical health", () => {
    expect(failureLabel("dns")).toBe("DNS failure");
    expect(failureLabel("timeout")).toBe("SNMP timeout");
    expect(failureLabel(undefined)).toBe("SNMP unavailable");
  });
});
