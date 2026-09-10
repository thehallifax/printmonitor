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

launchctl bootout "$(service_target "$WEB_LABEL")" >/dev/null 2>&1 || true
launchctl bootout "$(service_target "$COLLECTOR_LABEL")" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$WEB_PLIST"
launchctl bootstrap "gui/$(id -u)" "$COLLECTOR_PLIST"

echo "Printer Fleet Monitor services restarted."
"$SCRIPT_DIRECTORY/status.sh"
