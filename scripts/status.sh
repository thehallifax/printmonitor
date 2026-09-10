#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"
require_macos

show_service() {
  name=$1
  label=$2
  target=$(service_target "$label")
  if details=$(launchctl print "$target" 2>/dev/null); then
    state=$(printf '%s\n' "$details" | awk -F'= ' '/^[[:space:]]*state = / { print $2; exit }')
    pid=$(printf '%s\n' "$details" | awk -F'= ' '/^[[:space:]]*pid = / { print $2; exit }')
    if [ -n "$pid" ]; then
      echo "$name: ${state:-loaded} (pid $pid)"
    else
      echo "$name: ${state:-loaded}"
    fi
  else
    echo "$name: not loaded"
  fi
}

show_service "Web/API" "$WEB_LABEL"
show_service "Collector" "$COLLECTOR_LABEL"
echo "Dashboard: $(node "$PROJECT_ROOT/scripts/project-env.mjs" url)"
echo "Web logs: $LOG_DIRECTORY/web.stdout.log, $LOG_DIRECTORY/web.stderr.log"
echo "Collector logs: $LOG_DIRECTORY/collector.stdout.log, $LOG_DIRECTORY/collector.stderr.log"
