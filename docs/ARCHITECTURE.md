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
SQLite (observations + latest state) ◄────────┘
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

Multi-site control-plane work remains deliberately deferred. Milestone 2 keeps the existing single-node boundary while validating its parser and adapter behavior against explicitly authorized devices.

## Read-only guarantee

The collector exposes only SNMP read operations: scalar `get` and table `subtree` (GETNEXT/GETBULK behavior provided by the library). No write or device-management API exists. The SNMP community is read from the process environment and should be read-only on the device as a second enforcement layer.

The UI/API process does not import or invoke collector code. This structural separation prevents an HTTP request from synchronously polling a device.

## Reachability and health

Reachability is collection evidence: whether the printer answered the current SNMP collection. Health represents the normalized operational condition when evidence is available. An unreachable printer is shown as `offline`; an answering printer can be `healthy`, `warning`, `critical`, or `unknown`. Sleep or power-save values do not imply offline because an SNMP response proves reachability.

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
- `printers(inventory_id, site_id, hostname, display_name, location, enabled, timestamps)`: validated configured inventory.
- `collection_runs(id, timings, counts, status, error)`: one record per collector cycle.
- `observations(id, inventory_id, run_id, collected_at, reachable, normalized_health, resolved_ip, latency_ms, adapter, observation_json)`: immutable normalized history with raw evidence in JSON.
- `latest_printer_state(inventory_id, observation_id, collected_at, reachable, normalized_health, resolved_ip, observation_json)`: materialized current state for API reads.

Indexes support latest history lookup, run lookup, and fleet health filtering. SQLite WAL mode allows the API to read while the single collector writes.

When an offline observation lacks identity details, storage merges last-known manufacturer, model, serial, resolved address, and last-seen time into the current materialized state. The offline observation remains explicit and its failure evidence is preserved.
