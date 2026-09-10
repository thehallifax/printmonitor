import type { SnmpOptions } from "./snmp.js";

export const SAFETY_LIMITS = {
  timeoutMs: { minimum: 100, maximum: 30_000 },
  retries: { minimum: 0, maximum: 5 },
  concurrency: { minimum: 1, maximum: 32 },
  pollIntervalSeconds: { minimum: 10, maximum: 86_400 }
} as const;

export function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

export function loadSnmpOptions(): SnmpOptions {
  const community = process.env.SNMP_COMMUNITY;
  if (!community) throw new Error("SNMP_COMMUNITY is required; set it in the local environment or an ignored .env file");
  return {
    community,
    timeoutMs: boundedInteger("SNMP_TIMEOUT_MS", 3000, SAFETY_LIMITS.timeoutMs.minimum, SAFETY_LIMITS.timeoutMs.maximum),
    retries: boundedInteger("SNMP_RETRIES", 1, SAFETY_LIMITS.retries.minimum, SAFETY_LIMITS.retries.maximum)
  };
}
