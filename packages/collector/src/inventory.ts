import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import YAML from "yaml";
import { z } from "zod";

const hostname = z.string().trim().min(1).max(253).refine(
  (value) => isIP(value) === 0 && !value.includes("/") && !/^[0-9.*?/-]+$/.test(value) && /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value),
  "must be a DNS hostname, not an IP address"
);

export const inventorySchema = z.object({
  site: z.object({ id: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]*$/), name: z.string().trim().min(1) }),
  printers: z.array(z.object({
    hostname,
    displayName: z.string().trim().min(1),
    location: z.string().trim().min(1).optional(),
    enabled: z.boolean().default(true)
  })).min(1)
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.printers.forEach((printer, index) => {
    const key = printer.hostname.toLowerCase();
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["printers", index, "hostname"], message: "duplicate hostname" });
    seen.add(key);
  });
});

export type InventoryConfig = z.infer<typeof inventorySchema>;
export type InventoryPrinter = InventoryConfig["printers"][number] & { inventoryId: string; siteId: string };

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
      ...printer,
      inventoryId: `${result.data.site.id}-${createHash("sha256").update(printer.hostname.toLowerCase()).digest("hex").slice(0, 12)}`,
      siteId: result.data.site.id
    }))
  };
}

export async function loadInventory(path: string): Promise<ReturnType<typeof parseInventory>> {
  try { return parseInventory(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Unable to load inventory from ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
