#!/usr/bin/env bash
# Build ysflight-web: YSFLIGHT compiled to WebAssembly with Emscripten.
#
# Prerequisites:
#   - Emscripten SDK (EMSDK env var or ~/opt/emsdk)
#   - CMake 3.20+
#
# Usage:
#   scripts/build.sh            # configure + build + stage into dist/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"
DIST_DIR="$ROOT/dist"

# --- Emscripten environment -------------------------------------------------
if ! command -v emcmake >/dev/null 2>&1; then
    EMSDK_DIR="${EMSDK:-$HOME/opt/emsdk}"
    if [[ -f "$EMSDK_DIR/emsdk_env.sh" ]]; then
        # shellcheck disable=SC1091
        source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
    else
        echo "error: emcmake not found and no emsdk at $EMSDK_DIR" >&2
        echo "Install: https://emscripten.org/docs/getting_started/downloads.html" >&2
        exit 1
    fi
fi

# --- Submodules + patches ----------------------------------------------------
git -C "$ROOT" submodule update --init --depth 1 2>/dev/null || true
"$ROOT/scripts/apply-patches.sh"

# --- Configure + build -------------------------------------------------------
emcmake cmake -S "$ROOT/upstream/YSFLIGHT/src" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DYSFLIGHT_WEB_PORT_DIR="$ROOT/src/port"

cmake --build "$BUILD_DIR" --target ysflight32_gl2 -j"$(nproc)"

# --- Stage dist/ --------------------------------------------------------------
mkdir -p "$DIST_DIR"
cp "$BUILD_DIR/main/ysflight32_gl2.js"   "$DIST_DIR/"
cp "$BUILD_DIR/main/ysflight32_gl2.wasm" "$DIST_DIR/"
cp "$BUILD_DIR/main/ysflight32_gl2.data" "$DIST_DIR/"
cp "$ROOT/web/index.html" "$DIST_DIR/"

echo
echo "Done.  Serve with:  npx serve $DIST_DIR  (or any static file server)"
