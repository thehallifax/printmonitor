#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIRECTORY/lib/common.sh"
cd "$PROJECT_ROOT"

NODE_EXECUTABLE=$(resolve_node_executable) || exit 1
if [ ! -f "$PROJECT_ROOT/apps/api/dist/server.js" ] || [ ! -f "$PROJECT_ROOT/packages/collector/dist/cli.js" ]; then
  echo "Build output is missing. Run npm run build first." >&2
  exit 1
fi

exec "$NODE_EXECUTABLE" "$PROJECT_ROOT/scripts/run.mjs" "$PROJECT_ROOT"
