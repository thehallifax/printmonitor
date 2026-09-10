#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
cd "$PROJECT_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required." >&2
  exit 1
fi
if [ ! -f "$PROJECT_ROOT/apps/api/dist/server.js" ] || [ ! -f "$PROJECT_ROOT/packages/collector/dist/cli.js" ]; then
  echo "Build output is missing. Run npm run build first." >&2
  exit 1
fi

exec "$(command -v node)" "$PROJECT_ROOT/scripts/run.mjs" "$PROJECT_ROOT"
