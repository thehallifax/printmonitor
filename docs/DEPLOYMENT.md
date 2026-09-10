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

## Foreground operation

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

## Restart and uninstall

```bash
./scripts/restart.sh
./scripts/uninstall.sh
```

Restart unloads and reloads both agents so each receives a normal termination signal. Uninstall unloads the agents and removes only their generated plist files. It deliberately preserves `.env`, `config/inventory.yaml`, `data/` (including SQLite), and all logs.

## Upgrade an existing cacheadmin deployment

Run the upgrade as `cacheadmin`, from the existing checkout. Preserve local configuration before updating application files:

```bash
sudo -iu cacheadmin
cd "/absolute/path/to/printmonitor"
git status --short
git pull --ff-only
```

Confirm `.env` contains `INVENTORY_PATH=config/inventory.yaml`, `DATABASE_PATH`, `POLL_INTERVAL_SECONDS`, `HOST`, and the intended `PORT` (3010 is the documented default). Confirm `config/inventory.yaml` exists and contains the real hostname-only inventory. Then run:

```bash
./scripts/install.sh --dry-run
./scripts/install.sh
./scripts/status.sh
```

Do not copy `.env.example` or `config/inventory.example.yaml` over existing operator files during an upgrade. The installer preserves them automatically.
