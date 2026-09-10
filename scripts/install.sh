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

for tool in node npm launchctl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool is missing: $tool" >&2
    exit 1
  fi
done

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
NPM_MAJOR=$(npm --version | awk -F. '{ print $1 }')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  echo "Node.js 22.12 or newer is required by the locked dependencies." >&2
  exit 1
fi
if [ "$NPM_MAJOR" -lt 10 ]; then
  echo "npm 10 or newer is required." >&2
  exit 1
fi

NODE_PATH=$(node -p 'process.execPath')
cd "$PROJECT_ROOT"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: no files, dependencies, or launchd jobs will be changed."
  echo "Project: $PROJECT_ROOT"
  echo "Would preserve existing .env, inventory, database, and logs."
  echo "Would run npm ci and npm run build."
  echo "Would install $WEB_LABEL and $COLLECTOR_LABEL in $LAUNCH_AGENT_DIRECTORY."
  node "$PROJECT_ROOT/scripts/project-env.mjs" url
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

npm ci
npm run build

if ! node "$PROJECT_ROOT/scripts/project-env.mjs" validate; then
  echo "Installation stopped before launchd changes. Update .env and config/inventory.yaml, then rerun this installer." >&2
  exit 1
fi

TEMP_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/printer-fleet-launchd.XXXXXX")
cleanup() {
  rm -f "$TEMP_DIRECTORY/$WEB_LABEL.plist" "$TEMP_DIRECTORY/$COLLECTOR_LABEL.plist"
  rmdir "$TEMP_DIRECTORY" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

node "$PROJECT_ROOT/scripts/generate-launchd.mjs" "$PROJECT_ROOT" "$NODE_PATH" "$TEMP_DIRECTORY"
install -m 644 "$TEMP_DIRECTORY/$WEB_LABEL.plist" "$WEB_PLIST"
install -m 644 "$TEMP_DIRECTORY/$COLLECTOR_LABEL.plist" "$COLLECTOR_PLIST"

launchctl bootout "$(service_target "$WEB_LABEL")" >/dev/null 2>&1 || true
launchctl bootout "$(service_target "$COLLECTOR_LABEL")" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$WEB_PLIST"
launchctl bootstrap "gui/$(id -u)" "$COLLECTOR_PLIST"

echo "Printer Fleet Monitor services installed."
node "$PROJECT_ROOT/scripts/project-env.mjs" url
echo "Logs: $LOG_DIRECTORY"
