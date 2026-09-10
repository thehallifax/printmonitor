import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import type { HostResolver } from "./dns.js";
import { validateExplicitHostname } from "./inventory.js";

export type ValidationTarget =
  | { mode: "hostname"; hostname: string }
  | { mode: "explicit-ip"; ip: string };

export interface ValidationArguments {
  target: ValidationTarget;
  capture: boolean;
}

export const VALIDATION_USAGE = "Usage: npm run validate:printer -- (--hostname <printer-hostname> | --ip <IPv4-address>) [--capture]";

export interface ResolvedValidationTarget {
  address: string;
  family: number;
  dns: "resolved" | "skipped";
}

export function validateExplicitIpv4(value: string): string {
  if (isIP(value) !== 4) throw new Error("--ip must be one explicit IPv4 address; IPv6, CIDRs, ranges, and wildcards are not allowed");
  return value;
}

export function parseValidationArguments(args: string[]): ValidationArguments {
  const targets: ValidationTarget[] = [];
  let capture = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--capture") {
      if (capture) throw new Error("--capture may only be supplied once");
      capture = true;
      continue;
    }
    if (argument === "--hostname" || argument === "--ip") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires one value`);
      targets.push(argument === "--hostname"
        ? { mode: "hostname", hostname: validateExplicitHostname(value) }
        : { mode: "explicit-ip", ip: validateExplicitIpv4(value) });
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    throw new Error("Unexpected positional input; validation accepts only one explicit target");
  }

  if (targets.length !== 1) throw new Error("Exactly one of --hostname or --ip must be supplied");
  return { target: targets[0]!, capture };
}

export async function resolveValidationTarget(target: ValidationTarget, resolver: HostResolver = dns.lookup): Promise<ResolvedValidationTarget> {
  if (target.mode === "explicit-ip") return { address: target.ip, family: 4, dns: "skipped" };
  const resolved = await resolver(target.hostname);
  return { ...resolved, dns: "resolved" };
}
