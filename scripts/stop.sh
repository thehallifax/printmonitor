#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"
require_macos
require_non_root

stop_launchd_service "$WEB_LABEL"
stop_launchd_service "$COLLECTOR_LABEL"

echo "Printer Fleet Monitor services stopped; launchd definitions remain installed."
"$SCRIPT_DIRECTORY/status.sh"
