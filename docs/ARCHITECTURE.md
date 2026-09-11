# Architecture

## Components

```text
Hostname inventory
       │
       ▼
Background collector ── DNS lookup ── read-only SNMP GET/GETNEXT
       │                                      │
       │ normalized contracts + raw evidence │
       ▼                                      │
SQLite (catalogue + observations + runtime) ◄┘
       │
       ├── Fastify API (stored reads only)
       │
       └── Browser dashboard (HTTP API only)
```

The npm workspace separates responsibilities:

- `packages/shared`: vendor-neutral domain contracts and pure normalization helpers.
- `packages/collector`: inventory validation, DNS, generic SNMP reads, vendor detection/adapters, and run orchestration.
- `packages/storage`: migrations and all SQLite access.
- `apps/api`: Fastify routes and static asset hosting.
- `apps/web`: browser-only dashboard assets.

Dependencies point inward: the API and collector use storage/shared; storage uses shared; shared has no infrastructure dependency. Vendor-specific behavior must implement an adapter and return shared contracts before storage or API code sees it.

## Trust boundaries

1. **Inventory/configuration:** operator-managed input. It is validated before use. Fixed IPv4 addresses are rejected so DNS remains authoritative at collection time.
2. **DNS:** untrusted external resolution. Failure becomes an offline observation rather than an application exception. The resolved address is evidence for that collection cycle.
3. **Printer/SNMP:** untrusted network data. Missing and malformed values remain absent; normalization does not invent measurements. Raw varbind evidence is stored with each observation where practical.
4. **SQLite:** the persistence boundary and the only source read by the API. SQL parameters are bound, not interpolated.
5. **HTTP/browser:** no credentials are exposed to the browser. The browser has no path to a printer and cannot start collection.

Multi-site control-plane work remains deliberately deferred. The current product supports a local inventory and one SQLite-backed collector/API deployment while validating parser and adapter behavior against explicitly authorized devices.

## Read-only guarantee

The collector exposes only SNMP read operations: scalar `get` and table `subtree` (GETNEXT/GETBULK behavior provided by the library). No write or device-management API exists. The SNMP community is read from the process environment and should be read-only on the device as a second enforcement layer.

The UI/API process does not import or invoke collector code. This structural separation prevents an HTTP request from synchronously polling a device.

## Reachability and health

Reachability is collection evidence: whether the printer answered the current SNMP collection. Health represents the normalized operational condition when evidence is available. An unreachable printer is shown as `offline`; an answering printer can be `healthy`, `warning`, `critical`, or `unknown`. Sleep or power-save values do not imply offline because an SNMP response proves reachability.

Freshness is a third, independent axis. Stored state is stale when the latest attempt age is greater than `max(2 × the configured poll interval, 300 seconds)`. Staleness is derived at read time, so an application restart immediately identifies old stored data without rewriting observations. It does not change health or reachability.

`pending` is the canonical operational state for an active configured printer without an observation. It contains inventory identity only: reachability, provenance, and collection time are null, telemetry collections are empty, health is unknown, and stale is false. A first failed attempt is offline and has never been successfully seen; a later failure retains prior identity, supplies, counters, and last-seen evidence.

## Normalization

Normalization proceeds in this order:

1. Resolve the configured hostname and copy the current address into identity telemetry.
2. Read generic scalar and table OIDs.
3. Preserve returned OID/value evidence.
4. Detect a vendor from enterprise OID and descriptive strings.
5. Apply narrow adapter enrichment over the standard result; absent enrichment cannot erase standard evidence.
6. Calculate supply percentages only when Printer-MIB type, unit, level, and capacity semantics make the result valid.
7. Derive health from reachability, alerts, and supply thresholds.

Private OIDs must be declared and queried inside their vendor adapter. Storage, API, and UI contracts remain unchanged.

## Database schema

- `schema_migrations(version, applied_at)`: applied migration ledger.
- `sites(id, name, created_at, updated_at)`: site identity for future partitioning.
- `printers(inventory_id, site_id, hostname, display_name, location, enabled, configured, timestamps)`: persistent inventory catalogue. Reconciliation updates mutable metadata by stable ID and marks absent entries unconfigured without deleting history.
- `collection_runs(id, timings, configured/attempted/reachable/unreachable/partial/failed counts, status, error)`: one record per collector cycle.
- `observations(id, inventory_id, run_id, collected_at, reachable, normalized_health, resolved_ip, latency_ms, adapter, observation_json)`: immutable normalized history with raw evidence in JSON.
- `latest_printer_state(inventory_id, observation_id, collected_at, reachable, normalized_health, resolved_ip, observation_json)`: materialized current state for API reads.
- `collector_runtime(instance_id, heartbeat/run/schedule timestamps, watch mode, poll interval, stopped_at)`: lightweight cross-process runtime status; it contains no PID, host identity, or credentials.

Indexes support latest history lookup, run lookup, and fleet health filtering. SQLite WAL mode allows the API to read while the single collector writes.

Every device attempt is inserted unchanged into immutable observation history. When an offline observation lacks identity, supplies, or counters, storage merges the previous successful values only into `latest_printer_state`. The current state therefore shows the failed latest attempt and prior last-seen time alongside clearly marked last-known device data, while the historical failed observation remains unmodified.

Raw observation retention is intentionally unchanged while deployment growth is measured. A five-minute polling interval produces up to 288 observations per active printer per day (2,880 for ten printers), before failed/disabled scheduling effects. Future retention or downsampling should preserve reachability, health, alert, counter, and consumable transitions and keep enough raw evidence for forecasting; it should be based on measured database growth rather than introduced as a presentation shortcut.

## Fleet lifecycle and ordering

The collector synchronizes validated inventory, polls configured and enabled printers with bounded concurrency, and isolates DNS/SNMP failures per device. Watch mode runs immediately and schedules the next cycle only after the previous cycle finishes. A process-local guard rejects an overlapping run against the same database instance, and shutdown waits for an active cycle before closing SQLite. Disabled or removed entries remain queryable by ID but are excluded from the active fleet.

Each collector process generates an ephemeral instance ID, persists startup and run boundaries, heartbeats every 15 seconds, and records the next watch-mode poll. The API treats a heartbeat older than 45 seconds as stale and suppresses abandoned current-run and next-poll claims. The processes remain decoupled; the supported topology is exactly one collector and one API/web process sharing one local SQLite database.

The storage layer applies one canonical order before API delivery: offline, critical, warning, pending, healthy, then unknown. Within a priority group stale entries come first, followed by display name or hostname. The browser preserves this order while grouping and filtering.

The Fastify process imports storage and shared contracts, not the collector. Health, fleet, detail, history, and run endpoints are parameterized stored reads and cannot initiate DNS or SNMP work.

On macOS, production supervision uses two independent per-user launchd agents. Each agent has its own `RunAtLoad`/`KeepAlive` lifecycle, absolute Node entry point, explicit project working directory, and stdout/stderr files under `data/log/`. Both load the same project-root `.env`; service definitions contain only its path, not SNMP credentials. A failure or restart of one agent does not couple the other agent's lifecycle.

The static browser client renders one dense, responsive fleet-at-a-glance grid from the canonically ordered `/api/fleet` response. Cards show normalized K/C/M/Y percentages and concise operational summaries; Printer Detail is the investigation surface for complete supplies, alerts, counters, timestamps, failure evidence, and history. Summary controls filter already-loaded client state, and independent stale and low-supply predicates do not change health. Site remains in API/storage contracts but is omitted from the single-site UI.
