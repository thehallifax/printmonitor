import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { FleetDatabase } from "@printer-fleet/storage";
import type { FleetPrinterState, NormalizedHealth, PrinterObservation } from "@printer-fleet/shared";
import { resolve } from "node:path";

export interface AppOptions {
  databasePath?: string;
  webRoot?: string;
  logger?: boolean;
  pollIntervalSeconds?: number;
  now?: () => Date;
}

interface PrinterQuery {
  search?: string;
  site?: string;
  location?: string;
  health?: string;
  reachable?: string;
  stale?: string;
  state?: string;
}

const healthStates = new Set<NormalizedHealth>(["healthy", "warning", "critical", "offline", "unknown"]);
const parseBoolean = (value: string | undefined): boolean | undefined => value === undefined ? undefined : value === "true" ? true : value === "false" ? false : undefined;
const boundedLimit = (value: unknown, fallback: number, cap: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, cap) : fallback;
};

function filterPrinters(printers: FleetPrinterState[], query: PrinterQuery): FleetPrinterState[] {
  const search = query.search?.trim().toLowerCase();
  const site = query.site?.trim().toLowerCase();
  const location = query.location?.trim().toLowerCase();
  const reachable = parseBoolean(query.reachable);
  const stale = parseBoolean(query.stale);
  return printers.filter((printer) => {
    const searchable = [printer.identity.displayName, printer.identity.hostname, printer.identity.manufacturer, printer.identity.model, printer.site.name, printer.identity.location].filter(Boolean).join(" ").toLowerCase();
    if (search && !searchable.includes(search)) return false;
    if (site && printer.site.id.toLowerCase() !== site && printer.site.name.toLowerCase() !== site) return false;
    if (location && printer.identity.location?.toLowerCase() !== location) return false;
    if (query.health && query.health !== printer.normalizedHealth) return false;
    if (query.state && query.state !== printer.operationalState) return false;
    if (reachable !== undefined && printer.reachability?.reachable !== reachable) return false;
    if (stale !== undefined && printer.isStale !== stale) return false;
    return true;
  });
}

function historyEntry(observation: PrinterObservation) {
  return {
    collectedAt: observation.collectedAt,
    reachable: observation.reachability.reachable,
    health: observation.normalizedHealth,
    totalPages: observation.counters.total,
    supplies: observation.consumables.filter((supply) => supply.levelPercent !== undefined).map((supply) => ({ description: supply.description, type: supply.type, colour: supply.colour, levelPercent: supply.levelPercent })),
    completeness: observation.provenance.collectionStatus,
    failure: observation.reachability.reachable ? undefined : { kind: observation.reachability.failureKind, reason: observation.reachability.failureReason }
  };
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger === false ? false : { base: undefined } });
  const db = new FleetDatabase(options.databasePath ?? process.env.DATABASE_PATH ?? "data/printer-fleet.sqlite");
  const configuredPollInterval = options.pollIntervalSeconds ?? Number(process.env.POLL_INTERVAL_SECONDS ?? 300);
  const pollIntervalSeconds = Number.isInteger(configuredPollInterval) && configuredPollInterval >= 10 && configuredPollInterval <= 86_400 ? configuredPollInterval : 300;
  const now = options.now ?? (() => new Date());
  app.addHook("onClose", async () => db.close());

  app.get("/api/health", async () => {
    const databaseHealthy = db.isHealthy();
    const runtime = db.getCollectorRuntime(now());
    const lastRun = runtime?.lastRunId ? db.getRun(runtime.lastRunId) : db.getRuns(1)[0];
    return {
      status: databaseHealthy ? "ok" : "degraded",
      service: "printer-fleet-api",
      time: now().toISOString(),
      database: { status: databaseHealthy ? "ok" : "error" },
      collector: {
        status: runtime?.status ?? "unavailable",
        running: runtime?.status === "running",
        instanceId: runtime?.instanceId,
        startedAt: runtime?.startedAt,
        lastHeartbeatAt: runtime?.lastHeartbeatAt,
        currentRunId: runtime?.currentRunId,
        currentRunStartedAt: runtime?.currentRunStartedAt,
        lastRunStartedAt: runtime?.lastRunStartedAt ?? lastRun?.startedAt,
        lastRunFinishedAt: runtime?.lastRunFinishedAt ?? lastRun?.completedAt,
        lastRunSummary: lastRun ? { configured: lastRun.configured, attempted: lastRun.attempted, reachable: lastRun.reachable, unreachable: lastRun.unreachable, partial: lastRun.partial, failed: lastRun.failed, durationMs: lastRun.durationMs } : undefined,
        nextScheduledRunAt: runtime?.nextScheduledRunAt ?? null,
        watchMode: runtime?.watchMode ?? false,
        pollIntervalSeconds: runtime?.pollIntervalSeconds
      }
    };
  });

  app.get("/api/fleet", async () => db.getFleet(pollIntervalSeconds, now()));

  app.get<{ Querystring: PrinterQuery }>("/api/printers", async (request, reply) => {
    for (const field of ["search", "site", "location", "health", "reachable", "stale", "state"] as const) {
      const value = request.query[field];
      if (value !== undefined && (typeof value !== "string" || value.length > 200)) return reply.code(400).send({ error: `${field} must be a string of at most 200 characters` });
    }
    if (request.query.health && !healthStates.has(request.query.health as NormalizedHealth)) return reply.code(400).send({ error: "health must be healthy, warning, critical, offline, or unknown" });
    if (request.query.state && !["offline", "critical", "warning", "pending", "healthy", "unknown"].includes(request.query.state)) return reply.code(400).send({ error: "state must be offline, critical, warning, pending, healthy, or unknown" });
    for (const field of ["reachable", "stale"] as const) {
      if (request.query[field] !== undefined && parseBoolean(request.query[field]) === undefined) return reply.code(400).send({ error: `${field} must be true or false` });
    }
    const printers = db.getPrinterStates(pollIntervalSeconds, now()).filter((printer) => printer.configured && printer.enabled);
    return { printers: filterPrinters(printers, request.query), total: printers.length };
  });

  app.get<{ Params: { id: string } }>("/api/printers/:id", async (request, reply) => {
    const printer = db.getPrinterState(request.params.id, pollIntervalSeconds, now());
    if (!printer) return reply.code(404).send({ error: "Printer not found" });
    return printer;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/printers/:id/history", async (request, reply) => {
    if (!db.getPrinterState(request.params.id, pollIntervalSeconds, now())) return reply.code(404).send({ error: "Printer not found" });
    const limit = boundedLimit(request.query.limit, 25, 100);
    return { printerId: request.params.id, limit, history: db.getHistory(request.params.id, limit).map(historyEntry) };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/runs", async (request) => {
    const limit = boundedLimit(request.query.limit, 20, 100);
    return { limit, runs: db.getRuns(limit) };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = db.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Collection run not found" });
    return run;
  });

  await app.register(fastifyStatic, {
    root: resolve(options.webRoot ?? "apps/web/public"),
    prefix: "/",
    wildcard: false
  });
  return app;
}
