#!/usr/bin/env bash
# =============================================================================
# prepare.sh -- pull the latest upstream deepseek-harness, build it, and collect
# the runtime closure (dsh workspace + standalone Node) into ./resources.
#
#   resources/dsh/   full upstream workspace, built (apps/cli/lib, apps/web/dist)
#   resources/node/  standalone Node runtime matching dsh's engines
#   resources/dsh/UPSTREAM_COMMIT  pinned upstream commit for version display
#
# Usage: bash scripts/prepare.sh [--force]
#   --force  rebuild even when upstream is unchanged
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RES="$ROOT/resources"

NODE_VERSION="v24.16.0"
NODE_PLATFORM="darwin-arm64"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
UPSTREAM_REPO="https://github.com/deepseek-ai/deepseek-harness"
UPSTREAM_BRANCH="main"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

echo "-- dsh-desktop prepare --------------------------------------"

# -- 1. upstream workspace -------------------------------------------------
if [ -d "$RES/dsh/.git" ]; then
  echo "[upstream] pulling latest $UPSTREAM_BRANCH..."
  git -C "$RES/dsh" fetch origin "$UPSTREAM_BRANCH" --depth 1 >/dev/null 2>&1
  git -C "$RES/dsh" reset --hard "origin/$UPSTREAM_BRANCH" >/dev/null
  git -C "$RES/dsh" clean -fdx --exclude=node_modules >/dev/null || true
else
  echo "[upstream] cloning $UPSTREAM_REPO..."
  mkdir -p "$RES"
  git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" "$RES/dsh"
fi

UPSTREAM_COMMIT="$(git -C "$RES/dsh" rev-parse HEAD)"
echo "[upstream] pinned commit: ${UPSTREAM_COMMIT:0:12}"

# Skip rebuild when unchanged (unless forced)
HEAD_FILE="$RES/dsh/UPSTREAM_COMMIT"
if [ "$FORCE" -eq 0 ] && [ -f "$HEAD_FILE" ] && [ "$(cat "$HEAD_FILE")" = "$UPSTREAM_COMMIT" ] \
   && [ -f "$RES/dsh/apps/cli/lib/bin.js" ] && [ -f "$RES/dsh/apps/web/dist/index.html" ]; then
  echo "[upstream] unchanged since last build -- skipping build"
else
  echo "[build] pnpm install + pnpm run build (this takes several minutes)..."
  cd "$RES/dsh"
  command -v pnpm >/dev/null || { echo "ERROR: pnpm not found -- install it first (corepack enable or npm i -g pnpm)" >&2; exit 1; }
  pnpm install --reporter=append-only
  pnpm run build
  echo "$UPSTREAM_COMMIT" > "$HEAD_FILE"
  cd "$ROOT"
fi

# -- 2. standalone Node runtime --------------------------------------------
NODE_TAR="node-$NODE_VERSION-$NODE_PLATFORM"
NODE_URL="$NODE_MIRROR/$NODE_VERSION/$NODE_TAR.tar.gz"
if [ -x "$RES/node/bin/node" ] && "$RES/node/bin/node" --version 2>/dev/null | grep -q "$NODE_VERSION"; then
  echo "[node] already present: $("$RES/node/bin/node" --version)"
else
  echo "[node] downloading $NODE_TAR..."
  rm -rf "$RES/node" "$RES/$NODE_TAR"
  curl -fL --retry 3 -o "$RES/$NODE_TAR.tar.gz" "$NODE_URL"
  tar -xzf "$RES/$NODE_TAR.tar.gz" -C "$RES"
  mv "$RES/$NODE_TAR" "$RES/node"
  rm -f "$RES/$NODE_TAR.tar.gz"
  "$RES/node/bin/node" --version
fi

# -- 3. report -------------------------------------------------------------
SIZE=$(du -sh "$RES" 2>/dev/null | cut -f1)
echo "--------------------------------------------------------------"
echo "[OK]  resources ready: $SIZE"
echo "   upstream commit: ${UPSTREAM_COMMIT:0:12}"
echo "   next: npm install && npm run dist   (produces release/*.dmg)"
