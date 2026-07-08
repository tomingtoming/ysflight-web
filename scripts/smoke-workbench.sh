#!/usr/bin/env bash
# Build-independent workbench smoke: serve dist/ + the loose-file fixture source,
# then drive assemble -> install -> ?freeflight in a real browser
# (scripts/smoke-workbench.mjs).
#   scripts/build.sh && scripts/smoke-workbench.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-8926}"

[[ -d "$ROOT/dist" ]] || { echo "error: dist/ not found — run scripts/build.sh first" >&2; exit 1; }

# The page unzips /test-pack.zip and hands test1's raw files to the workbench.
cp "$ROOT/test/fixtures/testpack.zip" "$ROOT/dist/test-pack.zip"

if [[ ! -d "$ROOT/node_modules/playwright" ]]; then
    echo "Installing playwright..."
    (cd "$ROOT" && npm install --no-save playwright >/dev/null)
    (cd "$ROOT" && npx playwright install chromium >/dev/null)
fi

node "$ROOT/scripts/serve.mjs" "$PORT" "$ROOT/dist" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -f "$ROOT/dist/test-pack.zip"' EXIT
sleep 1

node "$ROOT/scripts/smoke-workbench.mjs" "http://localhost:$PORT/index.html"
