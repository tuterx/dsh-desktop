'use strict'

/**
 * Preload - runs in the isolated context before the dsh page loads.
 *
 * Provides the update badge: a glass floating-action button riding the bottom
 * row of the LEFT sidebar — the same row as the settings trigger, rightmost
 * of that panel (not the window corner). Mental model: an in-app
 * notification with a single primary action -
 *   see it (one-time pulse) → understand it (tooltip: version + what to do)
 *   → act (click = download with visible progress) → done (green check,
 *   click = install). Errors are visible and retryable.
 *
 * The sidebar DOM uses hashed CSS-module class names, so the anchor is
 * geometric: the settings trigger is the bottom-most button in the left
 * strip, and the panel's right edge is its widest non-full-width ancestor.
 * The badge repositions every 2 s and on resize; it hides while the
 * full-viewport settings panel is open and on the boot screen (no anchor).
 *
 * The isolated world shares the page DOM, so the badge is injected here and
 * styled via a <style> element - no page script changes needed.
 */

const { contextBridge, ipcRenderer } = require('electron')

// ── update badge ─────────────────────────────────────────────────────────
const BADGE_STYLE = `
/* Surface: neutral glass, theme-aware (dsh sets body[data-ds-dark-theme] in
   dark mode; absence = light). 44px hit area per touch-target guidelines.
   Fallback corner position lives in CSS; the JS anchor (sidebar row) sets
   inline left/top once the sidebar exists. */
.dsh-update-badge {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  padding: 0;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.16), 0 1px 3px rgba(15, 23, 42, 0.10);
  backdrop-filter: blur(12px) saturate(1.4);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483646;
  opacity: 0;
  transform: translateY(8px) scale(0.92);
  transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
}
body[data-ds-dark-theme] .dsh-update-badge {
  background: rgba(19, 22, 30, 0.88);
  border-color: rgba(255, 255, 255, 0.09);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.35);
}
.dsh-update-badge.visible { opacity: 1; transform: translateY(0) scale(1); }
.dsh-update-badge:hover {
  border-color: rgba(76, 110, 245, 0.45);
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.22), 0 1px 3px rgba(15, 23, 42, 0.10);
}
body[data-ds-dark-theme] .dsh-update-badge:hover {
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(76, 110, 245, 0.35);
}
.dsh-update-badge:focus-visible {
  outline: 2px solid #4c6ef5;
  outline-offset: 2px;
}
.dsh-update-badge svg { width: 20px; height: 20px; display: block; }
.dsh-update-badge .dsh-icon {
  color: #4c6ef5; /* brand indigo - update available */
  transition: color 0.2s ease;
}
.dsh-update-badge.state-done .dsh-icon { color: #22c55e; } /* done/up-to-date - green */
.dsh-update-badge.state-error .dsh-icon { color: #f59e0b; } /* error - amber, icon swaps to retry */
.dsh-update-badge.state-downloading .dsh-icon { color: #94a3b8; } /* muted while in flight */

/* Progress ring - only during download (state is never color-only). */
.dsh-update-badge .dsh-update-ring {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: none;
}
.dsh-update-badge.state-downloading .dsh-update-ring { display: block; }
.dsh-update-badge .dsh-update-ring circle {
  fill: none;
  stroke: #4c6ef5;
  stroke-width: 3.5;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: center;
}

/* Notification dot - one-time pulse when the badge first appears. */
.dsh-update-badge .dsh-dot {
  position: absolute;
  top: 8px; right: 8px;
  width: 9px; height: 9px;
  border-radius: 50%;
  background: #4c6ef5;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.92);
  display: none;
}
body[data-ds-dark-theme] .dsh-update-badge .dsh-dot {
  box-shadow: 0 0 0 2px rgba(19, 22, 30, 0.88);
}
.dsh-update-badge.state-ready .dsh-dot,
.dsh-update-badge.state-error .dsh-dot { display: block; }
.dsh-update-badge.state-error .dsh-dot { background: #f59e0b; }
.dsh-update-badge.entering .dsh-dot { animation: dsh-pulse 1.2s ease-out 1; }
@keyframes dsh-pulse {
  0%   { transform: scale(1); }
  50%  { transform: scale(2); opacity: 0.35; }
  100% { transform: scale(1); opacity: 1; }
}

/* Tooltip - appears on hover/focus, never blocks interaction. The badge sits
   at the LEFT side of the window (sidebar row), so the bubble opens right. */
.dsh-update-badge .dsh-update-tooltip {
  position: absolute;
  left: 52px;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.97);
  color: #0f172a;
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.14);
  font: 12px/1.5 -apple-system, "PingFang SC", "Inter", sans-serif;
  padding: 8px 12px;
  border-radius: 10px;
  white-space: nowrap;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
body[data-ds-dark-theme] .dsh-update-badge .dsh-update-tooltip {
  background: rgba(24, 28, 38, 0.95);
  color: #e6edf3;
  border-color: rgba(255, 255, 255, 0.10);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}
.dsh-update-badge:hover .dsh-update-tooltip,
.dsh-update-badge:focus-visible .dsh-update-tooltip { opacity: 1; }

/* Respect reduced-motion: no entrance animation, no pulse. */
@media (prefers-reduced-motion: reduce) {
  .dsh-update-badge,
  .dsh-update-badge * { transition: none !important; animation: none !important; }
}
`

// Consistent 24-viewBox stroke icons (Lucide-style), state shown by SHAPE
// as well as color - never color-only.
const ICONS = {
  arrow: `
<svg class="dsh-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 4v11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M7.5 11.5L12 16l4.5-4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M5 20h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
</svg>`,
  check: `
<svg class="dsh-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M4.5 12.5l5 5L19.5 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
  refresh: `
<svg class="dsh-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M21 3v5h-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
}

const RING_R = 18 // circle radius in the 44x44 ring viewBox
const RING_LEN = 2 * Math.PI * RING_R

let badge = null
let badgeState = 'hidden' // hidden | ready | downloading | done | error | uptodate
let doneKind = 'zip' // last completed update's kind: zip (in-place) | dmg (manual)
let pulsed = false // one attention pulse per session
let uptodateTimer = null
let positionStarted = false

// ── positioning: anchored to the sidebar's settings row ───────────────────
const BADGE_SIZE = 44
const SIDEBAR_PAD = 12 // matches the sidebar's --dsh-sidebar-inline-padding
const ANCHOR_INTERVAL_MS = 2000

/**
 * The settings-row anchor: { centerY, right } where centerY is the settings
 * trigger's vertical center and right is the sidebar panel's right edge.
 * The sidebar class names are hashed CSS modules, so locate by geometry:
 * settings = the bottom-most button in the left strip; the panel's right
 * edge = the widest non-full-width ancestor of that button.
 */
function anchorRect() {
  const vw = window.innerWidth
  const strip = Array.from(document.querySelectorAll('button'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => r.width > 0
      // The badge itself is a button in the left strip - it must never be
      // its own anchor (that drifts it 12px left every reposition tick).
      && !(badge && (el === badge || badge.contains(el)))
      && r.left < Math.min(320, vw * 0.3))
  if (!strip.length) return null
  const settings = strip.reduce((a, b) => (b.r.bottom > a.r.bottom ? b : a))
  let left = settings.r.left
  let right = settings.r.right
  let node = settings.el
  while (node.parentElement) {
    const pr = node.parentElement.getBoundingClientRect()
    // Full-width frame or a column outside the sidebar: the anchor is done.
    if (pr.width <= 0 || pr.width > vw * 0.6 || pr.left > settings.r.left + 40) break
    left = Math.min(left, pr.left)
    right = Math.max(right, pr.right)
    node = node.parentElement
  }
  return { centerY: settings.r.top + settings.r.height / 2, left, right }
}

/**
 * Place the badge on the settings row, flush to the panel's right edge.
 * Hidden while the full-viewport settings panel is open, on the boot screen
 * (no anchor), and when the sidebar is collapsed to the narrow rail (the
 * badge would cover the settings trigger there) - the 检查更新… menu item
 * remains available.
 */
function positionBadge() {
  const el = ensureBadge()
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
    el.style.display = 'none'
    return
  }
  const a = anchorRect()
  if (!a || a.right - a.left < 80) { el.style.display = 'none'; return }
  el.style.display = ''
  el.style.left = `${Math.round(a.right - BADGE_SIZE - SIDEBAR_PAD)}px`
  el.style.top = `${Math.round(a.centerY - BADGE_SIZE / 2)}px`
  el.style.right = 'auto'
  el.style.bottom = 'auto'
}

/** Kick off anchor following once (on first badge creation). */
function startPositioning() {
  if (positionStarted) return
  positionStarted = true
  positionBadge()
  window.addEventListener('resize', positionBadge)
  setInterval(positionBadge, ANCHOR_INTERVAL_MS)
}

function ensureBadge() {
  if (badge) return badge
  const style = document.createElement('style')
  style.textContent = BADGE_STYLE
  ;(document.head || document.documentElement).appendChild(style)

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  ring.setAttribute('class', 'dsh-update-ring')
  ring.setAttribute('viewBox', '0 0 44 44')
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '22'); circle.setAttribute('cy', '22')
  circle.setAttribute('r', String(RING_R))
  circle.setAttribute('stroke-dasharray', String(RING_LEN))
  circle.setAttribute('stroke-dashoffset', String(RING_LEN))
  ring.appendChild(circle)

  badge = document.createElement('button')
  badge.className = 'dsh-update-badge'
  badge.type = 'button'
  badge.innerHTML = ICONS.arrow
  badge.appendChild(ring)
  const dot = document.createElement('span')
  dot.className = 'dsh-dot'
  badge.appendChild(dot)
  const tooltip = document.createElement('span')
  tooltip.className = 'dsh-update-tooltip'
  tooltip.setAttribute('role', 'status')
  tooltip.setAttribute('aria-live', 'polite')
  badge.appendChild(tooltip)
  badge.addEventListener('click', () => {
    if (badgeState === 'ready') {
      ipcRenderer.send('update:download')
    } else if (badgeState === 'done') {
      // zip: restart-and-apply in place; dmg: open the installer manually.
      ipcRenderer.send(doneKind === 'zip' ? 'update:install' : 'update:open-installer')
    } else if (badgeState === 'error') {
      ipcRenderer.send('update:check') // retry the check
    }
    // downloading: async in flight, no-op
  })
  ;(document.body || document.documentElement).appendChild(badge)
  startPositioning()
  return badge
}

/**
 * Render one badge state. text = tooltip/aria content; percent = download
 * progress (0-100) when downloading.
 */
function showBadge(state, text, percent) {
  clearTimeout(uptodateTimer)
  const el = ensureBadge()
  badgeState = state
  const visible = state !== 'hidden'

  el.classList.toggle('visible', visible)
  el.classList.toggle('state-ready', state === 'ready')
  el.classList.toggle('state-downloading', state === 'downloading')
  el.classList.toggle('state-done', state === 'done' || state === 'uptodate')
  el.classList.toggle('state-error', state === 'error')
  el.setAttribute('aria-disabled', String(state === 'downloading'))

  // Icon shape carries the state (arrow → check → retry), color only accents.
  const icon = state === 'done' || state === 'uptodate' ? 'check'
    : state === 'error' ? 'refresh'
    : 'arrow'
  const iconBox = document.createElement('div')
  iconBox.innerHTML = ICONS[icon]
  el.querySelector('.dsh-icon')?.replaceWith(iconBox.firstElementChild)

  // Progress ring.
  const circle = el.querySelector('.dsh-update-ring circle')
  if (circle) {
    if (state === 'downloading' && typeof percent === 'number') {
      circle.setAttribute('stroke-dashoffset', String(RING_LEN * (1 - percent / 100)))
    } else {
      circle.setAttribute('stroke-dashoffset', String(RING_LEN))
    }
  }

  const tooltip = el.querySelector('.dsh-update-tooltip')
  if (tooltip) tooltip.textContent = text || ''
  el.setAttribute('aria-label', text || '更新')

  // One-time attention pulse when the badge first appears.
  if (visible && (state === 'ready' || state === 'error') && !pulsed) {
    pulsed = true
    el.classList.add('entering')
    setTimeout(() => el.classList.remove('entering'), 1500)
  }
}

// ── IPC wiring ────────────────────────────────────────────────────────────
ipcRenderer.on('update:available', (_e, info) => {
  showBadge('ready', `新版本 ${info.shortCommit} 可用，自动下载中…`, 0)
})
ipcRenderer.on('update:progress', (_e, percent) => {
  showBadge('downloading', `正在下载更新 ${percent}%`, percent)
})
ipcRenderer.on('update:done', (_e, info) => {
  doneKind = info.kind || 'zip'
  showBadge('done', doneKind === 'zip'
    ? '更新已就绪，点击重启安装'
    : '下载完成，点击安装', 100)
})
ipcRenderer.on('update:error', (_e, message) => {
  showBadge('error', `检查失败: ${message}\n点击重试`, 0)
})
// Manual check result: already latest - green check, auto-hides after 3 s
// (toast rule: transient messages dismiss themselves).
ipcRenderer.on('update:uptodate', (_e, info) => {
  showBadge('uptodate', `已是最新版本 (${info.shortCommit})`, 100)
  uptodateTimer = setTimeout(() => showBadge('hidden', '', 0), 3000)
})

// ── bridge ───────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  electron: process.versions.electron,
  node: process.versions.node,
  updater: {
    onAvailable: (cb) => ipcRenderer.on('update:available', (_e, i) => cb(i)),
    onProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  },
})
