#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "Usage: ./scripts/install.sh [--dry-run]" >&2; exit 2 ;;
esac

require_macos
require_non_root

if ! command -v launchctl >/dev/null 2>&1; then
  echo "Required tool is missing: launchctl" >&2
  exit 1
fi

NODE_EXECUTABLE=$(resolve_node_executable) || exit 1
NPM_EXECUTABLE=$(resolve_npm_executable "$NODE_EXECUTABLE") || exit 1

NODE_MAJOR=$("$NODE_EXECUTABLE" -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$("$NODE_EXECUTABLE" -p 'process.versions.node.split(".")[1]')
NPM_MAJOR=$(run_npm "$NODE_EXECUTABLE" "$NPM_EXECUTABLE" --version | awk -F. '{ print $1 }')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  echo "Node.js 22.12 or newer is required by the locked dependencies." >&2
  exit 1
fi
if [ "$NPM_MAJOR" -lt 10 ]; then
  echo "npm 10 or newer is required." >&2
  exit 1
fi

INSTALLED_NODE_EXECUTABLE=$("$NODE_EXECUTABLE" -p 'process.execPath')
cd "$PROJECT_ROOT"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: no files, dependencies, or launchd jobs will be changed."
  echo "Project: $PROJECT_ROOT"
  echo "Would preserve existing .env, inventory, database, and logs."
  echo "Would run npm ci and npm run build."
  echo "Would install $WEB_LABEL and $COLLECTOR_LABEL in $LAUNCH_AGENT_DIRECTORY."
  show_effective_configuration
  exit 0
fi

mkdir -p "$PROJECT_ROOT/config" "$PROJECT_ROOT/data" "$LOG_DIRECTORY" "$LAUNCH_AGENT_DIRECTORY"

if [ ! -f "$PROJECT_ROOT/config/inventory.yaml" ]; then
  cp "$PROJECT_ROOT/config/inventory.example.yaml" "$PROJECT_ROOT/config/inventory.yaml"
  chmod 600 "$PROJECT_ROOT/config/inventory.yaml"
  echo "Created config/inventory.yaml; edit it before starting live collection."
fi
if [ ! -f "$PROJECT_ROOT/.env" ]; then
  cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
  chmod 600 "$PROJECT_ROOT/.env"
  echo "Created .env; set a read-only SNMP community before installing services."
fi

run_npm "$NODE_EXECUTABLE" "$NPM_EXECUTABLE" ci
run_npm "$NODE_EXECUTABLE" "$NPM_EXECUTABLE" run build

if ! "$NODE_EXECUTABLE" "$PROJECT_ROOT/scripts/project-env.mjs" validate "$PROJECT_ROOT"; then
  echo "Installation stopped before launchd changes. Update .env and config/inventory.yaml, then rerun this installer." >&2
  exit 1
fi

TEMP_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/printer-fleet-launchd.XXXXXX")
cleanup() {
  rm -f "$TEMP_DIRECTORY/$WEB_LABEL.plist" "$TEMP_DIRECTORY/$COLLECTOR_LABEL.plist"
  rmdir "$TEMP_DIRECTORY" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"$NODE_EXECUTABLE" "$PROJECT_ROOT/scripts/generate-launchd.mjs" "$PROJECT_ROOT" "$INSTALLED_NODE_EXECUTABLE" "$TEMP_DIRECTORY"
install -m 644 "$TEMP_DIRECTORY/$WEB_LABEL.plist" "$WEB_PLIST"
install -m 644 "$TEMP_DIRECTORY/$COLLECTOR_LABEL.plist" "$COLLECTOR_PLIST"

launchctl bootout "$(service_target "$WEB_LABEL")" >/dev/null 2>&1 || true
launchctl bootout "$(service_target "$COLLECTOR_LABEL")" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$WEB_PLIST"
launchctl bootstrap "gui/$(id -u)" "$COLLECTOR_PLIST"

echo "Printer Fleet Monitor services installed."
show_effective_configuration
echo "Logs: $LOG_DIRECTORY"
