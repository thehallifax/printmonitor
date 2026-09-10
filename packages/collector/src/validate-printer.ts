import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSnmpOptions } from "./config.js";
import { classifySnmpError, collectGenericSnmp, SnmpCollectionError } from "./snmp.js";
import { parseValidationArguments, resolveValidationTarget, VALIDATION_USAGE } from "./validation-target.js";
import { loadProjectEnvironment } from "./project-env.js";

loadProjectEnvironment();

function printOidSummary(evidence: NonNullable<Awaited<ReturnType<typeof collectGenericSnmp>>["provenance"]["oidEvidence"]>): void {
  console.log("\nStandard OID results");
  for (const item of evidence) console.log(`  ${item.status.padEnd(11)} ${item.symbol.padEnd(34)} ${item.oid}${item.valueCount ? ` (${item.valueCount} values)` : ""}`);
}

async function saveCapture(capture: unknown): Promise<string> {
  const directory = resolve("data/private/live-validation");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(directory, `capture-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(capture, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 1 && rawArgs[0] === "--help") {
    console.log(VALIDATION_USAGE);
    return;
  }
  const args = parseValidationArguments(rawArgs);
  const options = loadSnmpOptions();
  const started = performance.now();
  console.log("Printer Fleet Monitor — read-only live validation");
  const targetMode = args.target.mode;
  const targetValue = args.target.mode === "hostname" ? args.target.hostname : args.target.ip;
  console.log(`Target mode: ${targetMode === "hostname" ? "hostname" : "explicit IPv4"}`);
  console.log(`Target: ${targetValue}`);
  let address: string;
  try {
    const result = await resolveValidationTarget(args.target);
    address = result.address;
    console.log(result.dns === "skipped" ? "DNS: skipped" : `DNS: ${address} (IPv${result.family})`);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN";
    const durationMs = Math.round(performance.now() - started);
    console.log(`DNS: failed (${code})`);
    console.log(`Duration: ${durationMs} ms`);
    if (args.capture && args.target.mode === "hostname") {
      const path = await saveCapture({ captureVersion: 1, targetMode, capturedAt: new Date().toISOString(), durationMs, target: { hostname: args.target.hostname }, failure: { kind: "dns", message: `DNS resolution failed (${code})` } });
      console.log(`Private diagnostic capture: ${path}`);
    }
    process.exitCode = 2;
    return;
  }

  try {
    const observation = await collectGenericSnmp({
      inventoryId: "live-validation-target",
      hostname: args.target.mode === "hostname" ? args.target.hostname : "explicit-ip.validation.invalid",
      displayName: "Live validation target",
      resolvedIp: address
    }, options);
    const durationMs = Math.round(performance.now() - started);
    const detection = observation.provenance.rawEvidence?.vendorDetection;
    console.log(`Vendor adapter: ${observation.provenance.adapter}`);
    if (detection && typeof detection === "object" && "confidence" in detection) {
      const signals = "signals" in detection && Array.isArray(detection.signals) ? `; ${detection.signals.map(String).join(", ")}` : "";
      console.log(`Vendor evidence: ${String(detection.confidence)}${signals}`);
    }
    console.log(`Normalized identity: ${observation.identity.manufacturer ?? "unknown"} ${observation.identity.model ?? "unknown model"}`);
    console.log(`Normalized state: reachable, health=${observation.normalizedHealth}, supplies=${observation.consumables.length}, alerts=${observation.alerts.length}`);
    for (const supply of observation.consumables) {
      const level = supply.levelPercent !== undefined ? `${supply.levelPercent}%` : `raw level=${supply.rawLevel ?? "unknown"}, max=${supply.rawMaximum ?? "unknown"}`;
      console.log(`  supply: ${supply.description} (${supply.type}, ${level})`);
    }
    for (const alert of observation.alerts) console.log(`  alert: ${alert.severity} — ${alert.message}`);
    if (Object.values(observation.counters).some((value) => value !== undefined)) console.log(`  counters: ${JSON.stringify(observation.counters)}`);
    console.log(`Collection completeness: ${observation.provenance.collectionStatus ?? "unknown"}`);
    console.log(`Duration: ${durationMs} ms`);
    printOidSummary(observation.provenance.oidEvidence ?? []);
    if (args.capture) {
      const target = args.target.mode === "hostname" ? { hostname: args.target.hostname, resolvedIp: address } : { ip: args.target.ip };
      const path = await saveCapture({ captureVersion: 1, targetMode, capturedAt: new Date().toISOString(), durationMs, target, observation });
      console.log(`\nPrivate diagnostic capture: ${path}`);
      console.log("The capture is ignored by Git. Sanitize and manually review it before creating a test fixture.");
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const kind = error instanceof SnmpCollectionError ? error.kind : classifySnmpError(error);
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.split(options.community).join("[REDACTED]").slice(0, 300);
    console.log(`SNMP result: failed (${kind})`);
    console.log(`Reason: ${message}`);
    console.log(`Duration: ${durationMs} ms`);
    if (error instanceof SnmpCollectionError) printOidSummary(error.oidEvidence);
    if (args.capture) {
      const target = args.target.mode === "hostname" ? { hostname: args.target.hostname, resolvedIp: address } : { ip: args.target.ip };
      const path = await saveCapture({ captureVersion: 1, targetMode, capturedAt: new Date().toISOString(), durationMs, target, failure: { kind, message }, oidEvidence: error instanceof SnmpCollectionError ? error.oidEvidence : [] });
      console.log(`Private diagnostic capture: ${path}`);
    }
    process.exitCode = 2;
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
