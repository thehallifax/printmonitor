import { join, resolve } from "node:path";
import { applyProjectEnvironment, PROJECT_ROOT, validateProjectConfiguration } from "./project-env.mjs";
import { supervise } from "./process-supervisor.mjs";

const projectRoot = resolve(process.argv[2] || PROJECT_ROOT);
applyProjectEnvironment(projectRoot);
const validation = await validateProjectConfiguration(projectRoot);
if (validation.errors.length) {
  for (const error of validation.errors) console.error(`Configuration error: ${error}`);
  process.exit(1);
}

const node = process.execPath;
const exitCode = await supervise([
  { name: "web/API", command: node, args: [join(projectRoot, "apps/api/dist/server.js")] },
  { name: "collector", command: node, args: [join(projectRoot, "packages/collector/dist/cli.js"), "--watch"] }
], { cwd: projectRoot, environment: process.env });
process.exitCode = exitCode;
