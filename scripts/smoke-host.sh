#!/usr/bin/env bash
# Host deep-link smoke (web-shell increment 6): ?host=1&name= must boot the
# engine straight into server mode and claim the signaling room.
# Serves dist/ and runs the local signaling stub, then drives one browser.
#   scripts/build.sh && scripts/smoke-host.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_PORT="${HOST_SERVE_PORT:-8927}"
SIG_PORT="${HOST_SIG_PORT:-8928}"

[[ -d "$ROOT/dist" ]] || { echo "error: dist/ not found — run scripts/build.sh first" >&2; exit 1; }

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
trap 'kill $SERVE_PID $SIG_PID 2>/dev/null' EXIT
sleep 1

node "$ROOT/scripts/smoke-host.mjs" "http://localhost:$SERVE_PORT/index.html" "ws://localhost:$SIG_PORT/signal"
