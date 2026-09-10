import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configurationSummary, dashboardUrl, DEFAULT_PORT, readProjectEnvironment, resolveProjectPath, validateProjectConfiguration } from "../../../scripts/project-env.mjs";
import { COLLECTOR_LABEL, generateLaunchAgents, WEB_LABEL } from "../../../scripts/generate-launchd.mjs";
import { supervise } from "../../../scripts/process-supervisor.mjs";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "printer-fleet-deployment-"));
  temporaryDirectories.push(path);
  return path;
}
afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("project environment loading", () => {
  it("loads HOST and PORT=3010 directly from the requested repository-root .env", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=do-not-print\nHOST=127.0.0.1\nPORT=3010\n");
    const loaded = readProjectEnvironment(root, {});
    expect(loaded.values).toMatchObject({ HOST: "127.0.0.1", PORT: "3010" });
    expect(configurationSummary(loaded.values)).toEqual(["Listen address: 127.0.0.1:3010", "Dashboard: http://127.0.0.1:3010"]);
  });

  it("loads the project .env, preserves explicit overrides, and resolves project-relative paths", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "config/inventory.yaml"), "site: { id: test, name: Test }\nprinters: []\n");
    writeFileSync(join(root, ".env"), [
      "SNMP_COMMUNITY=test-read-only",
      "INVENTORY_PATH=config/inventory.yaml",
      "DATABASE_PATH=data/fleet.sqlite",
      "POLL_INTERVAL_SECONDS=300",
      "SNMP_TIMEOUT_MS=3000",
      "SNMP_RETRIES=1",
      "COLLECTOR_CONCURRENCY=4",
      "HOST=127.0.0.1",
      "PORT=3010"
    ].join("\n"));

    const loaded = readProjectEnvironment(root, { PORT: "4010" });
    expect(loaded.values.PORT).toBe("4010");
    expect(loaded.values.INVENTORY_PATH).toBe("config/inventory.yaml");
    expect(resolveProjectPath(root, loaded.values.INVENTORY_PATH!)).toBe(join(root, "config/inventory.yaml"));
    expect(dashboardUrl(loaded.values)).toBe("http://127.0.0.1:4010");
    expect((await validateProjectConfiguration(root, { PORT: "4010" }, { validateInventory: false })).errors).toEqual([]);
  });

  it("uses the documented port when PORT is absent", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, ".env"), "HOST=127.0.0.1\n");
    const loaded = readProjectEnvironment(root, {});
    expect(DEFAULT_PORT).toBe("3010");
    expect(loaded.values.PORT).toBe("3010");
    expect(dashboardUrl(loaded.values)).toBe("http://127.0.0.1:3010");
  });

  it("reports a wildcard listen address separately from its safe local dashboard URL", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, ".env"), "HOST=0.0.0.0\nPORT=3010\n");
    const loaded = readProjectEnvironment(root, {});
    expect(configurationSummary(loaded.values)).toEqual(["Listen address: 0.0.0.0:3010", "Dashboard: http://127.0.0.1:3010"]);
  });

  it("powers install/status output from the explicit root without printing the community", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=never-display-this\nHOST=127.0.0.1\nPORT=3010\n");
    const helper = resolve(testDirectory, "../../../scripts/project-env.mjs");
    const described = spawnSync(process.execPath, [helper, "describe", root], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(described).toMatchObject({ status: 0, stderr: "" });
    expect(described.stdout).toBe("Listen address: 127.0.0.1:3010\nDashboard: http://127.0.0.1:3010\n");
    expect(described.stdout).not.toContain("never-display-this");

    const common = readFileSync(resolve(testDirectory, "../../../scripts/lib/common.sh"), "utf8");
    const install = readFileSync(resolve(testDirectory, "../../../scripts/install.sh"), "utf8");
    const status = readFileSync(resolve(testDirectory, "../../../scripts/status.sh"), "utf8");
    expect(common).toContain('project-env.mjs" describe "$PROJECT_ROOT"');
    expect(common).toContain("load_installed_web_address");
    expect(install).toContain("show_effective_configuration");
    expect(status).toContain("show_effective_configuration");
  });

  it.runIf(process.platform === "darwin")("makes install dry-run and status report the repository .env port", () => {
    const sourceRoot = resolve(testDirectory, "../../..");
    const root = temporaryDirectory();
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    mkdirSync(join(root, "home"));
    for (const file of ["install.sh", "status.sh", "project-env.mjs"]) cpSync(join(sourceRoot, "scripts", file), join(root, "scripts", file));
    cpSync(join(sourceRoot, "scripts/lib/common.sh"), join(root, "scripts/lib/common.sh"));
    symlinkSync(join(sourceRoot, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=never-display-this\nHOST=127.0.0.1\nPORT=3010\n");
    const environment = { PATH: process.env.PATH, HOME: join(root, "home") };

    const dryRun = spawnSync("/bin/sh", [join(root, "scripts/install.sh"), "--dry-run"], { encoding: "utf8", env: environment });
    const status = spawnSync("/bin/sh", [join(root, "scripts/status.sh")], { encoding: "utf8", env: environment });
    expect(dryRun.status).toBe(0);
    expect(status.status).toBe(0);
    for (const output of [dryRun.stdout, status.stdout]) {
      expect(output).toContain("Listen address: 127.0.0.1:3010");
      expect(output).toContain("Dashboard: http://127.0.0.1:3010");
      expect(output).not.toContain("never-display-this");
    }

    writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=never-display-this\nHOST=0.0.0.0\nPORT=3010\n");
    const wildcardStatus = spawnSync("/bin/sh", [join(root, "scripts/status.sh")], { encoding: "utf8", env: environment });
    expect(wildcardStatus.stdout).toContain("Listen address: 0.0.0.0:3010");
    expect(wildcardStatus.stdout).toContain("Dashboard: http://127.0.0.1:3010");
  });

  it("rejects example live configuration without revealing its credential", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "config/inventory.example.yaml"), "printers: []\n");
    writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=example-read-only\nINVENTORY_PATH=config/inventory.example.yaml\nDATABASE_PATH=data/fleet.sqlite\nPOLL_INTERVAL_SECONDS=300\nSNMP_TIMEOUT_MS=3000\nSNMP_RETRIES=1\nCOLLECTOR_CONCURRENCY=4\nHOST=127.0.0.1\nPORT=3010\n");
    const result = await validateProjectConfiguration(root, {}, { validateInventory: false });
    expect(result.errors).toContain("SNMP_COMMUNITY still uses the example placeholder");
    expect(result.errors).toContain("INVENTORY_PATH still points to the example inventory");
    expect(result.errors.join(" ")).not.toContain("test-read-only");
  });

  it("does not retain the example inventory as the collector fallback", () => {
    const collector = readFileSync(resolve(testDirectory, "../src/cli.ts"), "utf8");
    expect(collector).toContain('process.env.INVENTORY_PATH ?? "config/inventory.yaml"');
    expect(collector).not.toContain('process.env.INVENTORY_PATH ?? "config/inventory.example.yaml"');
  });
});

describe("launchd definitions", () => {
  it("creates independent absolute-path agents without embedding SNMP credentials", async () => {
    const root = join(temporaryDirectory(), "Print Monitor & Fleet");
    const output = temporaryDirectory();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=never-display-this\nHOST=127.0.0.1\nPORT=3010\nINVENTORY_PATH=config/inventory.yaml\nDATABASE_PATH=data/fleet.sqlite\nPOLL_INTERVAL_SECONDS=300\n");
    const paths = await generateLaunchAgents({ projectRoot: root, nodePath: "/opt/node/bin/node", outputDirectory: output, environment: {} });
    expect(paths.map((path) => path.split("/").pop())).toEqual([`${WEB_LABEL}.plist`, `${COLLECTOR_LABEL}.plist`]);
    const web = readFileSync(paths[0], "utf8");
    const collector = readFileSync(paths[1], "utf8");
    expect(web).toContain("/opt/node/bin/node");
    expect(web).toContain("Print Monitor &amp; Fleet");
    expect(web).toContain("scripts/service-entry.mjs");
    expect(web).toContain("<string>web</string>");
    expect(collector).toContain("scripts/service-entry.mjs");
    expect(collector).toContain("<string>collector</string>");
    expect(web + collector).toContain(`${root}/.env`.replace("&", "&amp;"));
    expect(web + collector).toContain("<key>HOST</key>\n    <string>127.0.0.1</string>");
    expect(web + collector).toContain("<key>PORT</key>\n    <string>3010</string>");
    expect(web + collector).not.toContain("SNMP_COMMUNITY");
    expect(web + collector).toContain("<key>KeepAlive</key>");
    const serviceEntry = readFileSync(resolve(testDirectory, "../../../scripts/service-entry.mjs"), "utf8");
    expect(serviceEntry).toContain("applyProjectEnvironment(projectRoot)");
  });

  it("preserves a non-secret exported override in the installed runtime configuration", async () => {
    const root = temporaryDirectory();
    const output = temporaryDirectory();
    writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=never-display-this\nHOST=127.0.0.1\nPORT=3010\n");
    const [web] = await generateLaunchAgents({ projectRoot: root, nodePath: "/opt/node/bin/node", outputDirectory: output, environment: { PORT: "4010" } });
    const content = readFileSync(web, "utf8");
    expect(content).toContain("<key>PORT</key>\n    <string>4010</string>");
    expect(content).not.toContain("never-display-this");
  });
});

describe("foreground supervision", () => {
  it("stops the remaining child and returns non-zero when either child exits", async () => {
    const root = temporaryDirectory();
    const marker = join(root, "collector-stopped");
    const exitCode = await supervise([
      { name: "web/API", command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 120)"] },
      { name: "collector", command: process.execPath, args: ["-e", "const fs=require('fs'); const marker=process.argv[1]; process.on('SIGTERM',()=>{fs.writeFileSync(marker,'stopped');process.exit(0)}); setInterval(()=>{},1000)", marker] }
    ], { cwd: root, shutdownTimeoutMs: 2000, logger: { error: () => undefined } as Console });
    expect(exitCode).toBe(1);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("deployment shell entry points", () => {
  const root = resolve(testDirectory, "../../..");
  const scripts = ["run.sh", "install.sh", "uninstall.sh", "status.sh", "restart.sh"];

  it.each(scripts)("%s is executable and passes POSIX shell syntax validation", (name) => {
    const path = join(root, "scripts", name);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(spawnSync("/bin/sh", ["-n", path], { encoding: "utf8" })).toMatchObject({ status: 0, stderr: "" });
  });

  it("keeps installers idempotent and operator data outside uninstall removal", () => {
    const install = readFileSync(join(root, "scripts/install.sh"), "utf8");
    const uninstall = readFileSync(join(root, "scripts/uninstall.sh"), "utf8");
    expect(install).toContain('if [ ! -f "$PROJECT_ROOT/config/inventory.yaml" ]');
    expect(install).toContain('if [ ! -f "$PROJECT_ROOT/.env" ]');
    expect(install).toContain("--dry-run");
    expect(uninstall).not.toMatch(/rm[^\n]*(?:\.env|inventory\.yaml|data\/)/);
  });
});
