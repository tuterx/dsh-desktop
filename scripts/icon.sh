#!/usr/bin/env bash
# icon.sh -- generate assets/icon.icns from the DeepSeek whale favicon.
# Sources: <dsh>/website/public/favicon.svg (upstream) or assets/favicon.svg.
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

# svg  1024px png (macOS Quick Look renders SVG; fall back to qlmanage)
PNG1024="$TMP/favicon-1024.png"
if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SRC" -o "$PNG1024"
elif command -v magick >/dev/null 2>&1; then
  magick -background none -density 300 "$SRC" -resize 1024x1024 "$PNG1024"
else
  qlmanage -t -s 1024 -o "$TMP" "$SRC" >/dev/null 2>&1
  mv "$TMP"/*.png "$PNG1024"
fi
[ -f "$PNG1024" ] || { echo "ERROR: SVG render failed (install rsvg-convert or imagemagick)" >&2; exit 1; }

# png  iconset
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$PNG1024" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$PNG1024" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

# iconset  icns
mkdir -p assets
iconutil -c icns "$ICONSET" -o assets/icon.icns
echo "[OK]  assets/icon.icns ($(du -h assets/icon.icns | cut -f1))"
