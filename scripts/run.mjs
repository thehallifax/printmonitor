import { join } from "node:path";
import { applyProjectEnvironment, PROJECT_ROOT, validateProjectConfiguration } from "./project-env.mjs";
import { supervise } from "./process-supervisor.mjs";

applyProjectEnvironment();
const validation = await validateProjectConfiguration();
if (validation.errors.length) {
  for (const error of validation.errors) console.error(`Configuration error: ${error}`);
  process.exit(1);
}

const node = process.execPath;
const exitCode = await supervise([
  { name: "web/API", command: node, args: [join(PROJECT_ROOT, "apps/api/dist/server.js")] },
  { name: "collector", command: node, args: [join(PROJECT_ROOT, "packages/collector/dist/cli.js"), "--watch"] }
], { cwd: PROJECT_ROOT, environment: process.env });
process.exitCode = exitCode;
