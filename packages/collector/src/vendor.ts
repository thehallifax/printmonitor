import type { Consumable, PrinterAlert, PrinterCounters, PrinterIdentity, PrinterObservation } from "@printer-fleet/shared";
import { normalizeHealth } from "@printer-fleet/shared";

export type VendorId = "generic" | "ricoh" | "canon" | "konica-minolta" | "kyocera";

export interface VendorEvidence {
  sysObjectId?: string;
  sysDescr?: string;
  manufacturer?: string;
  model?: string;
}

export interface AdapterDetection {
  vendor: VendorId;
  confidence: "generic" | "name" | "enterprise-oid";
  signals: string[];
}

export interface VendorEnrichment {
  identity?: Partial<Pick<PrinterIdentity, "manufacturer" | "model" | "serialNumber">>;
  consumables?: Consumable[];
  alerts?: PrinterAlert[];
  counters?: PrinterCounters;
  rawEvidence?: Record<string, unknown>;
}

export interface VendorAdapterContext {
  evidence: VendorEvidence;
  standard: PrinterObservation;
  rawStandardEvidence: unknown;
}

export interface VendorAdapter {
  id: VendorId;
  detect(evidence: VendorEvidence): AdapterDetection | undefined;
  enrich(context: VendorAdapterContext): VendorEnrichment;
}

interface AdapterDefinition {
  id: Exclude<VendorId, "generic">;
  manufacturer: string;
  enterprise: string;
  names: RegExp;
}

const definitions: AdapterDefinition[] = [
  { id: "ricoh", manufacturer: "Ricoh", enterprise: "367", names: /\bricoh\b/i },
  { id: "canon", manufacturer: "Canon", enterprise: "1602", names: /\bcanon\b/i },
  { id: "konica-minolta", manufacturer: "Konica Minolta", enterprise: "18334", names: /\b(konica|minolta|bizhub)\b/i },
  { id: "kyocera", manufacturer: "Kyocera", enterprise: "1347", names: /\b(kyocera|ecosys|taskalfa)\b/i }
];

function adapterFrom(definition: AdapterDefinition): VendorAdapter {
  return {
    id: definition.id,
    detect(evidence) {
      const enterpriseRoot = `1.3.6.1.4.1.${definition.enterprise}`;
      if (evidence.sysObjectId === enterpriseRoot || evidence.sysObjectId?.startsWith(`${enterpriseRoot}.`)) {
        return { vendor: definition.id, confidence: "enterprise-oid", signals: [`sysObjectID enterprise ${definition.enterprise}`] };
      }
      const text = [evidence.sysDescr, evidence.manufacturer, evidence.model].filter(Boolean).join(" ");
      if (definition.names.test(text)) return { vendor: definition.id, confidence: "name", signals: ["standard descriptive field"] };
      return undefined;
    },
    enrich() {
      // No vendor-private OIDs are queried until sanitized live evidence shows
      // that a documented standard MIB value is insufficient.
      return { identity: { manufacturer: definition.manufacturer } };
    }
  };
}

const genericAdapter: VendorAdapter = {
  id: "generic",
  detect: () => ({ vendor: "generic", confidence: "generic", signals: ["no supported vendor signal"] }),
  enrich: () => ({})
};

export const adapterRegistry: Record<VendorId, VendorAdapter> = Object.fromEntries([
  ...definitions.map((definition) => {
    const adapter = adapterFrom(definition);
    return [adapter.id, adapter] as const;
  }),
  [genericAdapter.id, genericAdapter]
]) as Record<VendorId, VendorAdapter>;

export function detectVendorWithEvidence(evidence: VendorEvidence): AdapterDetection {
  for (const definition of definitions) {
    const detection = adapterRegistry[definition.id].detect(evidence);
    if (detection) return detection;
  }
  return genericAdapter.detect(evidence)!;
}

export function detectVendor(evidence: VendorEvidence): VendorId {
  return detectVendorWithEvidence(evidence).vendor;
}

export function applyVendorEnrichment(standard: PrinterObservation, adapter: VendorAdapter, enrichment: VendorEnrichment): PrinterObservation {
  const enriched: PrinterObservation = {
    ...standard,
    identity: { ...standard.identity, ...enrichment.identity },
    consumables: [...standard.consumables, ...(enrichment.consumables ?? [])],
    alerts: [...standard.alerts, ...(enrichment.alerts ?? [])],
    counters: { ...standard.counters, ...enrichment.counters },
    provenance: {
      ...standard.provenance,
      adapter: adapter.id,
      rawEvidence: enrichment.rawEvidence
        ? { ...(standard.provenance.rawEvidence ?? {}), vendor: enrichment.rawEvidence }
        : standard.provenance.rawEvidence
    }
  };
  enriched.normalizedHealth = normalizeHealth(enriched);
  return enriched;
}
