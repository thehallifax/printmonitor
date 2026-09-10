export const prioritizedHealthStates = ["offline", "critical", "warning"];

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
  const sorted = [...printers].sort((a, b) => a.identity.displayName.localeCompare(b.identity.displayName));
  return {
    offline: sorted.filter((printer) => printer.normalizedHealth === "offline"),
    critical: sorted.filter((printer) => printer.normalizedHealth === "critical"),
    warning: sorted.filter((printer) => printer.normalizedHealth === "warning"),
    fleet: sorted.filter((printer) => !prioritizedHealthStates.includes(printer.normalizedHealth))
  };
}
