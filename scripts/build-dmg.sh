#!/usr/bin/env bash
# build-dmg.sh -- run prepare (ensure fresh upstream) then electron-builder  DMG.
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/prepare.sh "${1:-}"

# Electron binary downloads can be slow from GitHub; prefer the mirror when set.
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://cdn.npmmirror.com/binaries/electron/}"

echo "-- electron-builder -----------------------------------------"
npx electron-builder --mac dmg --arm64 "$@"
echo "[OK]  DMG output: $(ls -t release/*.dmg | head -1)"
