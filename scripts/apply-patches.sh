#!/usr/bin/env bash
# Apply ysflight-web patches to the upstream submodules (idempotent).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

apply_dir() {
    local repo_dir="$1" patch_dir="$2"
    [[ -d "$patch_dir" ]] || return 0
    local p
    for p in "$patch_dir"/*.patch; do
        [[ -e "$p" ]] || continue
        if git -C "$repo_dir" apply --reverse --check "$p" >/dev/null 2>&1; then
            echo "already applied: $(basename "$p")"
        elif git -C "$repo_dir" apply --check "$p" >/dev/null 2>&1; then
            git -C "$repo_dir" apply "$p"
            echo "applied: $(basename "$p")"
        else
            echo "error: patch does not apply cleanly: $p" >&2
            exit 1
        fi
    done
}

apply_dir "$ROOT/upstream/public"   "$ROOT/patches/public"
apply_dir "$ROOT/upstream/YSFLIGHT" "$ROOT/patches/ysflight"
