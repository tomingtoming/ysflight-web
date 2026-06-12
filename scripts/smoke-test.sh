#!/usr/bin/env bash
# Serve dist/ and run the boot smoke test on multiple GPU backends.
#
#   scripts/smoke-test.sh [backends...]     (default: "default strict")
#
# - "default": headless browser's own choice (software SwiftShader on CI);
#   catches compile errors, aborts, and boot failures everywhere.
# - "strict": system Chrome, HEADED, on the native Mesa GL stack
#   (--use-angle=gl).  Real drivers lower mediump to fp16 and reject
#   cross-stage precision mismatches that software rasterizers tolerate.
#   Needs a display + google-chrome; run locally before pushing renderer
#   changes.  (The fp16 link-failure class is NOT reproducible headless.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ $# -gt 0 ]] && BACKENDS=("$@") || BACKENDS=(default strict)
PORT="${SMOKE_PORT:-8923}"

if [[ ! -d "$ROOT/dist" ]]; then
    echo "error: dist/ not found — run scripts/build.sh first" >&2
    exit 1
fi
if [[ ! -d "$ROOT/node_modules/playwright" ]]; then
    echo "Installing playwright..."
    (cd "$ROOT" && npm install --no-save playwright >/dev/null)
    (cd "$ROOT" && npx playwright install chromium >/dev/null)
fi

node "$ROOT/scripts/serve.mjs" "$PORT" "$ROOT/dist" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
sleep 1

FAIL=0
for backend in "${BACKENDS[@]}"; do
    echo "=== smoke: $backend ==="
    if ! node "$ROOT/scripts/smoke-test.mjs" "http://localhost:$PORT/index.html" "$backend"; then
        FAIL=1
    fi
done
exit $FAIL
