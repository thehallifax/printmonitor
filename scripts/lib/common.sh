#!/bin/sh

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
WEB_LABEL="com.printer-fleet-monitor.web"
COLLECTOR_LABEL="com.printer-fleet-monitor.collector"
LAUNCH_AGENT_DIRECTORY="$HOME/Library/LaunchAgents"
WEB_PLIST="$LAUNCH_AGENT_DIRECTORY/$WEB_LABEL.plist"
COLLECTOR_PLIST="$LAUNCH_AGENT_DIRECTORY/$COLLECTOR_LABEL.plist"
LOG_DIRECTORY="$PROJECT_ROOT/data/log"
PLIST_BUDDY=${PLIST_BUDDY:-/usr/libexec/PlistBuddy}
NODE_FALLBACK_PATHS=${NODE_FALLBACK_PATHS:-"/opt/homebrew/bin/node /usr/local/bin/node"}

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
  node_executable=$(resolve_node_executable) || exit 1
  "$node_executable" "$PROJECT_ROOT/scripts/project-env.mjs" describe "$PROJECT_ROOT"
}

installed_node_executable() {
  if [ ! -x "$PLIST_BUDDY" ]; then
    return 1
  fi

  for plist in "$WEB_PLIST" "$COLLECTOR_PLIST"; do
    if [ ! -f "$plist" ]; then
      continue
    fi
    candidate=$("$PLIST_BUDDY" -c "Print :ProgramArguments:0" "$plist" 2>/dev/null || true)
    case "$candidate" in
      /*)
        if [ -x "$candidate" ]; then
          printf '%s\n' "$candidate"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

resolve_node_executable() {
  if candidate=$(installed_node_executable); then
    printf '%s\n' "$candidate"
    return 0
  fi
  nvm_candidate=""
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then nvm_candidate=$candidate; fi
  done
  if [ -n "$nvm_candidate" ]; then
    printf '%s\n' "$nvm_candidate"
    return 0
  fi
  for candidate in $NODE_FALLBACK_PATHS; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if candidate=$(command -v node 2>/dev/null) && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  echo "Unable to find a Node.js executable. Install Node.js 22.12 or newer, or rerun ./scripts/install.sh from a shell where node is available." >&2
  return 1
}

resolve_npm_executable() {
  selected_node=$1
  selected_node_directory=$(dirname -- "$selected_node")
  candidate="$selected_node_directory/npm"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if candidate=$(command -v npm 2>/dev/null) && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  echo "Unable to find npm for $selected_node. Reinstall Node.js with npm, then rerun this command." >&2
  return 1
}

run_npm() {
  selected_node=$1
  selected_npm=$2
  shift 2
  selected_node_directory=$(dirname -- "$selected_node")
  PATH="$selected_node_directory${PATH:+:$PATH}" "$selected_npm" "$@"
}

load_installed_web_address() {
  if [ ! -f "$WEB_PLIST" ] || [ ! -x "$PLIST_BUDDY" ]; then
    return
  fi
  if [ "${HOST+x}" != x ]; then
    installed_host=$("$PLIST_BUDDY" -c "Print :EnvironmentVariables:HOST" "$WEB_PLIST" 2>/dev/null || true)
    if [ -n "$installed_host" ]; then HOST=$installed_host; export HOST; fi
  fi
  if [ "${PORT+x}" != x ]; then
    installed_port=$("$PLIST_BUDDY" -c "Print :EnvironmentVariables:PORT" "$WEB_PLIST" 2>/dev/null || true)
    if [ -n "$installed_port" ]; then PORT=$installed_port; export PORT; fi
  fi
}
