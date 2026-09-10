# Vendor fixtures

Only sanitized, reviewed captures belong here. Each vendor directory is ready for model-family regression cases; no private enterprise OIDs are assumed.

Fixtures should retain the standard OIDs, table indexes, supply/alert values, vendor detection signals, and only the minimum model-family text needed to reproduce behavior. They must not contain real hostnames, domains, routable IP addresses, serial numbers, MAC addresses, credentials, organization names, or locations.

`fujifilm/apeos-c3567-standard-mib.json` is the first fixture derived from an authorized live capture. It is deliberately limited to sanitized raw standard-MIB parser inputs and expected collection metadata; it does not imply a FUJIFILM vendor adapter or private-OID support.

`konica-minolta/bizhub-c3321i-standard-mib.json` validates enterprise-OID adapter detection and standard-MIB normalization for the bizhub C3321i. It contains no private enterprise-OID reads.

The additional Konica Minolta fixtures are intentionally non-redundant: C301i covers sleep plus developer and finisher supplies, C451i covers successful empty alert tables and the 20-supply shape, and C251i covers low-toner warning semantics. A second zero-alert C301i capture was reviewed but not retained because the C451i fixture covers that behavior.
