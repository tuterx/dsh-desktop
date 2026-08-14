#!/usr/bin/env bash
# icon.sh -- generate assets/icon.icns from the DeepSeek whale favicon.
# Sources: <dsh>/website/public/favicon.svg (upstream) or assets/favicon.svg.
#
# The SVG is rendered to a TRANSPARENT-background PNG via AppKit (pyobjc):
# qlmanage produces an opaque white background, which made the icon look
# white and off-center in the Dock.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=""
for c in resources/dsh/website/public/favicon.svg assets/favicon.svg; do
  [ -f "$c" ] && SRC="$c" && break
done
[ -z "$SRC" ] && { echo "ERROR: favicon.svg not found (run prepare.sh first)" >&2; exit 1; }
echo "icon source: $SRC"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# svg -> 1024px transparent PNG
PNG1024="$TMP/favicon-1024.png"
python3 scripts/render-svg.py "$SRC" "$PNG1024" 1024

# png -> iconset
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$PNG1024" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$PNG1024" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

# iconset -> icns
mkdir -p assets
iconutil -c icns "$ICONSET" -o assets/icon.icns
echo "[OK]  assets/icon.icns ($(du -h assets/icon.icns | cut -f1))"
