#!/usr/bin/env python3
"""Render an SVG to a transparent-background PNG using AppKit (pyobjc).

qlmanage renders SVG with a white background; NSImage preserves the SVG's
transparency (the DeepSeek whale has no background rect).
Usage: python3 scripts/render-svg.py <input.svg> <output.png> [size]
"""
import sys
import AppKit

def main():
    svg_path, png_path = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024

    img = AppKit.NSImage.alloc().initWithContentsOfFile_(svg_path)
    if img is None or img.size().width == 0:
        print(f"ERROR: cannot load SVG: {svg_path}", file=sys.stderr)
        return 1

    # Create a transparent bitmap and draw the image into it.
    rep = AppKit.NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
        None, size, size, 8, 4, True, False, AppKit.NSCalibratedRGBColorSpace, 0, 0
    )
    ctx = AppKit.NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep)
    AppKit.NSGraphicsContext.saveGraphicsState()
    AppKit.NSGraphicsContext.setCurrentContext_(ctx)
    AppKit.NSColor.clearColor().set()
    AppKit.NSRectFill(AppKit.NSMakeRect(0, 0, size, size))
    # Draw centered with a small margin so the whale doesn't touch the edge.
    margin = int(size * 0.04)
    draw_rect = AppKit.NSMakeRect(margin, margin, size - 2 * margin, size - 2 * margin)
    img.drawInRect_(draw_rect)
    ctx.flushGraphics()
    AppKit.NSGraphicsContext.restoreGraphicsState()

    data = rep.representationUsingType_properties_(AppKit.NSBitmapImageFileTypePNG, None)
    if not data.writeToFile_atomically_(png_path, True):
        print(f"ERROR: cannot write {png_path}", file=sys.stderr)
        return 1
    print(f"OK: {png_path} ({size}x{size})")
    return 0

if __name__ == "__main__":
    sys.exit(main())
