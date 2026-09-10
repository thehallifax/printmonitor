export const prioritizedHealthStates = ["offline", "critical", "warning", "pending", "healthy"];

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

export function groupPrinters(printers) {
  return {
    offline: printers.filter((printer) => printer.operationalState === "offline"),
    critical: printers.filter((printer) => printer.reachability?.reachable && printer.normalizedHealth === "critical"),
    warning: printers.filter((printer) => printer.reachability?.reachable && printer.normalizedHealth === "warning"),
    pending: printers.filter((printer) => printer.operationalState === "pending"),
    healthy: printers.filter((printer) => printer.operationalState !== "pending" && printer.reachability?.reachable && ["healthy", "unknown"].includes(printer.normalizedHealth))
  };
}

export function filterFleet(printers, filters) {
  const search = filters.search.trim().toLowerCase();
  return printers.filter((printer) => {
    const searchable = [printer.identity.displayName, printer.identity.hostname, printer.identity.manufacturer, printer.identity.model, printer.site?.name, printer.identity.location].filter(Boolean).join(" ").toLowerCase();
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
