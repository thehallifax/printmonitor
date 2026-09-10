import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { FleetDatabase } from "@printer-fleet/storage";
import { resolve } from "node:path";

export interface AppOptions { databasePath?: string; webRoot?: string; logger?: boolean; }

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  const db = new FleetDatabase(options.databasePath ?? process.env.DATABASE_PATH ?? "data/printer-fleet.sqlite");
  app.addHook("onClose", async () => db.close());

  app.get("/api/health", async () => ({ status: "ok", service: "printer-fleet-api", time: new Date().toISOString() }));
  app.get("/api/fleet", async () => db.getFleet());
  app.get("/api/printers", async () => ({ printers: db.getPrinters() }));
  app.get<{ Params: { id: string } }>("/api/printers/:id", async (request, reply) => {
    const printer = db.getPrinter(request.params.id);
    if (!printer) return reply.code(404).send({ error: "Printer not found" });
    return printer;
  });

  await app.register(fastifyStatic, {
    root: resolve(options.webRoot ?? "apps/web/public"),
    prefix: "/",
    wildcard: false
  });
  return app;
}
