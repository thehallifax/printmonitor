#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"
require_macos
require_non_root

if [ ! -f "$WEB_PLIST" ] || [ ! -f "$COLLECTOR_PLIST" ]; then
  echo "Launchd jobs are not installed. Run ./scripts/install.sh first." >&2
  exit 1
fi

restart_service() {
  label=$1
  plist=$2
  target=$(service_target "$label")
  if launchctl print "$target" >/dev/null 2>&1; then
    launchctl kickstart -k "$target"
  else
    launchctl bootstrap "gui/$(id -u)" "$plist"
  fi
}

restart_service "$WEB_LABEL" "$WEB_PLIST"
restart_service "$COLLECTOR_LABEL" "$COLLECTOR_PLIST"

echo "Printer Fleet Monitor services restarted."
"$SCRIPT_DIRECTORY/status.sh"
