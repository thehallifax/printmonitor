# Printer Fleet Monitor

Printer Fleet Monitor is a vendor-neutral, read-only monitoring foundation for network printers and multifunction devices. A background collector resolves configured hostnames, reads standard SNMP MIBs, normalizes the evidence, and writes observations to SQLite. The Fastify API and browser dashboard read only that stored state; opening the dashboard never contacts a printer.

## Current scope

- Hostname-only YAML inventory with schema validation and deterministic inventory IDs
- DNS resolution at collection time, including the resolved address in telemetry
- Generic SNMPv2c collector using SNMPv2-MIB, HOST-RESOURCES-MIB, and Printer-MIB
- Manufacturer detection for Ricoh, Canon, Konica Minolta, and Kyocera behind an adapter registry
- Conservative generic identity normalization for a validated FUJIFILM manufacturer signal
- Shared normalized TypeScript contracts for identity, reachability, health, alerts, supplies, and counters
- Append-only observations plus a materialized latest-state table in SQLite
- Stored-state Fastify API and responsive dependency-free dashboard
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

The API is a separate process and never initiates collection. In production, run the collector and API as separate supervised services.

## API

- `GET /api/health` — service liveness only
- `GET /api/fleet` — fleet summary and current printer state
- `GET /api/printers` — current stored printer states
- `GET /api/printers/:id` — one current stored printer state, or 404

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
- Collection reachability means a successful SNMP response, not independent ICMP/TCP reachability.
- No authentication, notifications, network discovery, SNMP traps, or multi-site control plane yet.
- One SQLite database is appropriate for the initial single-node deployment, not concurrent writers on multiple hosts.

## Milestone 2 validation workflow

Use the one-host validation harness only for an explicitly authorized printer, capture diagnostics only when needed, sanitize the private capture, and turn each observed discrepancy into a reviewed vendor fixture and deterministic regression test. Central site-agent architecture and private vendor OIDs remain deferred.

The first sanitized live fixture covers a FUJIFILM Apeos C3567 through the generic standard-MIB path. It validates identity, toner, drums, maintenance supplies, one alert, and a lifetime counter without introducing a FUJIFILM adapter or private enterprise-OID reads.

A second sanitized fixture covers a Konica Minolta bizhub C3321i. Enterprise OID `18334` selects the existing adapter, while standard MIBs provide toner, imaging units, waste toner, fuser and transfer components, an alert, and the total counter. No private Konica Minolta OIDs are queried.
