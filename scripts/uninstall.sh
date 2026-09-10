#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"
require_macos
require_non_root

launchctl bootout "$(service_target "$WEB_LABEL")" >/dev/null 2>&1 || true
launchctl bootout "$(service_target "$COLLECTOR_LABEL")" >/dev/null 2>&1 || true
rm -f "$WEB_PLIST" "$COLLECTOR_PLIST"

echo "Printer Fleet Monitor launchd jobs removed."
echo "Preserved: $PROJECT_ROOT/.env"
echo "Preserved: $PROJECT_ROOT/config/inventory.yaml"
echo "Preserved: $PROJECT_ROOT/data (database and logs)"
