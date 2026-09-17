# Windows deployment

Printer Fleet Monitor supports modern 64-bit Windows through two native Task Scheduler tasks: one for the Fastify Web/API process and one for the collector. This keeps the existing single-collector/SQLite architecture and does not add PM2, NSSM, Docker, or a Windows-specific configuration model.

## Why Task Scheduler

A plain Node.js process does not implement the Windows Service Control Manager protocol, so installing `node.exe` directly as a Windows Service is not reliable. A true Windows Service would require a maintained service-host executable or a third-party wrapper. NSSM adds such a wrapper, while PM2 adds a Node process-manager runtime and its own startup integration. Neither dependency is needed here. An installing-user S4U task was also rejected because Microsoft documents that S4U stores no password but has no network access, which is unsuitable for an SNMP collector.

Task Scheduler is built into supported Windows versions and provides the required at-boot trigger, non-interactive execution, lower-privilege service identity, independent process definitions, restart-on-failure policy, and administrative start/stop controls. The tasks invoke `service-host.ps1`, which records its PID, appends process output to files, and runs the same Node entry points used on macOS. See Microsoft's documentation for [scheduled-task principals](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal), [task restart settings](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset), and [task logon types](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype).

## Supported environment and prerequisites

- Windows 11 x64, or Windows Server 2022/2025 x64 where desktop Task Scheduler and Defender Firewall cmdlets are available
- 64-bit Node.js 22.12 or newer with npm 10 or newer
- Windows PowerShell 5.1 or PowerShell 7
- Git for Windows for `update.ps1`
- A local NTFS checkout; a local SQLite database on the same machine
- Host network policy permitting NetworkService to make outbound DNS and SNMPv2c UDP/161 requests to the explicitly configured printer hostnames or IPv4 addresses

The installer rejects non-Windows, 32-bit Windows, non-x64 Node, and outdated Node/npm versions. `better-sqlite3` provides Windows x64 support for the locked dependency graph; `npm ci` installs its matching binary during installation. The SQLite schema, migrations, foreign-key behavior, and database format are unchanged. Keep one collector task per database and do not place the SQLite file on a network share.

## Configuration

Windows uses the same repository-root `.env` and `config\inventory.yaml` as macOS. Relative `INVENTORY_PATH` and `DATABASE_PATH` values resolve from the repository root because every managed process has that working directory.

```powershell
Copy-Item .env.example .env
Copy-Item config\inventory.example.yaml config\inventory.yaml
notepad .env
notepad config\inventory.yaml
```

Set a read-only SNMP community, replace the fictional inventory, and retain exactly one hostname or IPv4 target per printer. Quote a `DASHBOARD_REDIRECT_URL` containing `#`, for example `DASHBOARD_REDIRECT_URL="http://example.invalid/#printers"`. Installed operation reads `.env` at process start; credentials are not copied into scheduled-task arguments or deployment metadata.

The installer restricts `.env` to the installing account, NetworkService, local Administrators, and LocalSystem using NTFS ACLs. NetworkService receives read/execute access to the checkout and selected Node.js directory, read access to the configured inventory, and modify access to `data` and the configured local database directory. Source files remain read-only to the service identity. Do not later move the repository, Node installation, or external configuration/database paths without rerunning the installer to refresh ACLs and absolute task arguments.

## Install

Open PowerShell as an administrative operator, choose **Run as administrator**, and run:

```powershell
Set-Location 'C:\Printer Fleet Monitor'
& .\scripts\windows\install.ps1
& .\scripts\windows\status.ps1
```

Installation performs `npm ci`, builds the application, validates `.env` and inventory, creates `data\log` and `data\run`, installs or refreshes both tasks, and starts them. Existing `.env`, inventory, SQLite files, logs, and private captures are not replaced. Rerunning the installer is the supported repair/reinstall operation.

Node resolution first reuses the absolute executable recorded by an existing installation, then checks `node.exe` on `PATH`, then the standard machine-wide `Program Files\nodejs` location. npm is resolved beside that Node executable before falling back to `PATH`. The selected Node path is stored in non-secret, administrator-owned deployment metadata and embedded as an absolute task argument; changing Node installations requires rerunning `install.ps1`.

If local execution policy blocks a checked-out script, use a process-scoped invocation rather than weakening machine policy globally:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1
```

## Identity and automatic startup

The root Task Scheduler folder contains `Printer Fleet Monitor - Web API` and `Printer Fleet Monitor - Collector`. Both have an at-startup trigger and run as the built-in `NT AUTHORITY\NETWORK SERVICE` identity with a limited token. They do not run as LocalSystem and no account password is stored in the task definition. Microsoft describes [NetworkService](https://learn.microsoft.com/en-us/windows/security/identity-protection/access-control/local-accounts#network-service) as having minimal local privileges while presenting the computer's identity on the network. That supplies outbound networking for DNS and SNMP without granting LocalSystem authority. Keep the repository, inventory, database, and logs local; authenticated SMB storage is unsupported.

Installation and task-changing lifecycle commands require an elevated PowerShell window. The scheduled processes themselves are non-elevated. `status.ps1` and foreground `run.ps1` do not require elevation when the account can read the checkout and task status.

Each task is configured for one running instance, starts at boot even without an interactive session, and retries one minute after an unexpected non-zero exit. `stop.ps1` disables tasks before stopping them, which prevents restart policy or a reboot from relaunching them until `start.ps1` is used.

## Firewall behavior

`HOST=127.0.0.1`, `HOST=::1`, and `HOST=localhost` need no inbound rule, and the installer removes any stale Printer Fleet Monitor-managed rule when returning to loopback.

For a non-loopback listener, installation requires one explicit choice:

```powershell
# Create a Printer Fleet Monitor-owned TCP rule for the configured port,
# restricted to the selected node.exe and Domain/Private profiles.
& .\scripts\windows\install.ps1 -AllowInboundFirewall

# A separate firewall/control plane owns access. No application rule is created.
& .\scripts\windows\install.ps1 -ExternalFirewallManaged
```

The managed rule never enables all ports, all programs, or the Public profile. A specific IP listener is used as the rule's local-address scope; wildcard or hostname listeners use `Any` local address because Defender Firewall does not resolve listener hostnames, while remaining restricted by program, port, and profile. `uninstall.ps1` removes only the exact rule named `Printer Fleet Monitor Web API`. The firewall does not affect outbound DNS or SNMP collection; network policy must permit those requests separately.

## Lifecycle and status

Run task-changing commands from elevated PowerShell:

| Command | Behavior |
| --- | --- |
| `& .\scripts\windows\start.ps1` | Enable and start both installed tasks; no build or reinstall. |
| `& .\scripts\windows\stop.ps1` | Disable and stop supervision; preserve installation and data. |
| `& .\scripts\windows\restart.ps1` | Stop and start both tasks without rebuilding. |
| `& .\scripts\windows\status.ps1` | Show installed/running state, host PID where available, listener, dashboard URL, and logs. |
| `& .\scripts\windows\uninstall.ps1` | Remove tasks and the application-owned firewall rule; preserve source and operator data. |

Task Scheduler state is authoritative. PID files under `data\run` identify the PowerShell service host and are runtime metadata, not application data.

## Logs

The task hosts append to:

- `data\log\web.stdout.log`
- `data\log\web.stderr.log`
- `data\log\collector.stdout.log`
- `data\log\collector.stderr.log`

Task Scheduler also records launch/result history when task history is enabled. Logs are preserved across reinstall, update, stop, and uninstall. Establish local rotation/retention appropriate for the host; the application does not truncate them.

## Update

From an elevated PowerShell window:

```powershell
& .\scripts\windows\update.ps1
```

The updater verifies that it is at the repository root, requires Git, refuses tracked local changes, uses `git pull --ff-only`, resolves the installed compatible Node/npm pair, runs `npm ci`, builds, and runs all tests before touching running tasks. Only after those checks pass does it restart both tasks and require `/api/health` to return JSON with `status: "ok"`. Use `-VerboseOutput` for captured successful command output or `-SkipTests` only for an explicitly accepted expedited update.

Failures before the restart stage leave the current supervised processes running. The updater never resets, cleans, or stashes the repository and does not replace `.env`, inventory, SQLite, logs, captures, or deployment data.

## Foreground operation

For supervised troubleshooting without Task Scheduler:

```powershell
& .\scripts\windows\run.ps1
```

Both processes share the terminal and stop together if either exits. Keep the PowerShell window open. Do not run this while the scheduled collector is running, because only one collector may write to a database.

## Differences from macOS

macOS uses two per-user launchd LaunchAgents and does not require root for its lifecycle. Windows uses two machine boot-triggered Task Scheduler tasks under NetworkService; installing or changing those tasks and firewall rules requires elevation. Both platforms use the same Node entry points, `.env`, inventory, SQLite schema, stored-state API/dashboard behavior, read-only SNMP collector, and single-collector rule. Windows paths and ACLs are managed by PowerShell, while macOS paths and service definitions remain managed by the existing shell/launchd scripts.

## Troubleshooting

- If installation says configuration is invalid, edit `.env` and `config\inventory.yaml`; the installer deliberately does not install tasks against placeholder configuration.
- If a task repeatedly restarts, inspect its stderr log and `Get-ScheduledTaskInfo -TaskPath '\' -TaskName 'Printer Fleet Monitor - Web API'` (or `Printer Fleet Monitor - Collector`).
- If `status.ps1` reports one task missing, rerun `install.ps1`; do not run a partially installed pair.
- If the API is local but unreachable remotely, confirm `HOST`, the explicit firewall choice, upstream network ACLs, and that the client uses the configured port.
- If npm cannot install `better-sqlite3`, confirm x64 Node 22.12+ and rerun `npm ci`; do not copy `node_modules` from macOS or another architecture.
- If a repository path changes, rerun `install.ps1` from the new checkout so absolute task arguments and firewall program scope are refreshed.

## Uninstall

```powershell
& .\scripts\windows\uninstall.ps1
```

This disables, stops, and removes both scheduled tasks and removes only the Printer Fleet Monitor-owned firewall rule. It preserves the repository, `.env`, inventory, `data` (including SQLite), logs, and private captures. Delete those separately only when their retention is no longer required.

## First Windows live-validation checklist

Perform this checklist on a disposable or newly designated Windows host before declaring the platform production-ready. Record command output and timestamps; do not claim these checks from a macOS-only test run.

1. Install current x64 Node/npm and Git. Clone into a path containing spaces such as `C:\PFM Test\Printer Fleet Monitor`.
2. Copy `.env.example` and the example inventory, configure a read-only test community and one explicitly authorized printer, and keep `HOST=127.0.0.1` initially.
3. From elevated PowerShell, run `install.ps1`, then `status.ps1`. Confirm both tasks are Running and no inbound firewall rule named `Printer Fleet Monitor Web API` exists.
4. Open the local dashboard and request `/api/health`, `/api/fleet`, and `/api/printers`. Confirm reads use cached SQLite state and do not trigger collection.
5. Confirm the collector reaches only the configured hostname or IPv4 target over read-only SNMP and that no SET/discovery traffic occurs. Verify an observation and stable printer ID in the API.
6. Record the SQLite path, size, and a safe backup. Run `stop.ps1`; confirm both tasks are Disabled and no monitor process respawns. Run `start.ps1`, then `restart.ps1`, confirming state each time.
7. Use the host PID from `status.ps1` with `taskkill.exe /PID <pid> /T /F`. Wait at least 70 seconds and confirm Task Scheduler restarts that task while the other task remains running.
8. Reboot. Before interactive login where practical, verify both tasks started from the boot trigger; after login, verify API health, collector runtime, logs, and preserved SQLite history.
9. Rerun `install.ps1`. Confirm `.env`, inventory, database, logs, and stable printer history were preserved.
10. Run `update.ps1` against a test update. Confirm tests complete before restart and API health is checked afterward. Separately introduce a harmless tracked-file modification in a disposable checkout and confirm update refuses before restart, then discard only that intentional test edit.
11. Run `status.ps1` without elevation and record whether local policy permits task visibility. Confirm normal installed processes run as NetworkService with a limited token even though lifecycle changes require elevation.
12. Change to an authorized non-loopback `HOST`. Confirm install refuses without a firewall choice; test `-AllowInboundFirewall`, verify the rule is scoped to the configured TCP port, Node executable, and Domain/Private profiles, then verify remote access. Return to loopback and confirm reinstall removes the rule.
13. Run `uninstall.ps1`. Confirm tasks and the managed firewall rule are removed while `.env`, inventory, SQLite, logs, captures, and source remain. Reinstall once more to prove recovery from preserved state.

Windows runtime validation remains incomplete until this checklist succeeds on both a Windows 11 x64 host and at least one supported Windows Server x64 host.
