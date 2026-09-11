import { promises as dns } from "node:dns";
import type { PrinterIdentity, PrinterObservation } from "@printer-fleet/shared";
import { emptyOfflineObservation } from "@printer-fleet/shared";

export type HostResolver = (hostname: string) => Promise<{ address: string; family: number }>;

export async function resolvePrinter(identity: PrinterIdentity, resolver: HostResolver = dns.lookup): Promise<{ identity: PrinterIdentity } | { observation: PrinterObservation }> {
  if (identity.targetType === "ip" || identity.ip) return { identity: { ...identity, resolvedIp: identity.ip ?? identity.targetValue } };
  const hostname = identity.hostname ?? identity.targetValue;
  if (!hostname) return { observation: emptyOfflineObservation(identity, "No configured connection target", "dns", new Date().toISOString(), "dns") };
  try {
    const result = await resolver(hostname);
    return { identity: { ...identity, resolvedIp: result.address } };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN";
    return { observation: emptyOfflineObservation(identity, `DNS resolution failed (${code})`, "dns", new Date().toISOString(), "dns") };
  }
}
