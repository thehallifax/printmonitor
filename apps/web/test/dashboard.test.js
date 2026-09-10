import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applySummaryFilter, compactAlerts, consumableAttention, displayLocation, failureLabel, filterFleet, maintenanceSummary, summarizeFleet, toggleSummaryFilter, tonerChannels } from "../public/view-model.js";

const printer = (name, normalizedHealth, reachable = true, operationalState = reachable ? normalizedHealth : "offline") => ({ identity: { displayName: name, hostname: `${name}.example.invalid` }, site: { id: "site", name: "Site" }, normalizedHealth, operationalState, reachability: { reachable }, consumables: [], isStale: false });

describe("dashboard state contracts", () => {
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

  it("keeps pending distinct and stale independent from health", () => {
    const pending = { ...printer("Pending", "unknown", true, "pending"), reachability: null, isStale: false };
    const staleHealthy = { ...printer("Stale healthy", "healthy"), isStale: true };
    expect(applySummaryFilter([pending, staleHealthy], "pending")).toEqual([pending]);
    expect(applySummaryFilter([pending, staleHealthy], "offline")).toEqual([]);
    expect(applySummaryFilter([pending, staleHealthy], "stale")).toEqual([staleHealthy]);
  });
});

describe("toner presentation model", () => {
  it("returns legitimate colour toner in canonical K/C/M/Y order with identity colours", () => {
    const channels = tonerChannels([
      { type: "toner", colour: "yellow", description: "Yellow", levelPercent: 68 },
      { type: "toner", colour: "magenta", description: "Magenta", levelPercent: 43 },
      { type: "toner", colour: "black", description: "Black", levelPercent: 13 },
      { type: "toner", colour: "cyan", description: "Cyan", levelPercent: 72 }
    ]);
    expect(channels.map((item) => [item.shortLabel, item.levelPercent, item.colour])).toEqual([
      ["K", 13, "#242b2d"], ["C", 72, "#008ba8"], ["M", 43, "#b62067"], ["Y", 68, "#d6a900"]
    ]);
    expect(channels.slice(1).map((item) => item.attention)).toEqual(["normal", "normal", "normal"]);
  });

  it("renders monochrome K only and never fabricates missing channels", () => {
    expect(tonerChannels([{ type: "toner", colour: "black", description: "Black", levelPercent: 81 }]).map((item) => item.shortLabel)).toEqual(["K"]);
  });

  it("isolates low, critical, and unknown presentation without converting unknown to zero", () => {
    expect([consumableAttention(21), consumableAttention(20), consumableAttention(5), consumableAttention(undefined)]).toEqual(["normal", "low", "critical", "unknown"]);
    const [unknown] = tonerChannels([{ type: "toner", colour: "black", description: "Black", rawLevel: -3, rawMaximum: -2 }]);
    expect(unknown).toMatchObject({ levelPercent: null, displayValue: "—", attention: "unknown" });
  });

  it("keeps maintenance and containers out of toner channels", () => {
    const supplies = [
      { type: "drum", colour: "black", description: "Imaging unit", levelPercent: 90 },
      { type: "waste-toner", description: "Waste toner", rawLevel: -3, rawMaximum: -2 },
      { type: "toner", colour: "cyan", description: "Cyan", levelPercent: 10 }
    ];
    expect(tonerChannels(supplies).map((item) => item.shortLabel)).toEqual(["C"]);
    expect(maintenanceSummary(supplies)).toEqual({ count: 2, attentionCount: 0 });
  });
});

describe("fleet-card interaction contracts", () => {
  it("bounds visible alerts and reports the remainder", () => {
    expect(compactAlerts([{ message: "A" }, { message: "B" }, { message: "C" }, { message: "D" }])).toEqual({ visible: [{ message: "A" }], additional: 3 });
  });

  it("routes keyboard-accessible fleet cards to the shared detail function", () => {
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(source).toContain('card.addEventListener("click", open)');
    expect(source).toContain('event.key === "Enter" || event.key === " "');
    expect(source).toContain('tonerVisual(printer.consumables, { compact: true })');
  });
});

describe("single-site presentation", () => {
  it("does not render a Site selector, repeated card site labels, or a decorative menu", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(html).not.toContain('id="site-filter"');
    expect(html).not.toContain('class="brand-mark"');
    expect(source).not.toContain("printer.site?.name");
  });

  it("retains site-aware filtering in the view-model contract", () => {
    const sitePrinter = printer("Library", "healthy");
    expect(filterFleet([sitePrinter], { search: "", site: "site", state: "" })).toEqual([sitePrinter]);
  });
});

describe("consolidated fleet dashboard", () => {
  it("renders one fleet view without a presentation switch or preference code", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const model = readFileSync(new URL("../public/view-model.js", import.meta.url), "utf8");
    expect(html).toContain('id="fleet-view"');
    expect(html).not.toContain("Operational");
    expect(html).not.toContain("data-view");
    expect(source).not.toContain("setViewMode");
    expect(source).not.toContain("localStorage");
    expect(model).not.toContain("VIEW_STORAGE_KEY");
  });

  it("keeps canonical API order in the sole grid", () => {
    const ordered = [printer("Offline", "offline", false), printer("Critical", "critical"), printer("Warning", "warning"), printer("Pending", "unknown", true, "pending"), printer("Healthy", "healthy")];
    expect(applySummaryFilter(ordered, null).map((item) => item.identity.displayName)).toEqual(["Offline", "Critical", "Warning", "Pending", "Healthy"]);
  });

  it("omits missing location without inventing a placeholder and preserves configured location", () => {
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(displayLocation(undefined)).toBeNull();
    expect(displayLocation(null)).toBeNull();
    expect(displayLocation("   ")).toBeNull();
    expect(displayLocation("  Library, Level 1  ")).toBe("Library, Level 1");
    expect(source).toContain("if (configuredLocation) location.textContent = configuredLocation");
    expect(source).toContain("else location.remove()");
    expect(source).not.toMatch(/Unassigned(?: location)?/);
  });

  it("retains complete supplies and evidence in the shared Detail", () => {
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(source).toContain('"Complete supply evidence"');
    expect(source).toContain('"Current state"');
    expect(source).toContain('"Recent history"');
  });
});

describe("summary tile filtering", () => {
  const fleet = [
    { ...printer("Offline", "offline", false), consumables: [{ type: "toner", colour: "black", levelPercent: 50 }] },
    { ...printer("Critical", "critical"), consumables: [] },
    { ...printer("Warning", "warning"), consumables: [{ type: "toner", colour: "cyan", levelPercent: 10 }] },
    { ...printer("Pending", "unknown", true, "pending"), reachability: null },
    { ...printer("Healthy", "healthy"), isStale: true }
  ];

  it.each([
    ["reachable", ["Critical", "Warning", "Healthy"]],
    ["offline", ["Offline"]],
    ["critical", ["Critical"]],
    ["warning", ["Warning"]],
    ["pending", ["Pending"]],
    ["healthy", ["Healthy"]],
    ["low-supplies", ["Warning"]],
    ["stale", ["Healthy"]]
  ])("applies %s without changing fleet objects", (filter, expected) => {
    expect(applySummaryFilter(fleet, filter).map((item) => item.identity.displayName)).toEqual(expected);
    expect(fleet).toHaveLength(5);
  });

  it("toggles an active tile and lets Printers clear summary filtering", () => {
    expect(toggleSummaryFilter(null, "warning")).toBe("warning");
    expect(toggleSummaryFilter("warning", "warning")).toBeNull();
    expect(toggleSummaryFilter("warning", "all")).toBeNull();
  });

  it("keeps overview counts based on search context, not the active tile", () => {
    const context = filterFleet(fleet, { search: "", site: "", state: "" });
    expect(summarizeFleet(context)).toMatchObject({ total: 5, reachable: 3, offline: 1, critical: 1, warning: 1, pending: 1, healthy: 1, lowConsumables: 1, stale: 1 });
    expect(applySummaryFilter(context, "warning")).toHaveLength(1);
    expect(summarizeFleet(context).total).toBe(5);
  });

  it("combines search with summary filtering while stale and low supplies stay independent from health", () => {
    const searched = filterFleet(fleet, { search: "healthy", site: "", state: "" });
    expect(applySummaryFilter(searched, "stale").map((item) => item.normalizedHealth)).toEqual(["healthy"]);
    expect(applySummaryFilter(fleet, "low-supplies").map((item) => item.normalizedHealth)).toEqual(["warning"]);
  });

  it("uses accessible pressed buttons and resets filters without changing presentation", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(html.match(/data-summary=/g)).toHaveLength(9);
    expect(html.match(/aria-pressed="false"/g).length).toBeGreaterThanOrEqual(9);
    expect(source).toContain('summaryFilter = null; renderFleet(); });');
    expect(source).not.toContain('summaryFilter = null; setViewMode');
  });
});
