#!/bin/sh

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
WEB_LABEL="com.printer-fleet-monitor.web"
COLLECTOR_LABEL="com.printer-fleet-monitor.collector"
LAUNCH_AGENT_DIRECTORY="$HOME/Library/LaunchAgents"
WEB_PLIST="$LAUNCH_AGENT_DIRECTORY/$WEB_LABEL.plist"
COLLECTOR_PLIST="$LAUNCH_AGENT_DIRECTORY/$COLLECTOR_LABEL.plist"
LOG_DIRECTORY="$PROJECT_ROOT/data/log"

require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "This launchd command currently supports macOS only." >&2
    exit 1
  fi
}

require_non_root() {
  if [ "$(id -u)" -eq 0 ]; then
    echo "Run this installer as the account that will own the services, not as root." >&2
    exit 1
  fi
}

service_target() {
  printf 'gui/%s/%s\n' "$(id -u)" "$1"
}

show_effective_configuration() {
  node "$PROJECT_ROOT/scripts/project-env.mjs" describe "$PROJECT_ROOT"
}

load_installed_web_address() {
  if [ ! -f "$WEB_PLIST" ] || [ ! -x /usr/libexec/PlistBuddy ]; then
    return
  fi
  if [ "${HOST+x}" != x ]; then
    installed_host=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:HOST" "$WEB_PLIST" 2>/dev/null || true)
    if [ -n "$installed_host" ]; then HOST=$installed_host; export HOST; fi
  fi
  if [ "${PORT+x}" != x ]; then
    installed_port=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:PORT" "$WEB_PLIST" 2>/dev/null || true)
    if [ -n "$installed_port" ]; then PORT=$installed_port; export PORT; fi
  fi
}
