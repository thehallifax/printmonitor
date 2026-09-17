import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../..");
const windowsScripts = resolve(projectRoot, "scripts/windows");
const lifecycleNames = ["install", "start", "stop", "restart", "status", "update", "uninstall", "run"];
const allScriptNames = ["common", "service-host", ...lifecycleNames];
const script = (name: string): string => readFileSync(resolve(windowsScripts, `${name}.ps1`), "utf8");

describe("Windows deployment contracts", () => {
  it("provides the complete native Windows lifecycle", () => {
    for (const name of allScriptNames) expect(existsSync(resolve(windowsScripts, `${name}.ps1`)), name).toBe(true);
    for (const name of lifecycleNames) {
      const content = script(name);
      expect(content).toContain("common.ps1");
      expect(content).toContain("Assert-WindowsHost");
    }
  });

  it("uses a lower-privilege native service account with boot tasks and failure restart", () => {
    const install = script("install");
    expect(install).toContain("New-ScheduledTaskTrigger -AtStartup");
    expect(install).toContain("-LogonType ServiceAccount -RunLevel Limited");
    expect(script("common")).toContain(String.raw`NT AUTHORITY\NETWORK SERVICE`);
    expect(install).toContain("-RestartCount 999");
    expect(install).toContain("-MultipleInstances IgnoreNew");
    expect(install).not.toMatch(/LocalSystem|SYSTEM_ACCOUNT|nssm|pm2/i);
    expect(install).toContain("service-host.ps1");
    expect(install).not.toContain("SNMP_COMMUNITY=");
  });

  it("makes stop disable supervision and start explicitly restore it", () => {
    const common = script("common");
    expect(common).toContain("Disable-ScheduledTask");
    expect(common).toContain("Stop-ScheduledTask");
    expect(common).toContain("Enable-ScheduledTask");
    expect(common).toContain("Start-ScheduledTask");
    expect(common).toContain("taskkill.exe /PID $hostPid /T /F");
  });

  it("keeps credentials out of task definitions and loads project configuration at runtime", () => {
    const install = script("install");
    const host = script("service-host");
    expect(install).toContain("Protect-EnvironmentFile");
    expect(install).toContain("Grant-ServiceFilesystemAccess");
    expect(install).toContain("-NodeExecutable");
    expect(host).toContain("scripts\\service-entry.mjs");
    expect(host).toContain("data\\log");
    expect(host).toContain("$env:ComSpec /d /s /c");
    expect(host).not.toContain("SNMP_COMMUNITY");
  });

  it("requires an explicit firewall decision for non-loopback listeners", () => {
    const install = script("install");
    expect(install).toContain("Test-LoopbackHost");
    expect(install).toContain("-AllowInboundFirewall");
    expect(install).toContain("-ExternalFirewallManaged");
    expect(install).toContain("-Profile Domain,Private");
    expect(install).toContain("-Protocol TCP");
    expect(install).toContain("-LocalPort");
    expect(script("uninstall")).toContain("-DisplayName $script:FirewallRuleName");
  });

  it("keeps update validation before the service restart boundary", () => {
    const update = script("update");
    const pull = update.indexOf("pull --ff-only");
    const install = update.indexOf('@("ci")');
    const build = update.indexOf('@("run", "build")');
    const tests = update.indexOf('@("test")');
    const restart = update.indexOf("Stop-MonitorTasks");
    expect(Math.min(pull, install, build, tests, restart)).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(install);
    expect(install).toBeLessThan(build);
    expect(build).toBeLessThan(tests);
    expect(tests).toBeLessThan(restart);
    expect(update).toContain("--untracked-files=no");
    expect(update).toContain("Invoke-RestMethod");
    expect(update).not.toMatch(/reset\s+--hard|git\s+clean|git\s+stash/i);
  });

  it("preserves operator state during uninstall", () => {
    const uninstall = script("uninstall");
    expect(uninstall).toContain("Unregister-ScheduledTask");
    expect(uninstall).toContain("Preserved: .env");
    expect(uninstall).not.toMatch(/Remove-Item[^\n]*(\.env|inventory\.yaml|\.sqlite|data\\log|data\\private)/i);
  });
});

const powerShell = ["pwsh", "powershell.exe", "powershell"].find((command) => spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" }).status === 0);
describe.runIf(Boolean(powerShell))("PowerShell parser", () => {
  it.each(allScriptNames)("parses %s.ps1 without syntax errors", (name) => {
    const path = resolve(windowsScripts, `${name}.ps1`);
    const escapedPath = path.replaceAll("'", "''");
    const command = `$path='${escapedPath}'; $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1}`;
    const result = spawnSync(powerShell!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
