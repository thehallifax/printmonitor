# Printer Fleet Monitor

Printer Fleet Monitor is a small, vendor-neutral service for monitoring network printers and multifunction devices. A background collector reads configured hostnames over read-only SNMP, normalizes the results, and caches them in SQLite. The Fastify API and browser dashboard read that stored state only: viewing the dashboard never contacts a printer or starts a collection.

![Fleet dashboard populated with fictional demo printers](docs/images/fleet-dashboard.png)

## What it monitors

- Reachability, health, freshness, and never-collected state as separate signals
- Toner/ink and maintenance supplies, including unknown or device-specific raw levels
- Active alerts, total page count, and recent collection history
- Collection completeness, latency, failure evidence, and adapter selection
- A compact fleet overview with searchable/filterable cards and a scroll-contained Printer Detail view

No device-changing operation is implemented. Collection is limited to SNMP GET and subtree reads; there is no SNMP SET path, browser-triggered polling, network scanning, or discovery.

## Architecture

```text
hostname-only inventory
          │
          ▼
background collector ── DNS ── read-only SNMP GET/subtree
          │
          ▼
        SQLite  ◄── Fastify API ◄── browser dashboard
```

Production inventory is hostname-first and DNS resolution is mandatory on every normal collection. Each printer also has a stable inventory ID so metadata can change without losing history. The collector stores append-only observations plus a materialized latest state; failed polls preserve clearly labelled last-known device data without rewriting history.

Reachability answers whether the latest SNMP attempt received a response. Health describes the normalized condition of a responding device (`healthy`, `warning`, `critical`, or `unknown`). Freshness is independent of both. An active printer without any observation is `pending`, not offline.

The supported single-node runtime is one collector writer and one API/web process sharing a local SQLite database. On macOS, launchd supervises them as independent services, so either can restart without coupling its lifecycle to the other. See [Architecture](docs/ARCHITECTURE.md) for the component and storage boundaries.

## Vendor evidence

The generic collector uses SNMPv2-MIB, HOST-RESOURCES-MIB, and Printer-MIB. Vendor adapters normalize standard evidence behind shared contracts; they do not currently add private enterprise-OID queries.

| Vendor | Repository evidence |
| --- | --- |
| Konica Minolta | Sanitized fixture regressions for bizhub C3321i, C301i, C451i, and C251i; enterprise OID `18334` selects the adapter. |
| FUJIFILM | Sanitized Apeos C3567 fixture through the generic standard-MIB path. |
| Ricoh | Enterprise OID `367` adapter-detection and deterministic synthetic coverage. |
| Canon | Enterprise OID `1602` adapter-detection and deterministic synthetic coverage. |
| Kyocera | Enterprise OID `1347`/identity adapter-detection and deterministic synthetic coverage. |

“Fixture” means sanitized evidence committed under `packages/collector/test/fixtures/`; it is not a claim that every model or firmware behaves identically.

## Quick start on macOS

Requirements: Node.js 22.12 or newer and npm 10 or newer.

```bash
git clone https://github.com/thehallifax/printmonitor.git
cd printmonitor
cp .env.example .env
cp config/inventory.example.yaml config/inventory.yaml
# Edit .env and config/inventory.yaml before continuing.
./scripts/install.sh
```

The installer validates configuration, installs locked dependencies, builds the project, and installs separate per-user launchd agents for the API/web process and collector. It is idempotent and never overwrites an existing `.env`, inventory, database, or log. The documented default is <http://127.0.0.1:3010>; installation and status output use the effective `HOST` and `PORT`.

```bash
./scripts/status.sh
./scripts/restart.sh
./scripts/update.sh
./scripts/uninstall.sh
```

`update.sh` performs a fast-forward-only pull, locked dependency install, build, tests, safe service restart, and local API health check. It can reuse the Node installation recorded in launchd and derive its matching npm executable, so a fresh shell does not need NVM initialization. Uninstall removes only the launchd definitions; operator configuration, SQLite data, and logs remain in place. See [Deployment](docs/DEPLOYMENT.md) for service labels, log paths, upgrades, and troubleshooting.

## Foreground mode

Run both the API/web process and collector watch loop in one terminal without installing services:

```bash
npm ci
npm run build
./scripts/run.sh
```

`run.sh` safely parses the repository-root `.env` without shell evaluation, forwards `SIGINT`/`SIGTERM`, and stops the other child if either process exits. Exported environment variables override `.env`, which overrides documented defaults. All supported launch paths resolve relative inventory and database paths from the repository root.

For a UI-only local demo with fictional stored records:

```bash
npm ci
npm run demo:seed
npm run dev
```

The demo uses `.invalid` hostnames, RFC 5737 documentation addresses, and `EXAMPLE-*` serials. It performs no network collection.

## Configuration and inventory

Keep `.env` and `config/inventory.yaml` out of source control: they can contain an SNMP credential and site-identifying data. Use a read-only SNMP community. `INVENTORY_PATH` must point to the operator inventory, not the committed example.

```yaml
site: { id: example-campus, name: Example Campus }
printers:
  - id: example-campus-library
    hostname: printer-library.example.invalid
    displayName: Library Printer
    location: Library
    enabled: true
```

Inventory targets must be DNS hostnames; IP literals, CIDRs, ranges, and wildcards are rejected. The explicit `--ip` live-validation option is diagnostic-only for one authorized device lacking usable DNS and never creates or modifies inventory. SNMP credentials are read from the environment and are not written to launchd plist files.

Important settings are `SNMP_COMMUNITY`, `INVENTORY_PATH`, `DATABASE_PATH`, `POLL_INTERVAL_SECONDS`, `SNMP_TIMEOUT_MS`, `SNMP_RETRIES`, `COLLECTOR_CONCURRENCY`, `HOST`, and `PORT`. See [.env.example](.env.example) and [Development](docs/DEVELOPMENT.md) for bounds and precedence details.

## Dashboard and detail

Fleet cards show priority-ordered operational state, K/C/M/Y levels, concise maintenance and alert summaries, page count, and recency. Summary metrics and the State selector filter the already-loaded stored fleet; dashboard refreshes are API reads, not printer polls.

Printer Detail exposes identity, reachability, health, completeness, all supply evidence, alerts, counters, and bounded recent history. The fictional example below includes toner, imaging-unit, and fuser evidence.

![Printer Detail populated with fictional supply, alert, counter, and history evidence](docs/images/printer-detail.png)

## API

- `GET /api/health` — API, database, and collector runtime status
- `GET /api/fleet` — fleet summary and current printer state
- `GET /api/printers` — current states with search and operational filters
- `GET /api/printers/:id` — one current stored printer state
- `GET /api/printers/:id/history?limit=25` — bounded recent history, capped at 100
- `GET /api/runs` and `GET /api/runs/:id` — collection-run diagnostics

## Useful commands

```bash
npm test
npm run typecheck
npm run build
npm audit
./scripts/update.sh                       # safe installed-service update
npm run collect                         # one intentional collection cycle
npm run collect -- --watch              # background-style watch loop
npm run validate:printer -- --hostname <name>
npm run validate:printer -- --ip <IPv4> # diagnostic-only; DNS is skipped
```

## Security model

- Hostname-only production inventory and mandatory DNS resolution
- Read-only SNMP GET/subtree surface with bounded timeout, retries, and concurrency
- No scanning, discovery, traps, device writes, or browser-to-printer path
- Credentials remain server-side and are excluded from generated service definitions and logs
- Live validation is single-target and explicitly operator initiated; captures stay under ignored `data/private/live-validation/` until sanitized and reviewed

See [SNMP behavior](docs/SNMP.md) and [controlled live validation](docs/LIVE_VALIDATION.md) for the exact collection and fixture workflow.

## Current limitations

- SNMPv2c only; credentials are process-level configuration rather than secret-store integration.
- Standard-MIB collection only; vendor adapters currently normalize/detect rather than query private OIDs.
- Alert descriptions vary by implementation, and mono/colour counters are not yet available through the generic path.
- SNMP response is the reachability signal; there is no independent ICMP/TCP probe.
- No authentication, notifications, network discovery, traps, or multi-site control plane.
- SQLite is intended for one local collector writer, not concurrent writers across hosts.
