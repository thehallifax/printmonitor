import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "dotenv";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = "3010";

const CONFIG_KEYS = [
  "SNMP_COMMUNITY",
  "INVENTORY_PATH",
  "DATABASE_PATH",
  "POLL_INTERVAL_SECONDS",
  "SNMP_TIMEOUT_MS",
  "SNMP_RETRIES",
  "COLLECTOR_CONCURRENCY",
  "HOST",
  "PORT"
];

export function readProjectEnvironment(projectRoot = PROJECT_ROOT, environment = process.env) {
  const envPath = join(projectRoot, ".env");
  const fileValues = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const values = { HOST: DEFAULT_HOST, PORT: DEFAULT_PORT, ...fileValues };
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(environment, key)) values[key] = environment[key];
  }
  return { envPath, values };
}

export function applyProjectEnvironment(projectRoot = PROJECT_ROOT, environment = process.env) {
  const loaded = readProjectEnvironment(projectRoot, environment);
  if (environment.DOTENV_CONFIG_PATH === undefined) environment.DOTENV_CONFIG_PATH = loaded.envPath;
  for (const [key, value] of Object.entries(loaded.values)) {
    if (environment[key] === undefined && value !== undefined) environment[key] = value;
  }
  return loaded;
}

export function resolveProjectPath(projectRoot, value) {
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

export async function validateProjectConfiguration(projectRoot = PROJECT_ROOT, environment = process.env, { validateInventory = true } = {}) {
  const { envPath, values } = readProjectEnvironment(projectRoot, environment);
  const errors = [];
  if (!existsSync(envPath)) errors.push(".env is missing");
  if (!values.SNMP_COMMUNITY?.trim()) errors.push("SNMP_COMMUNITY is required");
  if (values.SNMP_COMMUNITY === "example-read-only") errors.push("SNMP_COMMUNITY still uses the example placeholder");
  if (!values.INVENTORY_PATH?.trim()) errors.push("INVENTORY_PATH is required");
  if (!values.DATABASE_PATH?.trim()) errors.push("DATABASE_PATH is required");
  if (!values.HOST?.trim()) errors.push("HOST is required");
  if (!boundedInteger(values.PORT ?? "", 1, 65535)) errors.push("PORT must be an integer from 1 to 65535");
  if (!boundedInteger(values.POLL_INTERVAL_SECONDS ?? "", 10, 86400)) errors.push("POLL_INTERVAL_SECONDS must be an integer from 10 to 86400");
  if (!boundedInteger(values.SNMP_TIMEOUT_MS ?? "", 100, 30000)) errors.push("SNMP_TIMEOUT_MS must be an integer from 100 to 30000");
  if (!boundedInteger(values.SNMP_RETRIES ?? "", 0, 5)) errors.push("SNMP_RETRIES must be an integer from 0 to 5");
  if (!boundedInteger(values.COLLECTOR_CONCURRENCY ?? "", 1, 32)) errors.push("COLLECTOR_CONCURRENCY must be an integer from 1 to 32");

  const inventoryPath = values.INVENTORY_PATH ? resolveProjectPath(projectRoot, values.INVENTORY_PATH) : null;
  const databasePath = values.DATABASE_PATH ? resolveProjectPath(projectRoot, values.DATABASE_PATH) : null;
  if (inventoryPath === resolve(projectRoot, "config/inventory.example.yaml")) errors.push("INVENTORY_PATH still points to the example inventory");
  if (inventoryPath && !existsSync(inventoryPath)) errors.push("The configured inventory file does not exist");
  if (databasePath && !existsSync(dirname(databasePath))) errors.push("The configured database directory does not exist");

  if (validateInventory && inventoryPath && existsSync(inventoryPath) && existsSync(join(projectRoot, "packages/collector/dist/inventory.js"))) {
    try {
      const { loadInventory } = await import(pathToFileURL(join(projectRoot, "packages/collector/dist/inventory.js")).href);
      await loadInventory(inventoryPath);
    } catch (error) {
      errors.push(`Inventory validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { errors, values, envPath, inventoryPath, databasePath };
}

export function dashboardUrl(values) {
  const configuredHost = values.HOST || DEFAULT_HOST;
  const displayHost = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  const host = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  return `http://${host}:${values.PORT || DEFAULT_PORT}`;
}

export function configurationSummary(values) {
  return [`Listen address: ${values.HOST || DEFAULT_HOST}:${values.PORT || DEFAULT_PORT}`, `Dashboard: ${dashboardUrl(values)}`];
}

async function main() {
  const command = process.argv[2];
  const projectRoot = resolve(process.argv[3] || PROJECT_ROOT);
  if (command === "url") {
    console.log(dashboardUrl(readProjectEnvironment(projectRoot).values));
    return;
  }
  if (command === "describe") {
    console.log(configurationSummary(readProjectEnvironment(projectRoot).values).join("\n"));
    return;
  }
  if (command === "validate") {
    const result = await validateProjectConfiguration(projectRoot);
    if (result.errors.length) {
      for (const error of result.errors) console.error(`Configuration error: ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log("Configuration valid.");
    console.log(`Dashboard URL: ${dashboardUrl(result.values)}`);
    return;
  }
  console.error("Usage: node scripts/project-env.mjs <validate|describe|url> [project-root]");
  process.exitCode = 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
