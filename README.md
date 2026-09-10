# Printer Fleet Monitor

Printer Fleet Monitor is a vendor-neutral, read-only monitoring foundation for network printers and multifunction devices. A background collector resolves configured hostnames, reads standard SNMP MIBs, normalizes the evidence, and writes observations to SQLite. The Fastify API and browser dashboard read only that stored state; opening the dashboard never contacts a printer.

## Current scope

- Hostname-only YAML inventory with explicit stable printer IDs and early schema validation
- DNS resolution at collection time, including the resolved address in telemetry
- Generic SNMPv2c collector using SNMPv2-MIB, HOST-RESOURCES-MIB, and Printer-MIB
- Manufacturer detection for Ricoh, Canon, Konica Minolta, and Kyocera behind an adapter registry
- Conservative generic identity normalization for a validated FUJIFILM manufacturer signal
- Shared normalized TypeScript contracts for identity, reachability, health, alerts, supplies, and counters
- A persistent configured-printer catalogue, append-only observations, and a materialized latest-state table in SQLite
- Explicit `pending` state for active printers that have never been collected
- Stored-state Fastify API with filtering/history and a responsive dependency-free fleet/detail dashboard
- Deterministic tests with mocks/fixtures only
- Controlled one-host live-validation harness with optional private captures
- Typed per-OID and failure evidence plus fixture sanitization tooling

No device-changing operation is implemented. In particular, the codebase contains no SNMP SET call.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- Network/DNS access to devices only when intentionally running the live collector

## Quick start with fictional data

```bash
npm install
npm run build
npm run demo:seed
npm start
```

Open <http://127.0.0.1:3000>. The demo uses reserved `.invalid` hostnames and RFC 5737 documentation addresses; it never queries the network.

For development with reload:

```bash
npm run dev
```

## Run the collector

Copy `.env.example` to `.env`, create a local inventory based on `config/inventory.example.yaml`, and set the community to a read-only credential. Keep both files out of source control if they contain site data or secrets.

```bash
npm run collect             # one collection cycle
npm run collect -- --watch  # repeat using POLL_INTERVAL_SECONDS
```

The API is a separate process and never initiates collection. In production, run one collector and one API/web process as separate supervised services sharing the same local SQLite database. Multiple simultaneous collectors are not supported.

Each inventory printer requires a stable lowercase `id` and DNS `hostname`. `displayName`, `location`, and `enabled` are optional; display name defaults to the canonical lowercase hostname and enabled defaults to true. The top-level site defaults to `default` when omitted. IDs and canonical hostnames must be unique, IP literals are rejected, and disabled entries remain stored but are not polled or treated as active failures. Entries removed during reconciliation are marked unconfigured rather than deleted, preserving history by stable ID. SNMP credentials belong only in the environment.

Inventory reconciliation happens before collection. An active entry with no observation is returned as `operationalState: "pending"`, with unknown health, null reachability/provenance/collection time, empty telemetry, and `isStale: false`. A failed first attempt transitions it to offline with no successful-seen timestamp; failure after a success preserves last-known data and last-seen evidence.

```yaml
site: { id: example-campus, name: Example Campus }
printers:
  - id: example-campus-library
    hostname: printer-library.example.invalid
    displayName: Library Printer
    location: Library
    enabled: true
```

Watch mode collects immediately, waits for completion, then schedules the next run using `POLL_INTERVAL_SECONDS`. This completion-based timer and a process-local run guard prevent overlapping cycles.

## API

- `GET /api/health` — API, database, and persisted collector heartbeat/run/next-poll status
- `GET /api/fleet` — fleet summary and current printer state
- `GET /api/printers` — current catalogue-backed states with `search`, `site`, `location`, `health`, `state`, `reachable`, and `stale` filters
- `GET /api/printers/:id` — one current stored printer state, or 404
- `GET /api/printers/:id/history?limit=25` — bounded recent history, capped at 100
- `GET /api/runs` and `GET /api/runs/:id` — recent stored collection-run diagnostics

Stale state is independent of reachability and health. A state becomes stale when its latest attempt is older than `max(2 × POLL_INTERVAL_SECONDS, 300 seconds)`. The API exposes `isStale`, `staleSince`, and `ageSeconds`; it never changes stale data into critical health.

The collector writes a heartbeat every 15 seconds. The API reports it as running only while the newest heartbeat is at most 45 seconds old; older unclosed rows are `stale`, and abandoned current-run/next-poll fields are not presented as active. Watch mode persists `nextScheduledRunAt` after each completed cycle.

## Dashboard

The dashboard is a dense, responsive fleet-at-a-glance view over canonically ordered stored state. It shows normal K/C/M/Y toner levels, concise maintenance and alert summaries, page counts, freshness, and immediate offline/health state. Cards open Printer Detail, which is the investigation surface for complete supplies, alerts, counters, timestamps, failure evidence, and history.

Toner and ink use K/C/M/Y tiles in canonical black, cyan, magenta, and yellow order. Separate amber and red surrounding treatments indicate low and near-empty UI attention states, with text and accessible labels so meaning does not depend on colour. Missing or non-derivable percentages display as unknown (`—`), never as 0%. Site remains part of the backend contract but is intentionally omitted from the current single-site presentation. Missing locations render no placeholder.

Fleet summary metrics are keyboard-accessible filters. State metrics synchronize with the State selector; Reachable, Low supplies, and Stale remain independent predicates. Counts continue to describe the current search context rather than collapsing to the selected metric. Clear Filters resets search and fleet predicates.

## Commands

```bash
npm test          # build, then run deterministic tests
npm run build     # compile every TypeScript workspace
npm run typecheck # project-reference typecheck
npm run demo:seed # write fictional local records
npm run dev       # run API and dashboard with reload
npm start         # run compiled API and dashboard
npm run validate:printer -- --hostname <name> # one authorized read-only target
npm run validate:printer -- --ip <IPv4>       # diagnostic-only; skips DNS
```

See [Architecture](docs/ARCHITECTURE.md), [SNMP behavior](docs/SNMP.md), [controlled live validation](docs/LIVE_VALIDATION.md), and [Development](docs/DEVELOPMENT.md).

## Current limitations

- SNMPv2c only; credentials are process-level configuration rather than a secret-store integration.
- Generic standard-MIB collection only. Vendor adapters can augment normalized fields but currently identify and label vendors without querying private enterprise OIDs.
- Printer alert descriptions are best-effort because implementations vary across devices.
- Mono/colour page counters are not yet available through the generic collection path.
- Collection reachability means a successful SNMP response, not independent ICMP/TCP reachability.
- No authentication, notifications, network discovery, SNMP traps, or multi-site control plane yet.
- One SQLite database is appropriate for the initial single-node deployment, not concurrent writers on multiple hosts.

## Milestone 2 validation workflow

Use the one-host validation harness only for an explicitly authorized printer, capture diagnostics only when needed, sanitize the private capture, and turn each observed discrepancy into a reviewed vendor fixture and deterministic regression test. Central site-agent architecture and private vendor OIDs remain deferred.

The first sanitized live fixture covers a FUJIFILM Apeos C3567 through the generic standard-MIB path. It validates identity, toner, drums, maintenance supplies, one alert, and a lifetime counter without introducing a FUJIFILM adapter or private enterprise-OID reads.

A second sanitized fixture covers a Konica Minolta bizhub C3321i. Enterprise OID `18334` selects the existing adapter, while standard MIBs provide toner, imaging units, waste toner, fuser and transfer components, an alert, and the total counter. No private Konica Minolta OIDs are queried.

Further sanitized Konica Minolta fixtures cover the bizhub C301i, C451i, and C251i, including empty optional alert tables, sleep, developer and finisher supplies, and low-toner warning behavior. Optional tables that are empty or explicitly unsupported no longer make an otherwise successful collection partial.
