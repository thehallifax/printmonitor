import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import YAML from "yaml";
import { z } from "zod";

const hostname = z.string().trim().min(1).max(253).refine(
  (value) => isIP(value) === 0 && !value.includes("/") && !/^[0-9.*?/-]+$/.test(value) && /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value),
  "must be a DNS hostname, not an IP address"
);
const ip = z.string().trim().refine((value) => isIP(value) > 0 && !value.includes("/"), "must be one IP address literal; CIDRs and ranges are not allowed");

const identifier = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "must use lowercase letters, digits, and hyphens");

export const inventorySchema = z.object({
  site: z.object({ id: identifier, name: z.string().trim().min(1) }).strict().optional().default({ id: "default", name: "Default Site" }),
  printers: z.array(z.object({
    id: identifier,
    hostname: hostname.optional(),
    ip: ip.optional(),
    displayName: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1).optional(),
    enabled: z.boolean().default(true)
}).strict()).min(1)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const targets = new Set<string>();
  value.printers.forEach((printer, index) => {
    if (ids.has(printer.id)) context.addIssue({ code: "custom", path: ["printers", index, "id"], message: "duplicate printer id" });
    ids.add(printer.id);
    if (Boolean(printer.hostname) === Boolean(printer.ip)) context.addIssue({ code: "custom", path: ["printers", index], message: "exactly one of hostname or ip is required" });
    const key = printer.hostname ? `hostname:${printer.hostname.toLowerCase()}` : printer.ip ? `ip:${printer.ip}` : undefined;
    if (key && targets.has(key)) context.addIssue({ code: "custom", path: ["printers", index, printer.hostname ? "hostname" : "ip"], message: printer.hostname ? "duplicate canonical hostname" : "duplicate connection target" });
    if (key) targets.add(key);
  });
});

export type InventoryConfig = z.infer<typeof inventorySchema>;
export type InventoryPrinter = Omit<InventoryConfig["printers"][number], "id" | "displayName"> & { inventoryId: string; siteId: string; displayName: string; targetType: "hostname" | "ip"; targetValue: string };

export function validateExplicitHostname(value: string): string {
  const result = hostname.safeParse(value);
  if (!result.success) throw new Error("--hostname must be one explicit DNS hostname; IP addresses, CIDRs, and ranges are not allowed");
  return result.data;
}

export function parseInventory(source: string): { site: InventoryConfig["site"]; printers: InventoryPrinter[] } {
  let parsed: unknown;
  try { parsed = YAML.parse(source); } catch (error) { throw new Error(`Inventory YAML is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const result = inventorySchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "inventory"}: ${issue.message}`).join("; ");
    throw new Error(`Inventory validation failed: ${details}`);
  }
  return {
    site: result.data.site,
    printers: result.data.printers.map((printer) => ({
      ...(printer.hostname ? { hostname: printer.hostname.toLowerCase() } : { ip: printer.ip }),
      targetType: printer.hostname ? "hostname" : "ip",
      targetValue: (printer.hostname ?? printer.ip)!,
      displayName: printer.displayName ?? "",
      location: printer.location,
      enabled: printer.enabled,
      inventoryId: printer.id,
      siteId: result.data.site.id
    }))
  };
}

export async function loadInventory(path: string): Promise<ReturnType<typeof parseInventory>> {
  try { return parseInventory(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Unable to load inventory from ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
