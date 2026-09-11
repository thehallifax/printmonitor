#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"

VERBOSE=0
SKIP_TESTS=0
for option in "$@"; do
  case "$option" in
    --verbose) VERBOSE=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *) echo "Usage: ./scripts/update.sh [--verbose] [--skip-tests]" >&2; exit 2 ;;
  esac
done

require_macos
require_non_root

if ! command -v git >/dev/null 2>&1; then
  echo "Update stopped: git is not available." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
repository_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$repository_root" ] || [ "$(CDPATH= cd -- "$repository_root" 2>/dev/null && pwd)" != "$PROJECT_ROOT" ]; then
  echo "Update stopped: $PROJECT_ROOT is not the root of a Git repository." >&2
  exit 1
fi

echo "Printer Fleet Monitor Update"

tracked_changes=$(git status --porcelain --untracked-files=no)
if [ -n "$tracked_changes" ]; then
  echo "Update stopped: tracked local changes are present. Commit or resolve them before updating; nothing was discarded." >&2
  if [ "$VERBOSE" -eq 1 ]; then printf '%s\n' "$tracked_changes" >&2; fi
  exit 1
fi
echo "✓ Repository clean"

if { [ -f "$WEB_PLIST" ] && [ ! -f "$COLLECTOR_PLIST" ]; } || { [ ! -f "$WEB_PLIST" ] && [ -f "$COLLECTOR_PLIST" ]; }; then
  echo "Update stopped: only one launchd plist is installed. Run ./scripts/install.sh to repair the deployment." >&2
  exit 1
fi

NODE_EXECUTABLE=$(resolve_node_executable) || exit 1
NPM_EXECUTABLE=$(resolve_npm_executable "$NODE_EXECUTABLE") || exit 1

TEMP_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/printer-fleet-update.XXXXXX")
RESTART_STAGE=0
cleanup() {
  rm -f "$TEMP_DIRECTORY"/*.log
  rmdir "$TEMP_DIRECTORY" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

run_step() {
  label=$1
  shift
  log_file="$TEMP_DIRECTORY/step.log"
  if "$@" >"$log_file" 2>&1; then
    if [ "$VERBOSE" -eq 1 ]; then cat "$log_file"; fi
    echo "✓ $label"
    return 0
  fi
  cat "$log_file" >&2
  if [ "$RESTART_STAGE" -eq 0 ]; then
    echo "Update stopped: $label failed. Running services were not restarted." >&2
  else
    echo "Update stopped: $label failed during restart verification. Run ./scripts/status.sh and inspect the relevant logs." >&2
  fi
  return 1
}

run_project_npm() {
  run_npm "$NODE_EXECUTABLE" "$NPM_EXECUTABLE" "$@"
}

run_step "Git update passed" git pull --ff-only || exit 1
revision=$(git rev-parse --short HEAD)
echo "✓ Updated to $revision"

run_step "Dependencies installed" run_project_npm ci || exit 1
run_step "Build passed" run_project_npm run build || exit 1
if [ "$SKIP_TESTS" -eq 0 ]; then
  run_step "Tests passed" run_project_npm test || exit 1
else
  echo "- Tests skipped by operator request"
fi

if [ -f "$WEB_PLIST" ] && [ -f "$COLLECTOR_PLIST" ]; then
  RESTART_STAGE=1
  run_step "Service restart passed" "$SCRIPT_DIRECTORY/restart.sh" || exit 1
  run_step "Web restarted" launchctl print "$(service_target "$WEB_LABEL")" || exit 1
  run_step "Collector restarted" launchctl print "$(service_target "$COLLECTOR_LABEL")" || exit 1

  load_installed_web_address
  dashboard_url=$("$NODE_EXECUTABLE" "$PROJECT_ROOT/scripts/project-env.mjs" url "$PROJECT_ROOT")
  if ! command -v curl >/dev/null 2>&1; then
    echo "Update stopped: curl is required to verify the local API after restart." >&2
    exit 1
  fi
  health_log="$TEMP_DIRECTORY/health.log"
  api_healthy=0
  attempt=0
  while [ "$attempt" -lt 10 ]; do
    if curl --fail --silent --show-error --max-time 5 "$dashboard_url/api/health" >"$health_log" 2>&1 \
      && "$NODE_EXECUTABLE" -e 'const fs = require("node:fs"); const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (body.status !== "ok") process.exit(1);' "$health_log" 2>/dev/null; then
      api_healthy=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  if [ "$api_healthy" -ne 1 ]; then
    cat "$health_log" >&2
    echo "Update completed and services restarted, but the local API health check failed. Run ./scripts/status.sh and inspect the web logs." >&2
    exit 1
  fi
  echo "✓ API healthy"
  echo ""
  echo "Dashboard: $dashboard_url"
else
  echo "✓ Build ready; launchd services are not installed, so restart and health check were skipped"
fi
