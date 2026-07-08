#!/usr/bin/env bash
# Build ysflight-web: YSFLIGHT compiled to WebAssembly with Emscripten.
#
# Prerequisites:
#   - Emscripten SDK (auto-installed if missing, or use EMSDK env var)
#   - CMake 3.20+
#
# Usage:
#   scripts/build.sh            # configure + build + stage into dist/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"
DIST_DIR="$ROOT/dist"
EMSDK_VERSION="${EMSDK_VERSION:-6.0.0}"
EMSDK_AUTO_INSTALL="${EMSDK_AUTO_INSTALL:-1}"

# --- Emscripten environment -------------------------------------------------
if ! command -v emcmake >/dev/null 2>&1; then
    EMSDK_DIR="${EMSDK:-$HOME/opt/emsdk}"

    if [[ ! -f "$EMSDK_DIR/emsdk_env.sh" ]]; then
        if [[ "$EMSDK_AUTO_INSTALL" != "1" ]]; then
            echo "error: emcmake not found and no emsdk at $EMSDK_DIR" >&2
            echo "Install: https://emscripten.org/docs/getting_started/downloads.html" >&2
            exit 1
        fi
        if [[ ! -d "$EMSDK_DIR/.git" ]]; then
            echo "Installing emsdk $EMSDK_VERSION into $EMSDK_DIR"
            mkdir -p "$(dirname "$EMSDK_DIR")"
            git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
        fi
        "$EMSDK_DIR/emsdk" install "$EMSDK_VERSION"
        "$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION"
    fi

    # shellcheck disable=SC1091
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1

    if ! command -v emcmake >/dev/null 2>&1; then
        echo "error: emcmake still not found after loading emsdk at $EMSDK_DIR" >&2
        exit 1
    fi
fi

# --- CMake ---------------------------------------------------------------------
CMAKE_VERSION="${CMAKE_VERSION:-3.31.6}"
if ! command -v cmake >/dev/null 2>&1; then
    CMAKE_DIR="$HOME/opt/cmake-$CMAKE_VERSION-linux-x86_64"
    if [[ ! -x "$CMAKE_DIR/bin/cmake" ]]; then
        echo "Installing CMake $CMAKE_VERSION into $CMAKE_DIR"
        mkdir -p "$HOME/opt"
        curl -sL "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-x86_64.tar.gz" \
            | tar xz -C "$HOME/opt"
    fi
    export PATH="$CMAKE_DIR/bin:$PATH"
fi

# --- Submodules ----------------------------------------------------------------
# upstream/ points at the tomingtoming forks' "emscripten" branches, which
# carry the Emscripten support commits on top of captainys' master.
git -C "$ROOT" submodule update --init --depth 1 2>/dev/null || true

# --- Configure + build -------------------------------------------------------
# Link-time size optimization: -Oz on the final link (Binaryen wasm-opt) shaves
# ~2.4% off the ASYNCIFY-instrumented wasm WITHOUT changing the instrumentation, so
# it stays safe.  (The -25% IGNORE_INDIRECT route is unsafe here: the engine suspends
# openat through the dynCall_v indirect dispatcher inside MainLoopTick, so stripping
# indirect instrumentation aborts on rewind -- see docs/asyncify-lazy-pack.md.)
# Injected here in the superproject so the engine submodule's CMakeLists is untouched.
emcmake cmake -S "$ROOT/upstream/YSFLIGHT/src" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DYSFLIGHT_WEB_PORT_DIR="$ROOT/src/port" \
    -DCMAKE_EXE_LINKER_FLAGS="-Oz"

cmake --build "$BUILD_DIR" --target ysflight32_gl2 -j"$(nproc)"

# --- Stage dist/ with content-hashed asset names ------------------------------
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/icons"

hash8() { sha1sum "$1" | cut -c1-8; }

H_JS=$(hash8 "$BUILD_DIR/main/ysflight32_gl2.js")
H_WASM=$(hash8 "$BUILD_DIR/main/ysflight32_gl2.wasm")
H_DATA=$(hash8 "$BUILD_DIR/main/ysflight32_gl2.data")
# Include the shell JS/HTML in the build id so changes to packs-ui.js / opfs-store.js
# / sw.js etc. bust the service-worker precache -- these are NOT part of the wasm
# hash, so without this a JS-only change keeps the same id and the SW serves stale.
H_SHELL=$(cat "$ROOT/web/index.html" "$ROOT/web/packs.js" "$ROOT/web/packs-ui.js" \
  "$ROOT/web/pack-net.js" "$ROOT/web/opfs-store.js" "$ROOT/web/memfs-lru.js" "$ROOT/web/replays-ui.js" \
  "$ROOT/web/workbench.js" "$ROOT/web/sw.js" 2>/dev/null | sha1sum | cut -c1-8)
BUILD_ID=$(printf '%s%s%s%s' "$H_JS" "$H_WASM" "$H_DATA" "$H_SHELL" | sha1sum | cut -c1-12)

JS_FILE="ysflight32_gl2.$H_JS.js"
WASM_FILE="ysflight32_gl2.$H_WASM.wasm"
DATA_FILE="ysflight32_gl2.$H_DATA.data"

cp "$BUILD_DIR/main/ysflight32_gl2.js"   "$DIST_DIR/$JS_FILE"
cp "$BUILD_DIR/main/ysflight32_gl2.wasm" "$DIST_DIR/$WASM_FILE"
cp "$BUILD_DIR/main/ysflight32_gl2.data" "$DIST_DIR/$DATA_FILE"
cp "$ROOT/web/manifest.webmanifest" "$DIST_DIR/"
cp "$ROOT/web/icons/"*.png "$DIST_DIR/icons/"

# Add-on pack layer: engine-agnostic core (packs.js) + pre-boot UI (packs-ui.js)
# + vendored unzip (vendor/fflate.js).  Plain ES modules, no bundler.
cp "$ROOT/web/packs.js" "$ROOT/web/packs-ui.js" "$ROOT/web/pack-net.js" "$ROOT/web/opfs-store.js" "$ROOT/web/memfs-lru.js" "$ROOT/web/replays-ui.js" "$ROOT/web/workbench.js" "$DIST_DIR/"
mkdir -p "$DIST_DIR/vendor"
cp "$ROOT/web/vendor/fflate.js" "$DIST_DIR/vendor/"

# index.html: point the ASSET line at the hashed names.
sed "s|^.*// __ASSET_LINE__\$|  var ASSET = {js:'$JS_FILE',wasm:'$WASM_FILE',data:'$DATA_FILE',build:'$BUILD_ID'};|" \
    "$ROOT/web/index.html" > "$DIST_DIR/index.html"

# Service worker: build id + precache list.
PRECACHE="[\"./\",\"index.html\",\"$JS_FILE\",\"$WASM_FILE\",\"$DATA_FILE\",\"packs.js\",\"packs-ui.js\",\"pack-net.js\",\"opfs-store.js\",\"memfs-lru.js\",\"replays-ui.js\",\"workbench.js\",\"vendor/fflate.js\",\"manifest.webmanifest\",\"icons/icon-192.png\",\"icons/icon-512.png\"]"
sed -e "s|__BUILD_ID__|$BUILD_ID|" -e "s|__PRECACHE__|$PRECACHE|" \
    "$ROOT/web/sw.js" > "$DIST_DIR/sw.js"

# Cloudflare Pages headers: cache policy keeps hashed assets immutable and
# HTML/SW fresh.  (Single-threaded web build -> no SharedArrayBuffer, so the
# COOP/COEP cross-origin isolation headers are not required.)
cat > "$DIST_DIR/_headers" <<EOF
/ysflight32_gl2.*
  Cache-Control: public, max-age=31536000, immutable
/icons/*
  Cache-Control: public, max-age=86400
/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/packs.js
  Cache-Control: no-cache
/packs-ui.js
  Cache-Control: no-cache
/pack-net.js
  Cache-Control: no-cache
/opfs-store.js
  Cache-Control: no-cache
/memfs-lru.js
  Cache-Control: no-cache
/vendor/*
  Cache-Control: no-cache
EOF

echo
echo "Done.  build=$BUILD_ID  Serve with:  node scripts/serve.mjs"
