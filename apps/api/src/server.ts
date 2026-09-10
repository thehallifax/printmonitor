import "dotenv/config";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const host = process.env.HOST ?? "127.0.0.1";
const app = await buildApp();

try { await app.listen({ host, port }); }
catch (error) { app.log.error(error); process.exit(1); }
