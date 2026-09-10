export const HEALTH_STATES = ["healthy", "warning", "critical", "offline", "unknown"] as const;
export type NormalizedHealth = (typeof HEALTH_STATES)[number];

export interface PrinterIdentity {
  inventoryId: string;
  hostname: string;
  resolvedIp?: string;
  displayName: string;
  location?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
}

export interface PrinterReachability {
  reachable: boolean;
  latencyMs?: number;
  lastAttempt: string;
  lastSeen?: string;
  failureKind?: CollectionIssueKind;
  failureReason?: string;
}

export type ConsumableType = "toner" | "ink" | "drum" | "waste-toner" | "waste-ink" | "fuser" | "transfer" | "other";
export interface Consumable {
  type: ConsumableType;
  colour?: string;
  description: string;
  levelPercent?: number;
  rawLevel?: number;
  rawMaximum?: number;
  rawType?: number;
  rawUnit?: number;
  rawClass?: number;
}

export type AlertSeverity = "info" | "warning" | "critical";
export interface PrinterAlert {
  severity: AlertSeverity;
  category: string;
  message: string;
  rawCode?: string | number;
  rawEvidence?: unknown;
}

export interface PrinterCounters {
  total?: number;
  mono?: number;
  colour?: number;
}

export type CollectionIssueKind = "dns" | "timeout" | "authentication" | "protocol" | "malformed-response" | "partial-response" | "network" | "unknown";
export type OidCollectionStatus = "succeeded" | "empty" | "unsupported" | "failed";
export interface OidCollectionEvidence {
  symbol: string;
  oid: string;
  operation: "get" | "walk";
  status: OidCollectionStatus;
  valueCount: number;
  issueKind?: CollectionIssueKind;
  message?: string;
}

export interface CollectionIssue {
  kind: CollectionIssueKind;
  message: string;
  oid?: string;
}

export interface CollectorProvenance {
  collector: string;
  version: string;
  adapter: string;
  protocol: "snmp-v2c" | "mock" | "dns";
  collectionStatus?: "complete" | "partial" | "failed";
  oidEvidence?: OidCollectionEvidence[];
  issues?: CollectionIssue[];
  rawEvidence?: Record<string, unknown>;
}

export interface PrinterObservation {
  identity: PrinterIdentity;
  reachability: PrinterReachability;
  consumables: Consumable[];
  alerts: PrinterAlert[];
  counters: PrinterCounters;
  normalizedHealth: NormalizedHealth;
  collectedAt: string;
  provenance: CollectorProvenance;
}

export interface FleetSummary {
  total: number;
  reachable: number;
  offline: number;
  healthy: number;
  warning: number;
  critical: number;
  unknown: number;
  pending: number;
  lowConsumables: number;
}

export type FleetOperationalState = "offline" | "critical" | "warning" | "pending" | "healthy" | "unknown";

export interface FleetPrinterState {
  identity: PrinterIdentity;
  site: { id: string; name: string };
  enabled: boolean;
  configured: boolean;
  configuredAt: string;
  operationalState: FleetOperationalState;
  reachability: PrinterReachability | null;
  consumables: Consumable[];
  alerts: PrinterAlert[];
  counters: PrinterCounters;
  normalizedHealth: NormalizedHealth;
  collectedAt: string | null;
  provenance: CollectorProvenance | null;
  isStale: boolean;
  staleSince: string | null;
  ageSeconds: number | null;
  latestAttemptAt: string | null;
  lastSuccessfulCollectionAt: string | null;
  collectionDurationMs: number | null;
  lastKnownData: boolean;
}

export const STALE_MINIMUM_SECONDS = 300;

export function deriveStaleState(lastAttempt: string, pollIntervalSeconds: number, now = new Date()): Pick<FleetPrinterState, "isStale" | "staleSince" | "ageSeconds"> {
  const attemptedAt = Date.parse(lastAttempt);
  const thresholdSeconds = Math.max(pollIntervalSeconds * 2, STALE_MINIMUM_SECONDS);
  const ageSeconds = Number.isFinite(attemptedAt) ? Math.max(0, Math.floor((now.getTime() - attemptedAt) / 1000)) : Number.MAX_SAFE_INTEGER;
  const isStale = ageSeconds > thresholdSeconds;
  return {
    isStale,
    ageSeconds,
    staleSince: isStale && Number.isFinite(attemptedAt) ? new Date(attemptedAt + thresholdSeconds * 1000).toISOString() : null
  };
}

const operationalPriority: Record<FleetOperationalState, number> = { offline: 0, critical: 1, warning: 2, pending: 3, healthy: 4, unknown: 5 };

export function compareFleetPriority(a: Pick<FleetPrinterState, "identity" | "operationalState" | "isStale">, b: Pick<FleetPrinterState, "identity" | "operationalState" | "isStale">): number {
  const healthDifference = operationalPriority[a.operationalState] - operationalPriority[b.operationalState];
  if (healthDifference) return healthDifference;
  if (a.isStale !== b.isStale) return a.isStale ? -1 : 1;
  return (a.identity.displayName || a.identity.hostname).localeCompare(b.identity.displayName || b.identity.hostname, undefined, { sensitivity: "base" });
}

export function calculateLevelPercent(rawLevel?: number, rawMaximum?: number): number | undefined {
  if (rawLevel === undefined || rawMaximum === undefined || rawLevel < 0 || rawMaximum <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((rawLevel / rawMaximum) * 100)));
}

export function calculateConsumableLevelPercent(input: Pick<Consumable, "type" | "rawLevel" | "rawMaximum" | "rawUnit">): number | undefined {
  const { type, rawLevel, rawMaximum, rawUnit } = input;
  if (rawLevel === undefined || rawLevel < 0) return undefined;
  // Printer-MIB unit 19 declares that the current value itself is a percent.
  if (rawUnit === 19) return rawLevel <= 100 ? Math.round(rawLevel) : undefined;
  // Item-count and other finisher supplies (for example staples) retain raw
  // values but do not imply a percentage. Known lifecycle/container types may
  // use a reliable current/max ratio because both values share a MIB unit.
  if (!["toner", "ink", "drum", "waste-toner", "waste-ink", "fuser", "transfer"].includes(type)) return undefined;
  return calculateLevelPercent(rawLevel, rawMaximum);
}

export function normalizeHealth(input: Pick<PrinterObservation, "reachability" | "alerts" | "consumables">): NormalizedHealth {
  if (!input.reachability.reachable) return "offline";
  if (input.alerts.some((alert) => alert.severity === "critical")) return "critical";
  if (input.alerts.some((alert) => alert.severity === "warning") || input.consumables.some((item) => item.levelPercent !== undefined && item.levelPercent <= 20)) return "warning";
  if (input.alerts.length > 0 || input.consumables.length > 0) return "healthy";
  return "unknown";
}

export function emptyOfflineObservation(identity: PrinterIdentity, failureReason: string, protocol: "dns" | "snmp-v2c" = "snmp-v2c", at = new Date().toISOString(), failureKind: CollectionIssueKind = "unknown"): PrinterObservation {
  return {
    identity,
    reachability: { reachable: false, lastAttempt: at, failureKind, failureReason },
    consumables: [], alerts: [], counters: {}, normalizedHealth: "offline", collectedAt: at,
    provenance: {
      collector: "printer-fleet-collector", version: "0.2.0", adapter: "generic", protocol,
      collectionStatus: "failed", issues: [{ kind: failureKind, message: failureReason }], rawEvidence: { failureKind, failureReason }
    }
  };
}
