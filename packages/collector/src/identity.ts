export interface GenericIdentityEvidence {
  sysDescr?: string;
  hrDeviceDescr?: string;
  printerName?: string;
}

export interface GenericIdentityResult {
  manufacturer?: string;
  model?: string;
  manufacturerSignal?: string;
}

interface KnownManufacturer {
  canonical: string;
  signal: RegExp;
  leadingModelPrefix: RegExp;
}

const knownManufacturers: KnownManufacturer[] = [
  {
    canonical: "FUJIFILM",
    signal: /\bFUJIFILM\b/i,
    leadingModelPrefix: /^FUJIFILM[\s:–—-]+/i
  }
];

export function extractGenericIdentity(evidence: GenericIdentityEvidence): GenericIdentityResult {
  const candidates = [
    ["hrDeviceDescr", evidence.hrDeviceDescr],
    ["sysDescr", evidence.sysDescr],
    ["printerName", evidence.printerName]
  ] as const;
  const modelCandidate = candidates.find(([, value]) => value?.trim())?.[1]?.trim();
  const manufacturer = knownManufacturers.find((known) => candidates.some(([, value]) => value && known.signal.test(value)));
  if (!manufacturer) return { model: modelCandidate };
  const strippedModel = modelCandidate?.replace(manufacturer.leadingModelPrefix, "").trim();
  return {
    manufacturer: manufacturer.canonical,
    model: strippedModel || modelCandidate,
    manufacturerSignal: candidates.find(([, value]) => value && manufacturer.signal.test(value))?.[0]
  };
}
