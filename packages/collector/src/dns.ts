import { promises as dns } from "node:dns";
import type { PrinterIdentity, PrinterObservation } from "@printer-fleet/shared";
import { emptyOfflineObservation } from "@printer-fleet/shared";

export type HostResolver = (hostname: string) => Promise<{ address: string; family: number }>;

export async function resolvePrinter(identity: PrinterIdentity, resolver: HostResolver = dns.lookup): Promise<{ identity: PrinterIdentity } | { observation: PrinterObservation }> {
  try {
    const result = await resolver(identity.hostname);
    return { identity: { ...identity, resolvedIp: result.address } };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN";
    return { observation: emptyOfflineObservation(identity, `DNS resolution failed (${code})`, "dns", new Date().toISOString(), "dns") };
  }
}
