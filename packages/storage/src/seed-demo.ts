import { FleetDatabase } from "./index.js";
import { emptyOfflineObservation, type NormalizedHealth, type PrinterObservation } from "@printer-fleet/shared";

const databasePath = process.env.DATABASE_PATH ?? "data/printer-fleet.sqlite";
const db = new FleetDatabase(databasePath);
const site = { id: "example-campus", name: "Example Campus" };
const inventory = [
  { inventoryId: "example-campus-library", siteId: site.id, hostname: "printer-library.example.invalid", displayName: "Library Printer", location: "Library", enabled: true },
  { inventoryId: "example-campus-studio", siteId: site.id, hostname: "printer-studio.example.invalid", displayName: "Studio Colour", location: "Design Studio", enabled: true },
  { inventoryId: "example-campus-office", siteId: site.id, hostname: "printer-office.example.invalid", displayName: "Office Printer", location: "Administration", enabled: true },
  { inventoryId: "example-campus-lab", siteId: site.id, hostname: "printer-lab.example.invalid", displayName: "Lab Printer", location: "Technology Lab", enabled: true },
  { inventoryId: "example-campus-new", siteId: site.id, hostname: "printer-new.example.invalid", displayName: "Newly Configured Printer", location: "Student Services", enabled: true }
];
db.syncInventory(site, inventory);
const now = new Date();
const make = (index: number, health: NormalizedHealth, supplies: number[], alert?: string, at = now): PrinterObservation => ({
  identity: {
    inventoryId: inventory[index]!.inventoryId, hostname: inventory[index]!.hostname, displayName: inventory[index]!.displayName,
    location: inventory[index]!.location, resolvedIp: `192.0.2.${30 + index}`, manufacturer: ["Ricoh", "Canon", "Kyocera", "Konica Minolta"][index],
    model: ["IM C3000", "imageRUNNER ADVANCE", "ECOSYS M3645idn", "bizhub C360i"][index], serialNumber: `EXAMPLE-${index + 1}`
  },
  reachability: { reachable: true, latencyMs: 18 + index * 9, lastAttempt: at.toISOString(), lastSeen: at.toISOString() },
  consumables: supplies.map((level, i) => ({ type: "toner", colour: ["black", "cyan", "magenta", "yellow"][i], description: `${["Black", "Cyan", "Magenta", "Yellow"][i]} toner`, levelPercent: level, rawLevel: level, rawMaximum: 100 })),
  alerts: alert ? [{ severity: health === "critical" ? "critical" : "warning", category: "supplies", message: alert, rawCode: 1104 }] : [],
  counters: { total: 48210 + index * 6210 }, normalizedHealth: health, collectedAt: at.toISOString(),
  provenance: { collector: "printer-fleet-demo", version: "0.1.0", adapter: ["ricoh", "canon", "kyocera", "konica-minolta"][index]!, protocol: "mock", collectionStatus: "complete", rawEvidence: { fixture: true } }
});
const priorOffice = make(2, "healthy", [62], undefined, new Date(now.getTime() - 46 * 60_000));
const observations = [make(0, "healthy", [74, 68, 61, 70]), make(1, "warning", [39, 14, 45, 51], "Cyan toner is low"), priorOffice, make(3, "critical", [4, 35, 31, 28], "Paper path fault")];
for (const observation of observations) db.saveObservation(observation);
db.saveObservation(emptyOfflineObservation({ inventoryId: inventory[2]!.inventoryId, hostname: inventory[2]!.hostname, displayName: inventory[2]!.displayName, location: inventory[2]!.location }, "SNMP request timed out", "snmp-v2c", now.toISOString(), "timeout"));
db.close();
console.log(JSON.stringify({ level: "info", message: "Fictional demo data written", databasePath, printers: observations.length }));
