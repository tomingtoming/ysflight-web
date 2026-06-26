#!/usr/bin/env bash
# Forced-RELAY pack-transfer smoke: a joiner pulls a host's pack over a REAL
# Cloudflare TURN relay (not loopback host candidates), on ONE machine.  Mints real
# ICE from the live /turn (YSFW_TURN_URL, default prod) and forces relay-only on
# every PeerConnection.  Needs network access to the TURN endpoint + relay.
#   scripts/build.sh && scripts/smoke-mp-pack-turn.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_PORT="${MP_SERVE_PORT:-8934}"
SIG_PORT="${MP_SIG_PORT:-8935}"

[[ -d "$ROOT/dist" ]] || { echo "error: dist/ not found — run scripts/build.sh first" >&2; exit 1; }
cp "$ROOT/test/fixtures/testpack.zip" "$ROOT/dist/test-pack.zip"

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

node "$ROOT/scripts/smoke-mp-pack-turn.mjs" "http://localhost:$SERVE_PORT/index.html" "ws://localhost:$SIG_PORT/signal"
