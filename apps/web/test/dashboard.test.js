import { describe, expect, it } from "vitest";
import { failureLabel, filterFleet, groupPrinters } from "../public/view-model.js";

const printer = (name, normalizedHealth, reachable = true, operationalState = reachable ? normalizedHealth : "offline") => ({ identity: { displayName: name, hostname: `${name}.example.invalid` }, site: { id: "site", name: "Site" }, normalizedHealth, operationalState, reachability: { reachable }, isStale: false });

describe("dashboard status sections", () => {
  it("keeps offline, critical, warning, and fleet devices separate", () => {
    const groups = groupPrinters([
      printer("Healthy", "healthy"), printer("Warning", "warning"), printer("Offline", "offline"),
      printer("Critical", "critical"), printer("Pending", "unknown", true, "pending"), printer("Unknown", "unknown"), printer("Disconnected", "unknown", false)
    ]);
    expect(groups.offline.map((item) => item.identity.displayName)).toEqual(["Offline", "Disconnected"]);
    expect(groups.critical.map((item) => item.identity.displayName)).toEqual(["Critical"]);
    expect(groups.warning.map((item) => item.identity.displayName)).toEqual(["Warning"]);
    expect(groups.pending.map((item) => item.identity.displayName)).toEqual(["Pending"]);
    expect(groups.healthy.map((item) => item.identity.displayName)).toEqual(["Healthy", "Unknown"]);
  });

  it("distinguishes DNS and SNMP timeout failures from critical health", () => {
    expect(failureLabel("dns")).toBe("DNS failure");
    expect(failureLabel("timeout")).toBe("SNMP timeout");
    expect(failureLabel(undefined)).toBe("SNMP unavailable");
  });

  it("filters by text, site, state, and stale status without reordering", () => {
    const first = { ...printer("Library", "warning"), identity: { displayName: "Library", hostname: "library.example.invalid", location: "North" }, site: { id: "campus", name: "Campus" }, isStale: true };
    const second = printer("Office", "healthy");
    expect(filterFleet([first, second], { search: "north", site: "campus", state: "stale" })).toEqual([first]);
  });
});
