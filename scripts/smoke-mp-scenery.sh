#!/usr/bin/env bash
# MP scenery-pack sync smoke: a host advertises a scenery-only pack; a joiner
# with the pack-sync opt-in (?join=<room>&packsync=1) receives it pre-boot and
# can then fly ON the pack's field — the exact capability a vanilla joiner
# lacks when the host picks an add-on field (the reported dead-client bug).
#   scripts/build.sh && scripts/smoke-mp-scenery.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_PORT="${MP_SERVE_PORT:-8938}"
SIG_PORT="${MP_SIG_PORT:-8939}"

[[ -d "$ROOT/dist" ]] || { echo "error: dist/ not found — run scripts/build.sh first" >&2; exit 1; }

# The host page fetches /test-scnpack.zip; stage the scenery fixture.
cp "$ROOT/test/fixtures/scnpack.zip" "$ROOT/dist/test-scnpack.zip"

if [[ ! -d "$ROOT/node_modules/playwright" || ! -d "$ROOT/node_modules/ws" ]]; then
    echo "Installing playwright + ws..."
    (cd "$ROOT" && npm install --no-save playwright ws >/dev/null)
    (cd "$ROOT" && npx playwright install chromium >/dev/null)
fi

node "$ROOT/scripts/serve.mjs" "$SERVE_PORT" "$ROOT/dist" >/dev/null 2>&1 &
SERVE_PID=$!
node "$ROOT/scripts/sig-stub.mjs" "$SIG_PORT" >/dev/null 2>&1 &
SIG_PID=$!
trap 'kill $SERVE_PID $SIG_PID 2>/dev/null; rm -f "$ROOT/dist/test-scnpack.zip"' EXIT
sleep 1

node "$ROOT/scripts/smoke-mp-scenery.mjs" "http://localhost:$SERVE_PORT/index.html" "ws://localhost:$SIG_PORT/signal"
