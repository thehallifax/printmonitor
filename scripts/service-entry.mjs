import { join, resolve } from "node:path";
import { applyProjectEnvironment, PROJECT_ROOT, validateProjectConfiguration } from "./project-env.mjs";
import { supervise } from "./process-supervisor.mjs";

const service = process.argv[2];
const projectRoot = resolve(process.argv[3] || PROJECT_ROOT);
if (!new Set(["web", "collector"]).has(service)) {
  console.error("Usage: node scripts/service-entry.mjs <web|collector> <project-root>");
  process.exit(2);
}

applyProjectEnvironment(projectRoot);
const validation = await validateProjectConfiguration(projectRoot);
if (validation.errors.length) {
  for (const error of validation.errors) console.error(`Configuration error: ${error}`);
  process.exit(1);
}

const definition = service === "web"
  ? { name: "web/API", command: process.execPath, args: [join(projectRoot, "apps/api/dist/server.js")] }
  : { name: "collector", command: process.execPath, args: [join(projectRoot, "packages/collector/dist/cli.js"), "--watch"] };
process.exitCode = await supervise([definition], { cwd: projectRoot, environment: process.env });
