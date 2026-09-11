#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"
require_macos
require_non_root
require_installed_services

start_launchd_service "$WEB_LABEL" "$WEB_PLIST"
start_launchd_service "$COLLECTOR_LABEL" "$COLLECTOR_PLIST"

echo "Printer Fleet Monitor services started."
"$SCRIPT_DIRECTORY/status.sh"
