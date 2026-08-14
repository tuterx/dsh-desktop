#!/usr/bin/env bash
# build-win.sh -- run prepare (ensure fresh upstream) then assemble the
# Windows zip artifact.
#
# The zip is a "green" build: electron-builder --win dir produces
# release/win-unpacked, which is then archived with bsdtar (fast store mode).
# node_modules is EXCLUDED from the archive — on Windows, pnpm junctions are
# absolute-path links with dependency cycles, so no copy of the installed
# tree is portable. The app installs deps on FIRST LAUNCH from the bundled
# offline store (resources/pnpm-store + resources/pnpm-cli).
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/prepare.sh "${1:-}"

# Electron binary downloads can be slow from GitHub; prefer the mirror when set.
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://cdn.npmmirror.com/binaries/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

echo "-- electron-builder (win, dir) ------------------------------"
# --publish never: CI detection would trigger auto-publish; the release step
# in the workflow owns publishing (same as build-dmg.sh).
npx electron-builder --win dir --publish never

echo "-- archiving zip (node_modules excluded; installed on first launch) --"
ZIP="release/DeepSeek-Harness-$(node -p "require('./package.json').version")-win-x64.zip"
rm -f "$ZIP"
# Exclude ONLY dsh's node_modules trees (all depths, incl. pnpm link cycles):
# `dsh*` matches across path separators, so resources/dsh/node_modules and
# resources/dsh/apps/*/node_modules/... are excluded, while the BUNDLED
# resources/pnpm-cli/node_modules (a required offline asset) is kept.
tar -a -cf "$ZIP" \
  --exclude='resources/dsh*/node_modules' \
  -C release/win-unpacked .
echo "[OK]  output: $ZIP ($(du -h "$ZIP" | cut -f1))"
