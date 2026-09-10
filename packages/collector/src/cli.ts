import "dotenv/config";
import { randomUUID } from "node:crypto";
import { FleetDatabase } from "@printer-fleet/storage";
import { boundedInteger, loadSnmpOptions, SAFETY_LIMITS } from "./config.js";
import { loadInventory } from "./inventory.js";
import { collectFleet } from "./runner.js";

const inventoryPath = process.env.INVENTORY_PATH ?? "config/inventory.example.yaml";
const databasePath = process.env.DATABASE_PATH ?? "data/printer-fleet.sqlite";
const inventory = await loadInventory(inventoryPath);
const db = new FleetDatabase(databasePath);
db.syncInventory(inventory.site, inventory.printers);
const watch = process.argv.includes("--watch");
const pollIntervalSeconds = watch ? boundedInteger("POLL_INTERVAL_SECONDS", 300, SAFETY_LIMITS.pollIntervalSeconds.minimum, SAFETY_LIMITS.pollIntervalSeconds.maximum) : 0;
const instanceId = randomUUID();
db.registerCollectorRuntime(instanceId, watch, pollIntervalSeconds);
const options = {
  ...loadSnmpOptions(),
  concurrency: boundedInteger("COLLECTOR_CONCURRENCY", 4, SAFETY_LIMITS.concurrency.minimum, SAFETY_LIMITS.concurrency.maximum)
};

async function run(): Promise<void> {
  const result = await collectFleet(db, inventory.printers, options, {
    onRunStarted: (runId, startedAt) => db.beginCollectorRun(instanceId, runId, startedAt),
    onRunFinished: (runId, startedAt, finishedAt) => db.finishCollectorRun(instanceId, runId, startedAt, finishedAt)
  });
  console.log(JSON.stringify({ level: "info", message: "Collection run complete", ...result }));
}

const interval = pollIntervalSeconds * 1000;
const heartbeatTimer = setInterval(() => db.heartbeatCollector(instanceId), 15_000);
let timer: NodeJS.Timeout | undefined;
let activeRun: Promise<void> | undefined;
let shuttingDown = false;

async function execute(): Promise<void> {
  activeRun = run();
  try { await activeRun; }
  catch (error) {
    console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
    if (!watch) process.exitCode = 1;
  }
  finally {
    activeRun = undefined;
    if (watch && !shuttingDown) {
      const nextScheduledRunAt = new Date(Date.now() + interval).toISOString();
      db.scheduleCollectorRun(instanceId, nextScheduledRunAt);
      timer = setTimeout(() => void execute(), interval);
    }
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  clearInterval(heartbeatTimer);
  await activeRun?.catch(() => undefined);
  db.stopCollectorRuntime(instanceId);
  db.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await execute();
if (!watch) await shutdown();
