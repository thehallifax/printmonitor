# macOS deployment

Printer Fleet Monitor uses two independent per-user launchd agents: one serves the stored-state API/dashboard, and one runs the collector in watch mode. Both use the same project-root `.env`, inventory, and SQLite path, but launchd supervises and restarts them independently.

## Fresh installation

Install Node.js 22.12 or newer and npm 10 or newer, then run these commands as the macOS account that should own the services:

```bash
git clone https://github.com/thehallifax/printmonitor.git
cd printmonitor
cp .env.example .env
cp config/inventory.example.yaml config/inventory.yaml
chmod 600 .env config/inventory.yaml
```

Edit `.env` and `config/inventory.yaml`. Use a read-only SNMP community, hostname-only inventory entries, matching `DATABASE_PATH` for both processes, and `INVENTORY_PATH=config/inventory.yaml`. The deployment template binds to `127.0.0.1:3010`; change `HOST` or `PORT` if required.

Preview the installation without changing anything, then install:

```bash
./scripts/install.sh --dry-run
./scripts/install.sh
./scripts/status.sh
```

The installer is idempotent. It runs `npm ci` and the build again, refreshes generated service definitions, and restarts the two agents, but never replaces an existing `.env` or `config/inventory.yaml`. It does not remove or recreate the SQLite database or truncate logs. Do not run it with `sudo`; per-user LaunchAgents require the target user's session.

## Foreground/development operation

This mode is optional and is not required for a normal launchd deployment. Use it for local development or supervised troubleshooting only.

To run both processes in one terminal without installing launchd jobs:

```bash
npm ci
npm run build
./scripts/run.sh
```

The foreground supervisor safely parses the root `.env`, starts the API/web and collector, forwards `SIGINT`/`SIGTERM`, and waits for both children to stop. If either child exits unexpectedly, it terminates the other and returns a non-zero status. It never evaluates `.env` as shell code.

## Service design and logs

The installed labels are:

- `com.printer-fleet-monitor.web`
- `com.printer-fleet-monitor.collector`

Both agents use `RunAtLoad`, `KeepAlive`, a ten-second restart throttle, an explicit working directory, and the absolute Node executable discovered during installation. Their service entry points receive the same explicit project root used by installation and status, then load that root's `.env` through the shared deployment configuration code. Non-secret effective runtime settings are copied into the generated plist so an explicit install-time override remains effective; the SNMP community is never embedded and is loaded from `.env` at service start. Rerun `install.sh` after changing daemon configuration. Existing process-environment overrides retain precedence over `.env` values.

Logs are append-only launchd stdout/stderr files under `data/log/`:

- `web.stdout.log` and `web.stderr.log`
- `collector.stdout.log` and `collector.stderr.log`

`./scripts/status.sh` reports both service states, the configured dashboard URL, and these paths without printing credentials.

Management scripts first reuse the absolute Node executable stored in an installed plist, then check an existing NVM installation and standard Homebrew locations before falling back to the non-interactive command `PATH`. npm is resolved beside that selected Node installation and run with the matching Node directory prepended to `PATH`. They do not source shell profiles, NVM initialization, or Homebrew shell setup.

## Restart and uninstall

```bash
./scripts/restart.sh
./scripts/uninstall.sh
```

Restart uses launchd's native `kickstart -k` operation for loaded agents and bootstraps an agent only when its plist is installed but the job is not loaded. This avoids an unload/reload race. Uninstall unloads the agents and removes only their generated plist files. It deliberately preserves `.env`, `config/inventory.yaml`, `data/` (including SQLite), and all logs.

## Upgrade an existing cacheadmin deployment

For normal upgrades after `scripts/update.sh` is present in the checkout, log in as `cacheadmin` and run:

```bash
~/printmonitor/scripts/update.sh
```

The updater refuses tracked local modifications, uses `git pull --ff-only`, runs `npm ci`, builds and tests before restarting either service, verifies both launchd jobs, and checks the local API. Use `--verbose` to show successful command output or `--skip-tests` only for an explicitly accepted expedited update. Failures display the captured command output and leave currently running services untouched until the restart stage.

The first upgrade from a version that predates `update.sh` still needs a one-time fast-forward pull from the existing checkout. This bootstrap is not the normal update procedure:

```bash
cd "/absolute/path/to/printmonitor"
git status --short
git pull --ff-only
./scripts/update.sh
```

Before upgrading, confirm `.env` and `config/inventory.yaml` contain the intended hostname-only production configuration. Never copy their example counterparts over existing operator files. The updater does not reset, clean, stash, or modify `.env`, inventory, SQLite data, logs, or private captures.
