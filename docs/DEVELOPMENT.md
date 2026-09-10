# Development

## Setup

```bash
npm install
npm run build
npm test
```

Node workspace packages compile with TypeScript project references. Tests run under Vitest and import only fixtures, mocks, and temporary SQLite databases.

## Local demo

```bash
npm run demo:seed
npm run dev
```

Browse to <http://127.0.0.1:3000>. The API and static dashboard are served from the same origin. The browser refreshes stored fleet state every minute; this is an API read, not an SNMP poll.

To inspect endpoints:

```bash
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/fleet
curl -s http://127.0.0.1:3000/api/printers
curl -s http://127.0.0.1:3000/api/printers/example-campus-library/history?limit=10
curl -s http://127.0.0.1:3000/api/runs
```

## Configuration

Copy `.env.example` to `.env`, copy `config/inventory.example.yaml` to `config/inventory.yaml`, and override values locally. Supported commands load the project-root `.env` even when their compiled entry point lives in a workspace package. An already-exported environment variable overrides the corresponding `.env` value.

- `SNMP_COMMUNITY`: required only by the live collector; must be read-only.
- `INVENTORY_PATH`: YAML inventory path.
- `DATABASE_PATH`: SQLite database shared by collector/API processes.
- `POLL_INTERVAL_SECONDS`: interval for collector `--watch` mode.
- `SNMP_TIMEOUT_MS`, `SNMP_RETRIES`: bounded request behavior.
- `COLLECTOR_CONCURRENCY`: maximum printers collected concurrently.
- `HOST`, `PORT`: API listener. The application fallback is loopback port 3000; the deployment template uses loopback port 3010.

Do not put site-specific inventory or secrets in tracked files. The included inventory, addresses, communities, manufacturers, and serials are fictional.

`INVENTORY_PATH` must name the operator inventory (`config/inventory.yaml` in the template), not `config/inventory.example.yaml`. This prevents a copied `.env` from silently collecting against the fictional example inventory. Relative paths are anchored by the project working directory, which all service scripts set explicitly.

Safety caps are enforced even when environment values are misconfigured: timeout 100–30,000 ms, retries 0–5, concurrency 1–32, and watch interval 10–86,400 seconds.

## Adding an adapter

1. Add vendor detection evidence and a `VendorAdapter` entry in `packages/collector/src/vendor.ts`.
2. Keep any enterprise OIDs in a vendor-owned module under `packages/collector/src`.
3. Convert values to contracts from `@printer-fleet/shared` before persistence.
4. Store the raw returned OID/value evidence in provenance.
5. Add sanitized fixtures for complete, partial, malformed, sleeping, and alerting responses.
6. Verify that no adapter code exposes SNMP SET or other mutation.

See [Controlled live validation](LIVE_VALIDATION.md) for the capture, sanitization, manual-review, and fixture regression workflow.

## Health rules

- No SNMP response: `offline`.
- Answering device with evidence of an operationally blocking critical condition: `critical`.
- Answering device with a warning alert or a supply at 20% or below: `warning`.
- Answering device with non-problem evidence: `healthy`.
- Answering device without enough health evidence: `unknown`.

Power-save does not create an offline result. Reachability and health remain distinct in the shared contract even though the display prioritizes offline devices.

Freshness is also independent: state is stale only after its latest attempt age exceeds `max(2 × POLL_INTERVAL_SECONDS, 300 seconds)`. An offline poll can be fresh, and a healthy stored observation can be stale.

Inventory synchronization is catalogue reconciliation, not telemetry creation. New active entries appear as `pending`/“Never collected” with null reachability and empty telemetry. The first failed attempt becomes offline/“Never successfully seen”; a failure after success retains last-known evidence. Disabled and removed entries are not active fleet failures, and removal marks `configured=0` rather than deleting observations.

## Operational shape

Use one collector writer per SQLite database. Run the collector and API under separate process supervisors with the same `DATABASE_PATH`. The collector heartbeat is written every 15 seconds and is fresh for 45 seconds; the API reports older unclosed runtime state as stale and does not expose its abandoned current run as active. Watch mode persists the next scheduled poll after a cycle completes. Back up the database using SQLite-aware tooling. Multiple simultaneous collectors are unsupported; for multiple sites or writers, move ingestion to a central service rather than placing SQLite on shared network storage.

Watch mode performs an immediate collection, then waits the configured interval after each completed run. `SIGINT` and `SIGTERM` stop future scheduling, allow an active run to settle, and close the database. Run summaries record configured, attempted, reachable, unreachable, partial, and failed counts.
