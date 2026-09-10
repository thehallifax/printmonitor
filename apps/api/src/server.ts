import { buildApp } from "./app.js";
import { loadProjectEnvironment } from "./project-env.js";

loadProjectEnvironment();

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const host = process.env.HOST ?? "127.0.0.1";
const app = await buildApp();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try { await app.listen({ host, port }); }
catch (error) { app.log.error(error); process.exit(1); }
