#!/usr/bin/env bash
# Headline v2 smoke (M6): pre-boot invite-link join installs the host's pack
# before boot, then the engine loads it.  Serves dist/ + the test pack, runs a
# local signaling stub, drives two browsers.
#   scripts/build.sh && scripts/smoke-mp-join.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_PORT="${MP_SERVE_PORT:-8936}"
SIG_PORT="${MP_SIG_PORT:-8937}"

[[ -d "$ROOT/dist" ]] || { echo "error: dist/ not found — run scripts/build.sh first" >&2; exit 1; }

# The host page fetches /test-pack.zip; stage the real community fixture.
cp "$ROOT/test/fixtures/testpack.zip" "$ROOT/dist/test-pack.zip"

# Install playwright + ws together (one --no-save install; installing them in
# separate passes without a package.json can prune the earlier one).
if [[ ! -d "$ROOT/node_modules/playwright" || ! -d "$ROOT/node_modules/ws" ]]; then
    echo "Installing playwright + ws..."
    (cd "$ROOT" && npm install --no-save playwright ws >/dev/null)
    (cd "$ROOT" && npx playwright install chromium >/dev/null)
fi

node "$ROOT/scripts/serve.mjs" "$SERVE_PORT" "$ROOT/dist" >/dev/null 2>&1 &
SERVE_PID=$!
node "$ROOT/scripts/sig-stub.mjs" "$SIG_PORT" >/dev/null 2>&1 &
SIG_PID=$!
trap 'kill $SERVE_PID $SIG_PID 2>/dev/null; rm -f "$ROOT/dist/test-pack.zip"' EXIT
sleep 1

node "$ROOT/scripts/smoke-mp-join.mjs" "http://localhost:$SERVE_PORT/index.html" "ws://localhost:$SIG_PORT/signal"
