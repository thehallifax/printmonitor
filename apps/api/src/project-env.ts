import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export function loadProjectEnvironment(): void {
  config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), override: false, quiet: true });
}
