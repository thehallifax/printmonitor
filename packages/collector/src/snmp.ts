import * as snmp from "net-snmp";
import type {
  CollectionIssue,
  CollectionIssueKind,
  Consumable,
  OidCollectionEvidence,
  OidCollectionStatus,
  PrinterAlert,
  PrinterCounters,
  PrinterIdentity,
  PrinterObservation
} from "@printer-fleet/shared";
import { calculateConsumableLevelPercent, normalizeHealth } from "@printer-fleet/shared";
import { adapterRegistry, applyVendorEnrichment, detectVendorWithEvidence } from "./vendor.js";
import { extractGenericIdentity } from "./identity.js";

export const OIDS = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysObjectId: "1.3.6.1.2.1.1.2.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  hrDeviceDescr: "1.3.6.1.2.1.25.3.2.1.3",
  hrPrinterStatus: "1.3.6.1.2.1.25.3.5.1.1",
  hrPrinterDetectedErrorState: "1.3.6.1.2.1.25.3.5.1.2",
  prtGeneralPrinterStatus: "1.3.6.1.2.1.43.5.1.1.6.1",
  prtGeneralPrinterName: "1.3.6.1.2.1.43.5.1.1.16.1",
  prtGeneralSerialNumber: "1.3.6.1.2.1.43.5.1.1.17.1",
  prtMarkerLifeCount: "1.3.6.1.2.1.43.10.2.1.4",
  suppliesClass: "1.3.6.1.2.1.43.11.1.1.4",
  suppliesType: "1.3.6.1.2.1.43.11.1.1.5",
  suppliesDescription: "1.3.6.1.2.1.43.11.1.1.6",
  suppliesUnit: "1.3.6.1.2.1.43.11.1.1.7",
  suppliesMaxCapacity: "1.3.6.1.2.1.43.11.1.1.8",
  suppliesLevel: "1.3.6.1.2.1.43.11.1.1.9",
  alertSeverity: "1.3.6.1.2.1.43.18.1.1.2",
  alertCode: "1.3.6.1.2.1.43.18.1.1.7",
  alertDescription: "1.3.6.1.2.1.43.18.1.1.8"
} as const;

const scalarRequests = [
  ["sysDescr", OIDS.sysDescr], ["sysObjectID", OIDS.sysObjectId], ["sysUpTime", OIDS.sysUpTime],
  ["sysName", OIDS.sysName], ["prtGeneralPrinterStatus", OIDS.prtGeneralPrinterStatus],
  ["prtGeneralPrinterName", OIDS.prtGeneralPrinterName], ["prtGeneralSerialNumber", OIDS.prtGeneralSerialNumber]
] as const;

const tableRequests = [
  ["hrDeviceDescr", OIDS.hrDeviceDescr], ["hrPrinterStatus", OIDS.hrPrinterStatus],
  ["hrPrinterDetectedErrorState", OIDS.hrPrinterDetectedErrorState], ["prtMarkerLifeCount", OIDS.prtMarkerLifeCount],
  ["prtMarkerSuppliesClass", OIDS.suppliesClass], ["prtMarkerSuppliesType", OIDS.suppliesType],
  ["prtMarkerSuppliesDescription", OIDS.suppliesDescription], ["prtMarkerSuppliesSupplyUnit", OIDS.suppliesUnit],
  ["prtMarkerSuppliesMaxCapacity", OIDS.suppliesMaxCapacity], ["prtMarkerSuppliesLevel", OIDS.suppliesLevel],
  ["prtAlertSeverityLevel", OIDS.alertSeverity], ["prtAlertCode", OIDS.alertCode], ["prtAlertDescription", OIDS.alertDescription]
] as const;

export interface RawSnmpData {
  scalars: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>>;
  oidEvidence?: OidCollectionEvidence[];
  issues?: CollectionIssue[];
}

const textValue = (value: unknown): string | undefined => {
  if (Buffer.isBuffer(value)) return value.toString("utf8").replace(/\0/g, "").trim() || undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return value === undefined || value === null ? undefined : String(value);
};

const numberValue = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : Number(textValue(value));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const suffix = (oid: string, base: string) => oid.startsWith(`${base}.`) ? oid.slice(base.length + 1) : oid;
const pickColour = (description: string): string | undefined => ["black", "cyan", "magenta", "yellow"].find((colour) => new RegExp(`\\b${colour}\\b`, "i").test(description));

function supplyType(rawType: number | undefined, description: string): Consumable["type"] {
  if (rawType === 4 || /waste.*toner|toner.*waste/i.test(description)) return "waste-toner";
  if (rawType === 8 || /waste.*ink|ink.*waste/i.test(description)) return "waste-ink";
  if (/\btoner filter\b/i.test(description)) return "other";
  if ([3, 21].includes(rawType ?? -1) || /toner/i.test(description)) return "toner";
  if ([5, 6].includes(rawType ?? -1) || /\bink\b/i.test(description)) return "ink";
  if (rawType === 9 || /\b(drum|imaging unit|photoconductor)\b/i.test(description)) return "drum";
  if (rawType === 20 || /\b(?:second bias transfer (?:roll|roller)|transfer (?:unit|belt(?: cleaner)?))\b/i.test(description)) return "transfer";
  if ([11, 15, 16, 17, 18, 19, 22].includes(rawType ?? -1) || /\bfuser\b/i.test(description)) return "fuser";
  return "other";
}

function jsonSafeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8").replace(/\0/g, "").trim();
    return /^[\x20-\x7E\s]*$/.test(text) ? text : { encoding: "hex", value: value.toString("hex") };
  }
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafeValue(entry)]));
  return value;
}

export function serializeRawSnmp(raw: RawSnmpData): Record<string, unknown> {
  return jsonSafeValue({ scalars: raw.scalars, tables: raw.tables }) as Record<string, unknown>;
}

export function classifySnmpError(error: unknown): CollectionIssueKind {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "RequestTimedOutError" || /timed?\s*out/i.test(message)) return "timeout";
  if (/authenticat|authoriz|no\s*access|unknown\s+user|wrong\s+digest|decrypt/i.test(message)) return "authentication";
  if (/malformed|invalid\s+(response|ber|asn)|parse|decode|unexpected\s+varbind/i.test(message)) return "malformed-response";
  if (name === "RequestFailedError" || /protocol|generr|toobig|nosuchname|badvalue|readonly/i.test(message)) return "protocol";
  if (/enet|ehost|econn|socket|network|unreach/i.test(message)) return "network";
  return "unknown";
}

function safeErrorMessage(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutSecret = secret ? message.split(secret).join("[REDACTED]") : message;
  return withoutSecret.replace(/community\s+[^\s]+/gi, "community [REDACTED]").slice(0, 300);
}

export class SnmpCollectionError extends Error {
  constructor(
    message: string,
    readonly kind: CollectionIssueKind,
    readonly oidEvidence: OidCollectionEvidence[] = []
  ) {
    super(message);
    this.name = "SnmpCollectionError";
  }
}

export function normalizeRawSnmp(identity: PrinterIdentity, raw: RawSnmpData, latencyMs: number, collectedAt = new Date().toISOString()): PrinterObservation {
  const scalar = (oid: string) => raw.scalars[oid];
  const sysDescr = textValue(scalar(OIDS.sysDescr));
  const sysObjectId = textValue(scalar(OIDS.sysObjectId));
  const hrDeviceDescr = textValue(Object.values(raw.tables[OIDS.hrDeviceDescr] ?? {})[0]);
  const printerName = textValue(scalar(OIDS.prtGeneralPrinterName));
  const genericIdentity = extractGenericIdentity({ sysDescr, hrDeviceDescr, printerName });
  const model = genericIdentity.model;
  const detection = detectVendorWithEvidence({ sysObjectId, sysDescr, manufacturer: genericIdentity.manufacturer, model });
  const descriptions = raw.tables[OIDS.suppliesDescription] ?? {};
  const classes = raw.tables[OIDS.suppliesClass] ?? {};
  const types = raw.tables[OIDS.suppliesType] ?? {};
  const units = raw.tables[OIDS.suppliesUnit] ?? {};
  const maximums = raw.tables[OIDS.suppliesMaxCapacity] ?? {};
  const levels = raw.tables[OIDS.suppliesLevel] ?? {};
  const consumables: Consumable[] = Object.entries(descriptions).flatMap(([oid, value]) => {
    const description = textValue(value);
    if (!description) return [];
    const index = suffix(oid, OIDS.suppliesDescription);
    const rawType = numberValue(types[`${OIDS.suppliesType}.${index}`]);
    const rawUnit = numberValue(units[`${OIDS.suppliesUnit}.${index}`]);
    const rawClass = numberValue(classes[`${OIDS.suppliesClass}.${index}`]);
    const rawMaximum = numberValue(maximums[`${OIDS.suppliesMaxCapacity}.${index}`]);
    const rawLevel = numberValue(levels[`${OIDS.suppliesLevel}.${index}`]);
    const type = supplyType(rawType, description);
    return [{
      type, colour: pickColour(description), description,
      levelPercent: calculateConsumableLevelPercent({ type, rawLevel, rawMaximum, rawUnit }),
      rawLevel, rawMaximum, rawType, rawUnit, rawClass
    }];
  });

  const severities = raw.tables[OIDS.alertSeverity] ?? {};
  const codes = raw.tables[OIDS.alertCode] ?? {};
  const alertDescriptions = raw.tables[OIDS.alertDescription] ?? {};
  const alertIndexes = new Set([...Object.keys(severities).map((oid) => suffix(oid, OIDS.alertSeverity)), ...Object.keys(codes).map((oid) => suffix(oid, OIDS.alertCode))]);
  const alerts: PrinterAlert[] = [...alertIndexes].flatMap((index) => {
    const severityCode = numberValue(severities[`${OIDS.alertSeverity}.${index}`]);
    const rawCode = numberValue(codes[`${OIDS.alertCode}.${index}`]);
    const message = textValue(alertDescriptions[`${OIDS.alertDescription}.${index}`]) ?? (rawCode !== undefined ? `Printer alert ${rawCode}` : undefined);
    if (!message) return [];
    return [{ severity: severityCode === 1 || severityCode === 2 ? "critical" : severityCode === 3 ? "warning" : "info", category: "printer", message, rawCode, rawEvidence: { severityCode, index } }];
  });
  const printerStatus = numberValue(scalar(OIDS.prtGeneralPrinterStatus));
  if (printerStatus === 6) alerts.unshift({ severity: "critical", category: "status", message: "Printer reports stopped printing", rawCode: printerStatus });
  const lifeCounts = Object.values(raw.tables[OIDS.prtMarkerLifeCount] ?? {}).map(numberValue).filter((value): value is number => value !== undefined && value >= 0);
  const counters: PrinterCounters = { total: lifeCounts.length ? Math.max(...lifeCounts) : undefined };
  const failed = raw.oidEvidence?.some((item) => item.status === "failed") ?? false;
  const collectionIssues = [...(raw.issues ?? [])];
  if (failed && !collectionIssues.some((issue) => issue.kind === "partial-response")) {
    collectionIssues.push({ kind: "partial-response", message: "One or more standard OID reads failed" });
  }
  const standard: PrinterObservation = {
    identity: {
      ...identity,
      displayName: identity.displayName || printerName || textValue(scalar(OIDS.sysName)) || identity.hostname || identity.ip || identity.inventoryId,
      manufacturer: genericIdentity.manufacturer,
      model,
      serialNumber: textValue(scalar(OIDS.prtGeneralSerialNumber))
    },
    reachability: { reachable: true, latencyMs, lastAttempt: collectedAt, lastSeen: collectedAt },
    consumables, alerts, counters, normalizedHealth: "unknown", collectedAt,
    provenance: {
      collector: "printer-fleet-collector", version: "0.2.0", adapter: "generic", protocol: "snmp-v2c",
      collectionStatus: collectionIssues.length || failed ? "partial" : "complete",
      oidEvidence: raw.oidEvidence,
      issues: collectionIssues,
      rawEvidence: { standard: serializeRawSnmp(raw), genericIdentity, vendorDetection: detection }
    }
  };
  standard.normalizedHealth = normalizeHealth(standard);
  const adapter = adapterRegistry[detection.vendor];
  const enriched = applyVendorEnrichment(standard, adapter, adapter.enrich({
    evidence: { sysObjectId, sysDescr, manufacturer: genericIdentity.manufacturer, model }, standard, rawStandardEvidence: raw
  }));
  if (enriched.normalizedHealth === "unknown" && printerStatus !== undefined && [3, 4, 5].includes(printerStatus)) enriched.normalizedHealth = "healthy";
  return enriched;
}

interface Varbind { oid: string; value: unknown; type?: number; }
interface SnmpSession {
  get(oids: string[], callback: (error: Error | null, varbinds?: Varbind[]) => void): void;
  subtree(oid: string, maxRepetitions: number, feed: (varbinds: Varbind[]) => boolean | void, done: (error?: Error) => void): void;
  close(): void;
}

interface ReadResult { values: Record<string, unknown>; evidence: OidCollectionEvidence[]; issues: CollectionIssue[]; }

function get(session: SnmpSession, requests: typeof scalarRequests, secret: string): Promise<ReadResult> {
  return new Promise((resolve, reject) => session.get(requests.map(([, oid]) => oid), (error, varbinds) => {
    if (error) {
      const kind = classifySnmpError(error);
      const message = safeErrorMessage(error, secret);
      return reject(new SnmpCollectionError(message, kind, requests.map(([symbol, oid]) => ({ symbol, oid, operation: "get", status: "failed", valueCount: 0, issueKind: kind, message }))));
    }
    if (!Array.isArray(varbinds)) return reject(new SnmpCollectionError("Malformed SNMP response: varbind list is missing", "malformed-response"));
    const values: Record<string, unknown> = {};
    const evidence: OidCollectionEvidence[] = [];
    const issues: CollectionIssue[] = [];
    for (const [symbol, oid] of requests) {
      const varbind = varbinds.find((entry) => entry && entry.oid === oid);
      if (!varbind || typeof varbind.oid !== "string" || typeof varbind.type !== "number") {
        evidence.push({ symbol, oid, operation: "get", status: "failed", valueCount: 0, issueKind: "malformed-response", message: "Expected varbind missing" });
        issues.push({ kind: "malformed-response", message: `Expected varbind missing for ${symbol}`, oid });
      } else if (snmp.isVarbindError(varbind as never)) {
        evidence.push({ symbol, oid, operation: "get", status: "unsupported", valueCount: 0, message: snmp.varbindError(varbind as never) });
      } else {
        values[oid] = varbind.value;
        evidence.push({ symbol, oid, operation: "get", status: "succeeded", valueCount: 1 });
      }
    }
    resolve({ values, evidence, issues });
  }));
}

function walk(session: SnmpSession, symbol: string, oid: string, secret: string): Promise<ReadResult> {
  return new Promise((resolve) => {
    const values: Record<string, unknown> = {};
    const issues: CollectionIssue[] = [];
    const unsupportedMessages: string[] = [];
    session.subtree(oid, 20, (varbinds) => {
      if (!Array.isArray(varbinds)) {
        issues.push({ kind: "malformed-response", message: `Malformed walk response for ${symbol}`, oid });
        return;
      }
      for (const varbind of varbinds) {
        if (!varbind || typeof varbind.oid !== "string" || typeof varbind.type !== "number") issues.push({ kind: "malformed-response", message: `Malformed varbind in ${symbol}`, oid });
        else if (snmp.isVarbindError(varbind as never)) unsupportedMessages.push(snmp.varbindError(varbind as never));
        else values[varbind.oid] = varbind.value;
      }
    }, (error) => {
      if (error) {
        const kind = classifySnmpError(error);
        const message = safeErrorMessage(error, secret);
        return resolve({ values, evidence: [{ symbol, oid, operation: "walk", status: "failed", valueCount: Object.keys(values).length, issueKind: kind, message }], issues: [{ kind, message, oid }] });
      }
      const valueCount = Object.keys(values).length;
      const malformed = issues.some((issue) => issue.kind === "malformed-response");
      const status = classifyWalkStatus(valueCount, unsupportedMessages.length > 0, malformed);
      resolve({
        values,
        evidence: [{
          symbol, oid, operation: "walk", status, valueCount,
          issueKind: malformed ? "malformed-response" : undefined,
          message: status === "unsupported" ? unsupportedMessages[0]?.slice(0, 300) : undefined
        }],
        issues
      });
    });
  });
}

export function classifyWalkStatus(valueCount: number, hasUnsupportedVarbind: boolean, malformed: boolean): OidCollectionStatus {
  if (malformed) return "failed";
  if (valueCount > 0) return "succeeded";
  if (hasUnsupportedVarbind) return "unsupported";
  return "empty";
}

export interface SnmpOptions { community: string; timeoutMs: number; retries: number; }

export async function collectGenericSnmp(identity: PrinterIdentity, options: SnmpOptions): Promise<PrinterObservation> {
  if (!identity.resolvedIp) throw new Error("Resolved IP is required before SNMP collection");
  const session = snmp.createSession(identity.resolvedIp, options.community, { version: snmp.Version2c, timeout: options.timeoutMs, retries: options.retries }) as unknown as SnmpSession;
  const started = performance.now();
  try {
    const scalarResult = await get(session, scalarRequests, options.community);
    const tableResults = await Promise.all(tableRequests.map(([symbol, oid]) => walk(session, symbol, oid, options.community)));
    const tables: RawSnmpData["tables"] = {};
    tableResults.forEach((result, index) => { tables[tableRequests[index]![1]] = result.values; });
    return normalizeRawSnmp(identity, {
      scalars: scalarResult.values,
      tables,
      oidEvidence: [...scalarResult.evidence, ...tableResults.flatMap((result) => result.evidence)],
      issues: [...scalarResult.issues, ...tableResults.flatMap((result) => result.issues)]
    }, Math.round(performance.now() - started));
  } finally {
    session.close();
  }
}
