import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function statusFixture({ installed, nodeOnPath }: { installed: boolean; nodeOnPath: boolean }) {
  const sourceRoot = resolve(testDirectory, "../../..");
  const root = temporaryDirectory();
  const home = join(root, "home");
  const bin = join(root, "bin");
  const runtimeBin = join(root, "runtime/bin");
  const launchAgents = join(home, "Library/LaunchAgents");
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(bin);
  mkdirSync(runtimeBin, { recursive: true });
  for (const file of ["status.sh", "restart.sh", "update.sh", "project-env.mjs"]) cpSync(join(sourceRoot, "scripts", file), join(root, "scripts", file));
  cpSync(join(sourceRoot, "scripts/lib/common.sh"), join(root, "scripts/lib/common.sh"));
  symlinkSync(join(sourceRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, ".env"), "SNMP_COMMUNITY=never-display-this\nHOST=127.0.0.1\nPORT=3010\n");

  symlinkSync("/usr/bin/awk", join(bin, "awk"));
  symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
  symlinkSync("/usr/bin/mktemp", join(bin, "mktemp"));
  symlinkSync("/bin/cat", join(bin, "cat"));
  symlinkSync("/bin/rm", join(bin, "rm"));
  symlinkSync("/bin/rmdir", join(bin, "rmdir"));
  symlinkSync("/bin/sleep", join(bin, "sleep"));
  if (nodeOnPath) symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(process.execPath, join(runtimeBin, "node"));
  writeExecutable(join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
  writeExecutable(join(bin, "id"), "#!/bin/sh\nif [ \"${1:-}\" = -u ]; then echo 501; else echo fixture; fi\n");
  writeExecutable(join(bin, "launchctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\nif [ \"${1:-}\" = print ] && [ \"${FAKE_SERVICES_INSTALLED:-0}\" = 1 ]; then printf '    state = running\\n    pid = 4321\\n'; exit 0; fi\nif [ \"${1:-}\" = print ]; then exit 1; fi\n");
  writeExecutable(join(bin, "git"), [
    "#!/bin/sh",
    "case \"$*\" in",
    "  'rev-parse --show-toplevel') echo \"$FIXTURE_ROOT\" ;;",
    "  'status --porcelain --untracked-files=no') if [ \"${DIRTY_TRACKED:-0}\" = 1 ]; then echo ' M tracked-file'; fi ;;",
    "  'pull --ff-only') if [ \"${GIT_PULL_FAIL:-0}\" = 1 ]; then echo 'fixture pull failed' >&2; exit 1; fi; echo 'Already up to date.' ;;",
    "  'rev-parse --short HEAD') echo 6a164cd ;;",
    "  *) echo \"unexpected git command: $*\" >&2; exit 2 ;;",
    "esac",
    ""
  ].join("\n"));
  const npmFixture = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_LOG\"\necho \"detail: npm $*\"\nif [ \"$*\" = \"${NPM_FAIL_ON:-never}\" ]; then echo 'fixture npm failure' >&2; exit 1; fi\n";
  writeExecutable(join(runtimeBin, "npm"), npmFixture);
  if (nodeOnPath) writeExecutable(join(bin, "npm"), npmFixture);
  writeExecutable(join(bin, "curl"), "#!/bin/sh\necho '{\"status\":\"ok\"}'\n");
  const plistBuddy = join(bin, "plistbuddy");
  writeExecutable(plistBuddy, "#!/bin/sh\ncase \"${2:-}\" in\n  *ProgramArguments:0*) printf '%s\\n' \"$FIXTURE_NODE\" ;;\n  *EnvironmentVariables:HOST*) echo 127.0.0.1 ;;\n  *EnvironmentVariables:PORT*) echo 3010 ;;\nesac\n");

  if (installed) {
    writeFileSync(join(launchAgents, `${WEB_LABEL}.plist`), "fixture\n");
    writeFileSync(join(launchAgents, `${COLLECTOR_LABEL}.plist`), "fixture\n");
  }

  return {
    root,
    environment: {
      PATH: bin,
      HOME: home,
      PLIST_BUDDY: plistBuddy,
      NODE_FALLBACK_PATHS: join(root, "missing-node"),
      FIXTURE_NODE: join(runtimeBin, "node"),
      FIXTURE_ROOT: root,
      FAKE_SERVICES_INSTALLED: installed ? "1" : "0",
      LAUNCHCTL_LOG: join(root, "launchctl.log"),
      NPM_LOG: join(root, "npm.log")
    }
  };
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

  it("runs status with Node.js available on PATH without revealing secrets", () => {
    const fixture = statusFixture({ installed: false, nodeOnPath: true });
    const result = spawnSync("/bin/sh", [join(fixture.root, "scripts/status.sh")], { encoding: "utf8", env: fixture.environment });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Dashboard: http://127.0.0.1:3010");
    expect(result.stdout + result.stderr).not.toContain("never-display-this");
  });

  it("runs status without Node.js on PATH by using the absolute executable in an installed plist", () => {
    const fixture = statusFixture({ installed: true, nodeOnPath: false });
    const result = spawnSync("/bin/sh", [join(fixture.root, "scripts/status.sh")], { encoding: "utf8", env: fixture.environment });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Web/API: running (pid 4321)");
    expect(result.stdout).toContain("Collector: running (pid 4321)");
    expect(result.stdout).toContain("Dashboard: http://127.0.0.1:3010");
    expect(result.stdout + result.stderr).not.toContain("never-display-this");
  });

  it("reports an actionable error when neither an installed service nor PATH provides Node.js", () => {
    const fixture = statusFixture({ installed: false, nodeOnPath: false });
    const result = spawnSync("/bin/sh", [join(fixture.root, "scripts/status.sh")], { encoding: "utf8", env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to find a Node.js executable");
    expect(result.stderr).toContain("Install Node.js 22.12 or newer");
    expect(result.stderr).not.toContain("command not found");
    expect(result.stdout + result.stderr).not.toContain("never-display-this");
  });

  it("resolves npm beside the selected installed Node.js when npm is absent from PATH", () => {
    const fixture = statusFixture({ installed: true, nodeOnPath: false });
    const probe = "node_path=$(resolve_node_executable) && npm_path=$(resolve_npm_executable \"$node_path\") && printf '%s\\n' \"$npm_path\"";
    const result = spawnSync("/bin/sh", ["-c", `. "${join(fixture.root, "scripts/lib/common.sh")}"; ${probe}`], { encoding: "utf8", env: fixture.environment });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trim()).toBe(join(fixture.root, "runtime/bin/npm"));
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

describe("safe application update", () => {
  function runUpdate(fixture: ReturnType<typeof statusFixture>, options: { args?: string[]; environment?: Record<string, string> } = {}) {
    return spawnSync("/bin/sh", [join(fixture.root, "scripts/update.sh"), ...(options.args ?? [])], {
      encoding: "utf8",
      env: { ...fixture.environment, ...options.environment }
    });
  }

  function launchctlCalls(fixture: ReturnType<typeof statusFixture>): string {
    const path = fixture.environment.LAUNCHCTL_LOG;
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  it("updates successfully with Node.js and npm absent from the interactive PATH", () => {
    const fixture = statusFixture({ installed: true, nodeOnPath: false });
    const result = runUpdate(fixture);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("✓ Updated to 6a164cd");
    expect(result.stdout).toContain("✓ Dependencies installed");
    expect(result.stdout).toContain("✓ Build passed");
    expect(result.stdout).toContain("✓ Tests passed");
    expect(result.stdout).toContain("✓ API healthy");
    expect(result.stdout).toContain("Dashboard: http://127.0.0.1:3010");
    expect(readFileSync(fixture.environment.NPM_LOG, "utf8")).toBe("ci\nrun build\ntest\n");
    expect(result.stdout + result.stderr).not.toContain("never-display-this");
  });

  it("refuses a dirty tracked worktree without pulling, installing, or restarting", () => {
    const fixture = statusFixture({ installed: true, nodeOnPath: false });
    const result = runUpdate(fixture, { environment: { DIRTY_TRACKED: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tracked local changes are present");
    expect(existsSync(fixture.environment.NPM_LOG)).toBe(false);
    expect(launchctlCalls(fixture)).toBe("");
  });

  it("does not restart services when git pull fails", () => {
    const fixture = statusFixture({ installed: true, nodeOnPath: false });
    const result = runUpdate(fixture, { environment: { GIT_PULL_FAIL: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture pull failed");
    expect(result.stderr).toContain("Running services were not restarted");
    expect(launchctlCalls(fixture)).toBe("");
  });

  it.each([
    ["ci", "Dependencies installed"],
    ["run build", "Build passed"],
    ["test", "Tests passed"]
  ])("does not restart services when npm step %s fails", (command, label) => {
    const fixture = statusFixture({ installed: true, nodeOnPath: false });
    const result = runUpdate(fixture, { environment: { NPM_FAIL_ON: command } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Update stopped: ${label} failed`);
    expect(result.stderr).toContain("fixture npm failure");
    expect(launchctlCalls(fixture)).toBe("");
  });

  it("restarts both loaded services only after all safe update steps pass", () => {
    const fixture = statusFixture({ installed: true, nodeOnPath: false });
    const result = runUpdate(fixture);
    const calls = launchctlCalls(fixture);
    expect(result.status).toBe(0);
    expect(calls).toContain(`kickstart -k gui/501/${WEB_LABEL}`);
    expect(calls).toContain(`kickstart -k gui/501/${COLLECTOR_LABEL}`);
    expect(calls).not.toContain("bootout");
  });

  it("keeps normal output concise and reveals captured detail only with --verbose", () => {
    const conciseFixture = statusFixture({ installed: true, nodeOnPath: false });
    const concise = runUpdate(conciseFixture);
    expect(concise.stdout).not.toContain("detail: npm");

    const verboseFixture = statusFixture({ installed: true, nodeOnPath: false });
    const verbose = runUpdate(verboseFixture, { args: ["--verbose"] });
    expect(verbose.status).toBe(0);
    expect(verbose.stdout).toContain("detail: npm ci");
    expect(verbose.stdout).toContain("Already up to date.");
  }, 15_000);
});

describe("deployment shell entry points", () => {
  const root = resolve(testDirectory, "../../..");
  const scripts = ["run.sh", "install.sh", "uninstall.sh", "status.sh", "restart.sh", "update.sh"];

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

  it("restarts loaded jobs with launchctl-native kickstart and does not unload them", () => {
    const restart = readFileSync(join(root, "scripts/restart.sh"), "utf8");
    expect(restart).toContain("launchctl kickstart -k");
    expect(restart).toContain("launchctl bootstrap");
    expect(restart).not.toContain("launchctl bootout");
  });

  it("pins only the reviewed dependency install scripts", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.allowScripts).toEqual({
      "better-sqlite3@13.0.3": true,
      "esbuild@0.28.2": true,
      "fsevents@2.3.3": true
    });
    expect(manifest).not.toHaveProperty("dangerouslyAllowAllScripts");
  });
});
