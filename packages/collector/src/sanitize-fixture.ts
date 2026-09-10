import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sanitizeCapture } from "./fixture-sanitizer.js";
type FixtureVendor = "ricoh" | "canon" | "konica-minolta" | "kyocera" | "fujifilm";

interface Arguments { input: string; vendor: FixtureVendor; name: string; redactions: string[]; }
const vendors = new Set<FixtureVendor>(["ricoh", "canon", "konica-minolta", "kyocera", "fujifilm"]);

function parseArguments(args: string[]): Arguments {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1]) throw new Error(`${flag} is required`);
    return args[index + 1]!;
  };
  const vendor = value("--vendor");
  if (!vendors.has(vendor as FixtureVendor)) throw new Error("--vendor must be ricoh, canon, konica-minolta, kyocera, or fujifilm");
  const name = value("--name");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error("--name must contain 2-64 lowercase letters, digits, or hyphens");
  const redactions = args.flatMap((item, index) => item === "--redact" && args[index + 1] ? [args[index + 1]!] : []);
  return { input: value("--input"), vendor: vendor as FixtureVendor, name, redactions };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const capture = JSON.parse(await readFile(resolve(args.input), "utf8")) as Record<string, unknown>;
  const fixture = sanitizeCapture(capture, args.redactions);
  const directory = resolve(`packages/collector/test/fixtures/${args.vendor}`);
  const output = resolve(directory, `${args.name}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(`Sanitized fixture written: ${output}`);
  console.log("Manual review is still required before committing the fixture or deriving regression assertions.");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
