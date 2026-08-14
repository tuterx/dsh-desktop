'use strict'

/**
 * Appearance settings for the dsh desktop shell.
 *
 * Persisted to <userData>/appearance.json. Applied by:
 *  - nativeTheme.themeSource         — system chrome (scrollbars, menus, dialogs)
 *  - body[data-ds-dark-theme] attr   — the dsh UI's own theme switch
 *  - injected CSS                    — font size (zoom), font family, wallpaper
 *
 * dsh UI discovery (no dsh source changes):
 *  - dark mode = body[data-ds-dark-theme] present (all dark variables hang
 *    off that selector in the built CSS)
 *  - fonts use px (no rem scaling) → scale the whole UI with CSS `zoom`
 *  - wallpaper renders as a faint fixed overlay (pointer-events: none) so it
 *    works on top of dsh's opaque background layers
 */

const { app, nativeTheme } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const DEFAULTS = {
  theme: 'system', // 'dark' | 'light' | 'system' — follow the OS by default
  fontSize: 'normal', // 'small' | 'normal' | 'large' | 'xlarge'
  fontFamily: 'system', // 'system' | 'rounded' | 'mono'
  wallpaper: 'none', // 'none' | 'gradient-dark' | 'gradient-light' | 'custom:<path>'
}

function configPath() {
  return join(app.getPath('userData'), 'appearance.json')
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(configPath(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(cfg) {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

/** Whether the configured theme resolves to dark (system follows the OS). */
function isDark(cfg = load()) {
  if (cfg.theme === 'dark') return true
  if (cfg.theme === 'light') return false
  return nativeTheme.shouldUseDarkColors
}

/**
 * Build the CSS block that implements font size / family / wallpaper.
 * Fonts are px-based in dsh → `zoom` scales the whole UI uniformly.
 */
function appearanceCss(cfg = load()) {
  const parts = []

  const zooms = { small: 0.92, normal: 1, large: 1.1, xlarge: 1.2 }
  const zoom = zooms[cfg.fontSize] ?? 1
  if (zoom !== 1) parts.push(`html { zoom: ${zoom}; }`)

  const fonts = {
    system: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`,
    rounded: `-apple-system, "SF Pro Rounded", "PingFang SC", "Hiragino Sans GB", sans-serif`,
    mono: `"SF Mono", ui-monospace, Menlo, Consolas, "PingFang SC", monospace`,
  }
  if (fonts[cfg.fontFamily]) parts.push(`body { font-family: ${fonts[cfg.fontFamily]} !important; }`)

  if (cfg.wallpaper === 'gradient-dark') {
    parts.push(`body::after {
      content: ""; position: fixed; inset: 0; z-index: 2147483647;
      background: linear-gradient(160deg, rgba(77,107,254,.16), rgba(15,20,32,.35) 55%, rgba(11,14,20,.5));
      pointer-events: none; mix-blend-mode: overlay;
    }`)
  } else if (cfg.wallpaper === 'gradient-light') {
    parts.push(`body::after {
      content: ""; position: fixed; inset: 0; z-index: 2147483647;
      background: linear-gradient(160deg, rgba(255,255,255,.5), rgba(200,215,255,.35) 60%, rgba(160,180,235,.3));
      pointer-events: none; mix-blend-mode: soft-light;
    }`)
  } else if (cfg.wallpaper && cfg.wallpaper.startsWith('custom:')) {
    const file = cfg.wallpaper.slice('custom:'.length)
    if (file) {
      const url = `file://${file.replace(/^\/+/, '/')}`
      parts.push(`body::after {
        content: ""; position: fixed; inset: 0; z-index: 2147483647;
        background: url("${url}") center / cover no-repeat;
        opacity: .22; pointer-events: none; mix-blend-mode: overlay;
      }`)
    }
  }

  return parts.join('\n')
}

/** Toggle the dsh UI theme by setting/removing body[data-ds-dark-theme]. */
function applyThemeToPage(win, dark) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.executeJavaScript(
    `document.body.${dark ? 'setAttribute' : 'removeAttribute'}('data-ds-dark-theme', '')`,
    true,
  ).catch(() => { /* page not ready */ })
}

/**
 * Give the traffic lights a clear zone: dsh's sidebar starts at the very top
 * left (x=0,y=0), so push its top content down by the traffic-light height.
 * Locates the sidebar by geometry (fixed 280px rail at the window's origin),
 * which is stable across dsh releases.
 */
const SIDEBAR_SAFE_ZONE_JS = `(() => {
  try {
    const candidates = [...document.querySelectorAll('div, aside, nav, section')]
    const sidebar = candidates.find((el) => {
      const r = el.getBoundingClientRect()
      return r.x === 0 && r.y === 0 && r.width >= 180 && r.width <= 420 && r.height > 500
    })
    if (sidebar && !sidebar.dataset.dshSafeZone) {
      sidebar.dataset.dshSafeZone = '1'
      sidebar.style.paddingTop = '40px'
    }
  } catch (e) { /* best effort */ }
})()`

module.exports = { DEFAULTS, load, save, isDark, appearanceCss, applyThemeToPage, SIDEBAR_SAFE_ZONE_JS }
