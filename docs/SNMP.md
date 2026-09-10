# SNMP collection

## Supported protocol

The current collector supports SNMPv2c. The community is supplied through `SNMP_COMMUNITY`; it is never sent to the browser, stored in observations, or written to validation output. Configure the same value as read-only on each device. SNMPv3 is intentionally deferred.

Every device is configured by hostname. Before each cycle the collector calls DNS and records the resolved address. A DNS error produces an offline observation with the resolver error code. A successful DNS lookup followed by an SNMP timeout records the resolved address and an SNMP failure reason.

## Standard OIDs

| MIB | Symbol | OID | Use |
|---|---|---|---|
| SNMPv2-MIB | `sysDescr.0` | `1.3.6.1.2.1.1.1.0` | Model/vendor evidence |
| SNMPv2-MIB | `sysObjectID.0` | `1.3.6.1.2.1.1.2.0` | Enterprise/vendor detection |
| SNMPv2-MIB | `sysUpTime.0` | `1.3.6.1.2.1.1.3.0` | Raw uptime evidence |
| SNMPv2-MIB | `sysName.0` | `1.3.6.1.2.1.1.5.0` | Name fallback evidence |
| HOST-RESOURCES-MIB | `hrDeviceDescr` | `1.3.6.1.2.1.25.3.2.1.3` | Device/model description |
| HOST-RESOURCES-MIB | `hrPrinterStatus` | `1.3.6.1.2.1.25.3.5.1.1` | Printer status evidence |
| HOST-RESOURCES-MIB | `hrPrinterDetectedErrorState` | `1.3.6.1.2.1.25.3.5.1.2` | Error-state evidence |
| Printer-MIB | `prtGeneralPrinterStatus` | `1.3.6.1.2.1.43.5.1.1.6.1` | Overall status evidence |
| Printer-MIB | `prtGeneralPrinterName` | `1.3.6.1.2.1.43.5.1.1.16.1` | Printer name evidence |
| Printer-MIB | `prtGeneralSerialNumber` | `1.3.6.1.2.1.43.5.1.1.17.1` | Serial number |
| Printer-MIB | `prtMarkerLifeCount` | `1.3.6.1.2.1.43.10.2.1.4` | Lifetime counter |
| Printer-MIB | `prtMarkerSuppliesClass` | `1.3.6.1.2.1.43.11.1.1.4` | Consumed supply vs filled receptacle |
| Printer-MIB | `prtMarkerSuppliesType` | `1.3.6.1.2.1.43.11.1.1.5` | Supply type evidence |
| Printer-MIB | `prtMarkerSuppliesDescription` | `1.3.6.1.2.1.43.11.1.1.6` | Supply label/colour |
| Printer-MIB | `prtMarkerSuppliesSupplyUnit` | `1.3.6.1.2.1.43.11.1.1.7` | Unit and percentage semantics |
| Printer-MIB | `prtMarkerSuppliesMaxCapacity` | `1.3.6.1.2.1.43.11.1.1.8` | Percentage denominator |
| Printer-MIB | `prtMarkerSuppliesLevel` | `1.3.6.1.2.1.43.11.1.1.9` | Percentage numerator |
| Printer-MIB | `prtAlertSeverityLevel` | `1.3.6.1.2.1.43.18.1.1.2` | Alert severity |
| Printer-MIB | `prtAlertCode` | `1.3.6.1.2.1.43.18.1.1.7` | Alert code |
| Printer-MIB | `prtAlertDescription` | `1.3.6.1.2.1.43.18.1.1.8` | Alert text when implemented |

Unsupported or error varbinds are ignored while other returned evidence is retained. Table walks are independent, so failure of one optional table does not discard successful tables. Per-OID evidence distinguishes a populated successful read (`succeeded`), a successful walk with no rows (`empty`), an explicit SNMP unsupported/not-implemented varbind (`unsupported`), and a transport, protocol, or malformed-response failure (`failed`). Empty and unsupported optional tables do not make an otherwise successful collection partial; failed reads still do.

### Supply semantics

The collector also reads `prtMarkerSuppliesClass` (`...43.11.1.1.4`) and `prtMarkerSuppliesSupplyUnit` (`...43.11.1.1.7`). Printer-MIB special values `other(-1)`, `unknown(-2)`, and `partial(-3)` remain raw evidence and never become percentages. A zero maximum is invalid. Unit `percent(19)` can be used directly when its level is 0–100; otherwise a ratio is calculated only for known lifecycle/container types with non-negative current level and positive maximum. Toner, ink, waste-toner/waste-ink receptacles, drums/imaging units, fusers, and transfer units are eligible. Staples and other item-count/finisher supplies retain raw counts without a synthetic percentage.

Waste-container descriptions, units, raw levels, and raw maxima are preserved. No generic UI or health interpretation assumes that a reported percentage means either “remaining capacity” or “percentage full”; that meaning requires validated device-family evidence.

## Vendor adapters

Detection recognizes enterprise roots and descriptive names for Ricoh (`367`), Canon (`1602`), Konica Minolta (`18334`), and Kyocera (`1347`). Adapters own detection signals and a narrow enrichment result: identity overrides plus additive consumables, alerts, counters, and raw evidence. Enrichment is merged over the generic standard observation, so absent vendor data cannot erase standard-MIB results. The current adapters only normalize the manufacturer; they do not query private MIB objects.

A future adapter may declare private OIDs, parse its raw evidence, and improve normalized identity, alerts, or counters. It must not expose vendor-specific structures outside the collector and must never issue SET operations.

## Validated device families

A sanitized FUJIFILM Apeos C3567 capture validates the generic standard-MIB path for manufacturer and model identity, toner and drum percentages, maintenance supplies, an active alert, and a lifetime counter. Generic identity normalization recognizes the FUJIFILM manufacturer signal and removes only an anchored leading manufacturer prefix from the model. No FUJIFILM adapter or private OID read is required.

The same evidence established two conservative supply rules: `Transfer Belt Cleaner` is classified as a transfer component rather than a fuser, and Printer-MIB special values remain raw without a synthesized percentage. Waste-container percentages still have no generic remaining-versus-full interpretation.

A sanitized Konica Minolta bizhub C3321i capture validates enterprise-OID detection through root `18334`. Its generic identity evidence normalizes the model to `bizhub C3321i`, while the existing adapter supplies the canonical manufacturer. Standard MIBs expose toner, imaging units, waste toner, fuser and transfer components, one alert, and the total page count without private Konica Minolta OIDs. `Toner Filter` is treated as a neutral maintenance item rather than toner, while its standards-reported percentage is retained. Mono and colour counters are not yet available through the current generic collection path.

Additional sanitized captures cover the Konica Minolta bizhub C301i, C451i, and C251i across 16–20 reported supplies. The evidence includes developer cartridges, staple and saddle-staple cartridges, sleep, empty alert tables, low-toner notifications, and standard lifetime page counts. A reachable sleeping printer remains healthy. Low or near-empty consumables produce warning-level attention; a percentage alone does not establish that printing is blocked and therefore does not make a device critical. Critical health remains reserved for critical device/Printer-MIB evidence.

See [Controlled live validation](LIVE_VALIDATION.md) for the approved one-host command and capture-to-fixture workflow. The automated tests never require or contact physical hardware.
