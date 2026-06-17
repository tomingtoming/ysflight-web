#!/usr/bin/env bash
# Unit tests for the JS pack engine (web/packs.js) — pure node, no browser.
#   scripts/test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node --test "$ROOT"/test/*.test.mjs
