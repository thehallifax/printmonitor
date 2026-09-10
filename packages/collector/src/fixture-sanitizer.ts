const keyReplacements: Record<string, string> = {
  hostname: "printer.example.invalid",
  ip: "192.0.2.10",
  resolvedip: "192.0.2.10",
  serialnumber: "EXAMPLE-SERIAL",
  inventoryid: "fixture-printer",
  displayname: "Fixture Printer",
  location: "Fixture Location",
  community: "[REDACTED]",
  credential: "[REDACTED]",
  password: "[REDACTED]"
};

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function sanitizeString(value: string, sensitiveValues: string[]): string {
  let result = value;
  sensitiveValues.filter((item) => item.length >= 3).sort((a, b) => b.length - a.length).forEach((item) => {
    result = result.replace(new RegExp(escapeRegExp(item), "gi"), "[REDACTED]");
  });
  return result
    .replace(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g, "192.0.2.10")
    .replace(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi, "02:00:00:00:00:01")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "user@example.invalid")
    .replace(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}\b/gi, "printer.example.invalid");
}

export function collectSensitiveValues(capture: Record<string, unknown>, manual: string[]): string[] {
  const target = capture.target && typeof capture.target === "object" ? capture.target as Record<string, unknown> : {};
  const observation = capture.observation && typeof capture.observation === "object" ? capture.observation as Record<string, unknown> : {};
  const identity = observation.identity && typeof observation.identity === "object" ? observation.identity as Record<string, unknown> : {};
  return [...manual, target.hostname, target.ip, target.resolvedIp, identity.hostname, identity.resolvedIp, identity.serialNumber, identity.inventoryId, identity.displayName, identity.location]
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function sanitize(value: unknown, sensitiveValues: string[], key = ""): unknown {
  const replacement = keyReplacements[key.toLowerCase()];
  if (replacement !== undefined) return replacement;
  if (typeof value === "string") return sanitizeString(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, sensitiveValues));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, sanitize(entry, sensitiveValues, entryKey)]));
  return value;
}

export function assertSanitized(json: string, sensitiveValues: string[]): void {
  for (const value of sensitiveValues.filter((item) => item.length >= 3)) if (json.toLowerCase().includes(value.toLowerCase())) throw new Error("A source identifying value remains after sanitization; do not save this fixture");
  if (/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(json) && !json.includes("02:00:00:00:00:01")) throw new Error("A possible MAC address remains after sanitization");
  const addresses = json.match(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g) ?? [];
  if (addresses.some((address) => !address.startsWith("192.0.2."))) throw new Error("A non-documentation IPv4 address remains after sanitization");
}

export function sanitizeCapture(capture: Record<string, unknown>, manualRedactions: string[] = []): unknown {
  const sensitiveValues = collectSensitiveValues(capture, manualRedactions);
  const fixture = sanitize(capture, sensitiveValues);
  assertSanitized(JSON.stringify(fixture), sensitiveValues);
  return fixture;
}
