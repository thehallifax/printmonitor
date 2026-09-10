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
```

## Configuration

Copy `.env.example` to `.env` and override values locally:

- `SNMP_COMMUNITY`: required only by the live collector; must be read-only.
- `INVENTORY_PATH`: YAML inventory path.
- `DATABASE_PATH`: SQLite database shared by collector/API processes.
- `POLL_INTERVAL_SECONDS`: interval for collector `--watch` mode.
- `SNMP_TIMEOUT_MS`, `SNMP_RETRIES`: bounded request behavior.
- `COLLECTOR_CONCURRENCY`: maximum printers collected concurrently.
- `HOST`, `PORT`: API listener. The default binds only to loopback.

Do not put site-specific inventory or secrets in tracked files. The included inventory, addresses, communities, manufacturers, and serials are fictional.

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
- Answering device with a critical alert or a supply at 5% or below: `critical`.
- Answering device with a warning alert or a supply at 20% or below: `warning`.
- Answering device with non-problem evidence: `healthy`.
- Answering device without enough health evidence: `unknown`.

Power-save does not create an offline result. Reachability and health remain distinct in the shared contract even though the display prioritizes offline devices.

## Operational shape

Use one collector writer per SQLite database. Run the collector and API under separate process supervisors with the same `DATABASE_PATH`. Back up the database using SQLite-aware tooling. For multiple sites or multiple concurrent writers, move ingestion to a central service rather than placing a SQLite file on shared network storage.
