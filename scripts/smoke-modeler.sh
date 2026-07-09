#!/usr/bin/env bash
# Polygon Crest boot smoke: serve dist/ and boot the editor wasm in a browser.
#   scripts/build.sh && scripts/smoke-modeler.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-8927}"

[[ -d "$ROOT/dist" ]] || { echo "error: dist/ not found — run scripts/build.sh first" >&2; exit 1; }

# The bridge leg simulates a modeler save with the fixture's real model bytes.
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

node "$ROOT/scripts/smoke-modeler.mjs" "http://localhost:$PORT/modeler.html"
