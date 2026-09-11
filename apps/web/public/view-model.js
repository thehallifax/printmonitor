export const SUMMARY_FILTERS = ["reachable", "offline", "critical", "warning", "pending", "healthy", "low-supplies", "stale"];
export const INITIAL_HISTORY_ROWS = 12;
export const TONER_CHANNELS = [
  { key: "black", shortLabel: "K", label: "Black", colour: "#242b2d" },
  { key: "cyan", shortLabel: "C", label: "Cyan", colour: "#008ba8" },
  { key: "magenta", shortLabel: "M", label: "Magenta", colour: "#b62067" },
  { key: "yellow", shortLabel: "Y", label: "Yellow", colour: "#d6a900" }
];

// Presentation-only attention levels. The 20% low threshold matches normalized
// health policy; 5% is the dashboard's existing stronger near-empty treatment.
export function consumableAttention(levelPercent) {
  if (levelPercent == null || !Number.isFinite(levelPercent)) return "unknown";
  if (levelPercent <= 5) return "critical";
  if (levelPercent <= 20) return "low";
  return "normal";
}

export function tonerChannels(consumables) {
  return TONER_CHANNELS.flatMap((channel) => {
    const supply = consumables.find((item) => ["toner", "ink"].includes(item.type) && item.colour?.toLowerCase() === channel.key);
    if (!supply) return [];
    const levelPercent = Number.isFinite(supply.levelPercent) ? supply.levelPercent : null;
    return [{ ...channel, supply, levelPercent, displayValue: levelPercent == null ? "—" : `${levelPercent}%`, attention: consumableAttention(levelPercent) }];
  });
}

export function maintenanceSummary(consumables) {
  const items = consumables.filter((item) => !["toner", "ink"].includes(item.type));
  return { count: items.length, attentionCount: items.filter((item) => consumableAttention(item.levelPercent) === "low" || consumableAttention(item.levelPercent) === "critical").length };
}

export function displayLocation(value) {
  const location = typeof value === "string" ? value.trim() : "";
  return location || null;
}

export function compactAlerts(alerts, maximum = 2) {
  const visibleLimit = alerts.length > maximum ? Math.max(0, maximum - 1) : maximum;
  const visible = alerts.slice(0, visibleLimit);
  return { visible, additional: Math.max(0, alerts.length - visible.length) };
}

export function historyPresentation(history, expanded = false, initialLimit = INITIAL_HISTORY_ROWS) {
  const visible = expanded ? history : history.slice(0, initialLimit);
  return { visible, remaining: Math.max(0, history.length - visible.length) };
}

export function toggleSummaryFilter(active, requested) {
  if (!SUMMARY_FILTERS.includes(requested) || active === requested) return null;
  return requested;
}

export function applySummaryFilter(printers, filter) {
  if (!filter) return printers;
  return printers.filter((printer) => {
    if (filter === "reachable") return printer.reachability?.reachable === true;
    if (filter === "low-supplies") return printer.consumables.some((item) => item.levelPercent != null && item.levelPercent <= 20);
    if (filter === "stale") return printer.isStale;
    return printer.operationalState === filter;
  });
}

export function summarizeFleet(printers) {
  const count = (predicate) => printers.filter(predicate).length;
  return {
    total: printers.length,
    reachable: count((printer) => printer.reachability?.reachable === true),
    offline: count((printer) => printer.operationalState === "offline"),
    critical: count((printer) => printer.operationalState === "critical"),
    warning: count((printer) => printer.operationalState === "warning"),
    pending: count((printer) => printer.operationalState === "pending"),
    healthy: count((printer) => printer.operationalState === "healthy"),
    lowConsumables: count((printer) => printer.consumables.some((item) => item.levelPercent != null && item.levelPercent <= 20)),
    stale: count((printer) => printer.isStale)
  };
}

export function failureLabel(kind) {
  return ({
    dns: "DNS failure",
    timeout: "SNMP timeout",
    authentication: "SNMP authentication",
    protocol: "SNMP protocol",
    "malformed-response": "Malformed response",
    network: "Network unreachable",
    unknown: "SNMP unavailable"
  })[kind] || "SNMP unavailable";
}

export function filterFleet(printers, filters) {
  const search = filters.search.trim().toLowerCase();
  return printers.filter((printer) => {
    const searchable = [printer.identity.displayName, printer.identity.hostname, printer.identity.ip, printer.identity.manufacturer, printer.identity.model, printer.site?.name, printer.identity.location].filter(Boolean).join(" ").toLowerCase();
    if (search && !searchable.includes(search)) return false;
    if (filters.site && printer.site?.id !== filters.site) return false;
    if (filters.state === "stale" && !printer.isStale) return false;
    if (filters.state === "reachable" && !printer.reachability?.reachable) return false;
    if (filters.state === "offline" && printer.operationalState !== "offline") return false;
    if (filters.state === "pending" && printer.operationalState !== "pending") return false;
    if (["critical", "warning", "healthy", "unknown"].includes(filters.state) && printer.normalizedHealth !== filters.state) return false;
    return true;
  });
}
