import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export function loadProjectEnvironment(): void {
  const projectEnvPath = process.env.DOTENV_CONFIG_PATH ?? fileURLToPath(new URL("../../../.env", import.meta.url));
  config({ path: projectEnvPath, override: false, quiet: true });
}
