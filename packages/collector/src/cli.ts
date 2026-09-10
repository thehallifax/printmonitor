import "dotenv/config";
import { FleetDatabase } from "@printer-fleet/storage";
import { boundedInteger, loadSnmpOptions, SAFETY_LIMITS } from "./config.js";
import { loadInventory } from "./inventory.js";
import { collectFleet } from "./runner.js";

const inventoryPath = process.env.INVENTORY_PATH ?? "config/inventory.example.yaml";
const databasePath = process.env.DATABASE_PATH ?? "data/printer-fleet.sqlite";
const inventory = await loadInventory(inventoryPath);
const db = new FleetDatabase(databasePath);
db.syncInventory(inventory.site, inventory.printers);
const options = {
  ...loadSnmpOptions(),
  concurrency: boundedInteger("COLLECTOR_CONCURRENCY", 4, SAFETY_LIMITS.concurrency.minimum, SAFETY_LIMITS.concurrency.maximum)
};

async function run(): Promise<void> {
  const result = await collectFleet(db, inventory.printers, options);
  console.log(JSON.stringify({ level: "info", message: "Collection run complete", ...result }));
}

let timer: NodeJS.Timeout | undefined;
const shutdown = () => { if (timer) clearInterval(timer); db.close(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await run();
if (process.argv.includes("--watch")) {
  const interval = boundedInteger("POLL_INTERVAL_SECONDS", 300, SAFETY_LIMITS.pollIntervalSeconds.minimum, SAFETY_LIMITS.pollIntervalSeconds.maximum) * 1000;
  timer = setInterval(() => void run().catch((error) => console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }))), interval);
} else {
  db.close();
}
