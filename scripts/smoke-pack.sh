#!/usr/bin/env bash
# Build-independent add-on pack smoke: serve dist/ + the test pack, then drive
# the pre-boot pack flow in a real browser (scripts/smoke-pack.mjs).
#   scripts/build.sh && scripts/smoke-pack.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-8924}"

[[ -d "$ROOT/dist" ]] || { echo "error: dist/ not found — run scripts/build.sh first" >&2; exit 1; }

# The page fetches /test-pack.zip; stage the real community fixture into dist/.
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

node "$ROOT/scripts/smoke-pack.mjs" "http://localhost:$PORT/index.html"
