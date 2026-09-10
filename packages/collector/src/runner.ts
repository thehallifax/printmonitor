import type { CollectionIssueKind, PrinterIdentity, PrinterObservation } from "@printer-fleet/shared";
import { emptyOfflineObservation } from "@printer-fleet/shared";
import { FleetDatabase } from "@printer-fleet/storage";
import type { RunResult } from "@printer-fleet/storage";
import { resolvePrinter, type HostResolver } from "./dns.js";
import type { InventoryPrinter } from "./inventory.js";
import { classifySnmpError, collectGenericSnmp, SnmpCollectionError, type SnmpOptions } from "./snmp.js";

export interface CollectorDependencies {
  resolve?: HostResolver;
  collect?: (identity: PrinterIdentity, options: SnmpOptions) => Promise<PrinterObservation>;
  onRunStarted?: (runId: string, startedAt: string) => void;
  onRunFinished?: (runId: string, startedAt: string, finishedAt: string) => void;
}

const activeDatabases = new WeakSet<FleetDatabase>();

export class CollectionAlreadyRunningError extends Error {
  constructor() {
    super("A fleet collection run is already active for this collector process");
    this.name = "CollectionAlreadyRunningError";
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run));
  return results;
}

export async function collectFleet(
  db: FleetDatabase,
  printers: InventoryPrinter[],
  options: SnmpOptions & { concurrency: number },
  dependencies: CollectorDependencies = {}
): Promise<RunResult> {
  if (activeDatabases.has(db)) throw new CollectionAlreadyRunningError();
  activeDatabases.add(db);
  const enabled = printers.filter((printer) => printer.enabled);
  const startedAt = new Date().toISOString();
  const runId = db.startRun(printers.length, enabled.length, startedAt);
  dependencies.onRunStarted?.(runId, startedAt);
  const started = performance.now();
  const resolveHost = dependencies.resolve;
  const collect = dependencies.collect ?? collectGenericSnmp;
  try {
    const observations = await mapConcurrent(enabled, options.concurrency, async (printer) => {
      const identity: PrinterIdentity = {
        inventoryId: printer.inventoryId, hostname: printer.hostname, displayName: printer.displayName, location: printer.location
      };
      const resolution = await resolvePrinter(identity, resolveHost);
      if ("observation" in resolution) return resolution.observation;
      try { return await collect(resolution.identity, options); }
      catch (error) {
        const failureKind: CollectionIssueKind = error instanceof SnmpCollectionError ? error.kind : classifySnmpError(error);
        const rawMessage = error instanceof Error ? error.message : String(error);
        const safeMessage = rawMessage.split(options.community).join("[REDACTED]").slice(0, 300);
        const observation = emptyOfflineObservation(resolution.identity, `SNMP ${failureKind}: ${safeMessage}`, "snmp-v2c", new Date().toISOString(), failureKind);
        if (error instanceof SnmpCollectionError) observation.provenance.oidEvidence = error.oidEvidence;
        return observation;
      }
    });
    for (const observation of observations) db.saveObservation(observation, runId);
    const result = {
      configured: printers.length,
      attempted: observations.length,
      succeeded: observations.filter((item) => item.reachability.reachable).length,
      reachable: observations.filter((item) => item.reachability.reachable).length,
      unreachable: observations.filter((item) => !item.reachability.reachable).length,
      partial: observations.filter((item) => item.provenance.collectionStatus === "partial").length,
      failed: observations.filter((item) => item.provenance.collectionStatus === "failed").length,
      durationMs: Math.round(performance.now() - started)
    };
    db.finishRun(runId, result);
    dependencies.onRunFinished?.(runId, startedAt, new Date().toISOString());
    return result;
  } catch (error) {
    const result = { configured: printers.length, attempted: enabled.length, succeeded: 0, reachable: 0, unreachable: 0, partial: 0, failed: enabled.length, durationMs: Math.round(performance.now() - started) };
    db.finishRun(runId, result, error instanceof Error ? error.message : String(error));
    dependencies.onRunFinished?.(runId, startedAt, new Date().toISOString());
    throw error;
  } finally {
    activeDatabases.delete(db);
  }
}
