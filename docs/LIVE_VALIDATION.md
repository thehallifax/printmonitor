# Controlled live validation

The validation harness reads exactly one explicitly supplied target using either `--hostname` or `--ip`. Hostname mode performs one DNS lookup. Explicit-IP mode is diagnostic-only for a printer that lacks usable forward or reverse DNS; it skips DNS and accepts one IPv4 address only. Both modes use the same read-only SNMPv2c GET and subtree operations.

Production inventory supports exactly one hostname or IPv4 target per printer. Hostname fleet targets still require DNS resolution on every collection; IP fleet targets are polled directly. Explicit-IP validation remains a separate single-device diagnostic mode: it is held in memory, does not create or modify inventory, and does not write fleet state.

## Before a test

1. Obtain authorization for the named printer and the machine running the test.
2. Confirm the device credential is read-only.
3. Put the credential in the local environment or ignored `.env`; never place it on the command line.
4. Prefer hostname mode. Use `--ip` only when the authorized device has no usable DNS record.
5. Start with the defaults: a 3-second timeout and one retry. Hard caps are 30 seconds and five retries.

```bash
npm run validate:printer -- --hostname printer.example.edu
```

For a single printer without usable DNS:

```bash
npm run validate:printer -- --ip 172.18.0.19
```

Exactly one of `--hostname` or `--ip` is required. They are mutually exclusive. IPv6, CIDRs, ranges, wildcards, extra positional targets, and multiple devices are rejected.

The command reports target mode, target, DNS resolution or `DNS: skipped`, elapsed time, vendor detection evidence, normalized identity/health/supplies/alerts/counters, collection completeness, and a per-standard-OID status of `succeeded`, `empty`, `unsupported`, or `failed`. It never prints the community.

For a private raw capture, add `--capture`:

```bash
npm run validate:printer -- --hostname printer.example.edu --capture
```

IP mode supports the same flag:

```bash
npm run validate:printer -- --ip 172.18.0.19 --capture
```

The capture includes `targetMode: "hostname"` or `targetMode: "explicit-ip"` and is written with owner-only permissions under `data/private/live-validation/`. The entire `data/private/` tree is ignored by Git. A capture can contain real device identity and must not be shared or committed.

## Failure evidence

- `dns`: hostname resolution failed; SNMP was not attempted.
- `timeout`: no SNMP response arrived within the bounded request window. For SNMPv2c, a wrong community is often intentionally indistinguishable from a timeout.
- `authentication`: an authentication/authorization error was explicitly reported and could be identified.
- `protocol`: the agent returned an SNMP request/protocol error.
- `malformed-response`: the response or expected varbind shape could not be parsed safely.
- `network`: the local network stack reported a socket or reachability failure.
- `partial-response`: some useful standard evidence was returned while one or more optional reads failed or were unavailable. The printer remains reachable and the issue is preserved in provenance.

## Convert a capture to a fixture

Never copy a raw capture directly into `test/fixtures`.

1. Review the private capture and list every customer/organization name that may occur inside free-form printer strings.
2. Run the sanitizer with a supported vendor, a non-identifying case name, and one `--redact` argument for every organization-specific value:

```bash
npm run fixture:sanitize -- \
  --input data/private/live-validation/capture-YYYY-MM-DD.json \
  --vendor ricoh \
  --name model-family-supply-case \
  --redact "Example Organisation" \
  --redact "example.edu"
```

3. Manually inspect the generated JSON. The helper replaces structured hostname, IP, serial, inventory, display-name, location, MAC, email, domain, and credential fields, plus the explicitly supplied redactions. It preserves OID keys, enterprise OIDs, model-family text, numeric values, and table indexes.
4. Search the result for real host/domain/IP/serial/MAC/organization fragments. Delete the candidate if review fails; fix the sanitizer or add redactions and regenerate with a new name.
5. Add a deterministic regression test that loads the sanitized fixture and states the observed discrepancy.

Prepared directories exist for Ricoh, Canon, Konica Minolta, Kyocera, and FUJIFILM. Reviewed sanitized live fixtures now cover FUJIFILM through the generic standard-MIB path and multiple Konica Minolta i-Series models through enterprise-OID adapter detection with standard-MIB collection. Konica validation spans 13–20 supplies, developer units, staple/finisher supplies, sleep, empty alert tables, low-toner warnings, and standard lifetime page counts. Do not add private OIDs until a reviewed fixture shows the standard MIB is insufficient and the private OID is documented with confidence.

## Anonymized validation matrix

| Vendor | Model | Validation path | Adapter | Fixture |
|---|---|---|---|---|
| FUJIFILM | Apeos C3567 | explicit-ip | generic | yes |
| Konica Minolta | bizhub C3321i | explicit-ip | konica-minolta | yes |
| Konica Minolta | bizhub C301i | explicit-ip | konica-minolta | yes |
| Konica Minolta | bizhub C451i | explicit-ip | konica-minolta | yes |
| Konica Minolta | bizhub C251i | explicit-ip | konica-minolta | yes |
| Ricoh | pending | hostname | pending | no |
| Canon | pending | hostname | pending | no |
| Kyocera | pending | hostname | pending | no |
