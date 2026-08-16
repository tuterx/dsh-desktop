'use strict'

/**
 * Preload - runs in the isolated context before the dsh page loads.
 *
 * Update UX, industry-standard pattern (VS Code / Slack style):
 *   - a notification card slides in at the window's bottom-right when an
 *     update is detected: title + version + [更新] [忽略]. 更新 starts the
 *     in-app update (download → progress bar); 忽略 silences this version.
 *   - a 28px circular icon button (the sidebar's native icon-button style,
 *     no background box) rides the settings row as the persistent
 *     indicator: dot = update available, ring = updating, check = ready to
 *     restart, amber = error.
 *
 * Both components consume the page's own design tokens (--dsw-alias-*), so
 * they match the dsh theme (light/dark) exactly instead of carrying a
 * foreign style.
 *
 * The sidebar DOM uses hashed CSS-module class names, so the badge anchor
 * is geometric: the settings trigger is the bottom-most button in the left
 * strip, and the panel's right edge is its widest non-full-width ancestor.
 * The badge repositions every 2 s and on resize; it hides while the
 * full-viewport settings panel is open and on the boot screen (no anchor).
 *
 * The isolated world shares the page DOM, so everything is injected here
 * and styled via <style> elements - no page script changes needed.
 */

const { contextBridge, ipcRenderer } = require('electron')

// ── styles ────────────────────────────────────────────────────────────────
// All colors come from the page's own tokens (with neutral fallbacks).
const BADGE_STYLE = `
/* 28px circular icon button - identical geometry to the sidebar's native
   icon buttons: transparent, hover circle only, secondary label color. */
.dsh-update-badge {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8b93a3);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483646;
  opacity: 0;
  transform: translateY(4px) scale(0.9);
  transition: opacity 0.2s ease, transform 0.2s ease, color 0.2s ease;
}
.dsh-update-badge.visible { opacity: 1; transform: translateY(0) scale(1); }
.dsh-update-badge:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.14));
}
.dsh-update-badge:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4c6ef5);
  outline-offset: 2px;
}
.dsh-update-badge svg { width: 16px; height: 16px; display: block; }
.dsh-update-badge .dsh-icon { color: currentColor; }
.dsh-update-badge.state-done .dsh-icon { color: var(--dsw-alias-success, #22c55e); }
.dsh-update-badge.state-error .dsh-icon { color: var(--dsw-alias-danger, #f59e0b); }

/* Progress ring - only while downloading. */
.dsh-update-badge .dsh-update-ring {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: none;
}
.dsh-update-badge.state-downloading .dsh-update-ring { display: block; }
.dsh-update-badge .dsh-update-ring circle {
  fill: none;
  stroke: var(--dsw-alias-brand-primary, #4c6ef5);
  stroke-width: 2.5;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: center;
}

/* Notification dot - update available, one-time pulse on first show. */
.dsh-update-badge .dsh-dot {
  position: absolute;
  top: 2px; right: 2px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4c6ef5);
  display: none;
}
.dsh-update-badge.state-ready .dsh-dot { display: block; }
.dsh-update-badge.entering .dsh-dot { animation: dsh-pulse 1.2s ease-out 1; }
@keyframes dsh-pulse {
  0%   { transform: scale(1); }
  50%  { transform: scale(2.2); opacity: 0.35; }
  100% { transform: scale(1); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .dsh-update-badge,
  .dsh-update-badge * { transition: none !important; animation: none !important; }
}
`

// Notification card - the page's own surface tokens, bottom-right corner.
const NOTIFY_STYLE = `
.dsh-update-notify {
  position: fixed;
  right: 20px;
  bottom: 84px; /* clears the composer row */
  width: 320px;
  max-width: calc(100vw - 40px);
  box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-2, rgba(19, 22, 30, 0.96));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.09));
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  color: var(--dsw-alias-label-primary, #e6edf3);
  font: 13px/1.5 -apple-system, "PingFang SC", "Inter", sans-serif;
  padding: 14px 14px 12px;
  z-index: 2147483646;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}
.dsh-update-notify.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
.dsh-update-notify .dsh-notify-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.dsh-update-notify .dsh-notify-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #e6edf3);
}
.dsh-update-notify .dsh-notify-close {
  width: 22px; height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-caption, #8b93a3);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.dsh-update-notify .dsh-notify-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.14));
  color: var(--dsw-alias-label-primary, #e6edf3);
}
.dsh-update-notify .dsh-notify-close svg { width: 12px; height: 12px; }
.dsh-update-notify .dsh-notify-body {
  color: var(--dsw-alias-label-caption, #9aa3b2);
  margin-bottom: 12px;
  word-break: break-word;
}
.dsh-update-notify .dsh-notify-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.2));
  overflow: hidden;
  margin-bottom: 12px;
}
.dsh-update-notify .dsh-notify-progress > div {
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary, #4c6ef5);
  width: 0%;
  transition: width 0.2s ease;
}
.dsh-update-notify .dsh-notify-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsh-update-notify .dsh-notify-btn {
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  font: 600 12.5px/1 -apple-system, "PingFang SC", "Inter", sans-serif;
  cursor: pointer;
}
.dsh-update-notify .dsh-notify-btn.primary {
  background: var(--dsw-alias-button-primary-fill, #4c6ef5);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-update-notify .dsh-notify-btn.primary:hover {
  background: var(--dsw-alias-button-primary-hover, #3b5bdb);
}
.dsh-update-notify .dsh-notify-btn.ghost {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
  color: var(--dsw-alias-label-secondary, #b6bfcc);
}
.dsh-update-notify .dsh-notify-btn.ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.14));
}

@media (prefers-reduced-motion: reduce) {
  .dsh-update-notify { transition: none !important; }
}
`

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
  close: `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
</svg>`,
}

const RING_R = 9 // ring radius in the 24x24 ring viewBox
const RING_LEN = 2 * Math.PI * RING_R

// ── state ─────────────────────────────────────────────────────────────────
let badge = null
let notify = null
let notifyDismissed = false // user closed/ignored the card: never re-show it
let badgeState = 'hidden' // hidden | ready | downloading | done | error | uptodate
let doneKind = 'zip'
let pulsed = false
let uptodateTimer = null
let positionStarted = false

const BADGE_SIZE = 28
const SIDEBAR_PAD = 12 // matches the sidebar's --dsh-sidebar-inline-padding
const ANCHOR_INTERVAL_MS = 2000

// ── badge element ─────────────────────────────────────────────────────────
function ensureBadge() {
  if (badge) return badge
  const style = document.createElement('style')
  style.textContent = BADGE_STYLE
  ;(document.head || document.documentElement).appendChild(style)

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  ring.setAttribute('class', 'dsh-update-ring')
  ring.setAttribute('viewBox', '0 0 24 24')
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12')
  circle.setAttribute('r', String(RING_R))
  circle.setAttribute('stroke-dasharray', String(RING_LEN))
  circle.setAttribute('stroke-dashoffset', String(RING_LEN))
  ring.appendChild(circle)

  badge = document.createElement('button')
  badge.className = 'dsh-update-badge'
  badge.type = 'button'
  badge.innerHTML = ICONS.arrow
  badge.appendChild(ring)
  badge.appendChild(Object.assign(document.createElement('span'), { className: 'dsh-dot' }))
  badge.addEventListener('click', () => {
    if (badgeState === 'ready') {
      showNotify('available') // reopen the notification
    } else if (badgeState === 'done') {
      ipcRenderer.send('update:install') // restart-and-apply
    } else if (badgeState === 'error') {
      ipcRenderer.send('update:check')
    }
    // downloading: async in flight, no-op
  })
  ;(document.body || document.documentElement).appendChild(badge)
  startPositioning()
  return badge
}

/** Render one badge state (icon shape + classes + ring). */
function showBadge(state, percent) {
  const el = ensureBadge()
  badgeState = state
  el.classList.toggle('visible', state !== 'hidden')
  el.classList.toggle('state-ready', state === 'ready')
  el.classList.toggle('state-downloading', state === 'downloading')
  el.classList.toggle('state-done', state === 'done' || state === 'uptodate')
  el.classList.toggle('state-error', state === 'error')
  el.setAttribute('aria-disabled', String(state === 'downloading'))

  const icon = state === 'done' || state === 'uptodate' ? 'check'
    : state === 'error' ? 'refresh'
    : 'arrow'
  const iconBox = document.createElement('div')
  iconBox.innerHTML = ICONS[icon]
  el.querySelector('.dsh-icon')?.replaceWith(iconBox.firstElementChild)

  const circle = el.querySelector('.dsh-update-ring circle')
  if (circle) {
    if (state === 'downloading' && typeof percent === 'number') {
      circle.setAttribute('stroke-dashoffset', String(RING_LEN * (1 - percent / 100)))
    } else {
      circle.setAttribute('stroke-dashoffset', String(RING_LEN))
    }
  }

  if (state === 'ready' && !pulsed) {
    pulsed = true
    el.classList.add('entering')
    setTimeout(() => el.classList.remove('entering'), 1500)
  }
}

// ── notification card ─────────────────────────────────────────────────────
function ensureNotify() {
  if (notify) return notify
  const style = document.createElement('style')
  style.textContent = NOTIFY_STYLE
  ;(document.head || document.documentElement).appendChild(style)

  notify = document.createElement('div')
  notify.className = 'dsh-update-notify'
  notify.setAttribute('role', 'dialog')
  notify.setAttribute('aria-label', '更新通知')
  ;(document.body || document.documentElement).appendChild(notify)
  return notify
}

/** Render the notification for a state; show=false hides it. */
function showNotify(state, opts = {}) {
  const el = ensureNotify()
  const visible = state !== 'hidden'
  // The user dismissed this card once — progress/done/error events fire
  // constantly (every ~64KB while downloading) and would re-open it
  // immediately after closing. Never nag again this session; the badge
  // keeps indicating state.
  if (notifyDismissed && visible) return
  el.classList.toggle('visible', visible)
  if (!visible) return

  const title = state === 'available' ? '发现新版本'
    : state === 'downloading' ? '正在下载更新'
    : state === 'installing' ? '正在准备更新'
    : state === 'done' ? '更新就绪'
    : state === 'error' ? '更新失败'
    : '检查更新'
  const body = state === 'available' ? `版本 ${opts.shortCommit} 可用`
    : state === 'downloading' ? (opts.percent ?? 0) + '%'
    : state === 'installing' ? '解压更新包，应用即将自动重启…'
    : state === 'done' ? '重启应用后生效，自动完成安装。'
    : state === 'error' ? (opts.message || '下载失败，请重试。')
    : ''
  // [更新/立即重启/重试] + [忽略/稍后]
  const primaryLabel = state === 'done' ? '立即重启'
    : state === 'error' ? '重试'
    : '更新'
  const secondaryLabel = state === 'done' ? '稍后' : '忽略'
  const primaryAction = state === 'done' ? 'update:install'
    : state === 'error' ? 'update:download'
    : 'update:download'
  const secondaryAction = state === 'done' ? 'notify:hide'
    : state === 'error' ? 'update:ignore'
    : 'update:ignore'

  el.innerHTML = `
<div class="dsh-notify-head">
  <div class="dsh-notify-title">${title}</div>
  <button class="dsh-notify-close" type="button" aria-label="关闭">${ICONS.close}</button>
</div>
<div class="dsh-notify-body"></div>
${state === 'downloading' ? '<div class="dsh-notify-progress"><div></div></div>' : ''}
${state === 'downloading' || state === 'installing' ? '' : `
<div class="dsh-notify-actions">
  <button class="dsh-notify-btn ghost" type="button" data-action="${secondaryAction}">${secondaryLabel}</button>
  <button class="dsh-notify-btn primary" type="button" data-action="${primaryAction}">${primaryLabel}</button>
</div>`}`
  el.querySelector('.dsh-notify-body').textContent = body
  if (state === 'downloading') {
    el.querySelector('.dsh-notify-progress > div').style.width = `${opts.percent ?? 0}%`
  }
  el.querySelector('.dsh-notify-close').addEventListener('click', () => {
    notifyDismissed = true
    showNotify('hidden') // dismiss the card, keep the badge
  })
  for (const btn of el.querySelectorAll('.dsh-notify-btn')) {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action
      if (action === 'notify:hide') {
        notifyDismissed = true
        showNotify('hidden')
      } else if (action === 'update:ignore') {
        ipcRenderer.send('update:ignore')
        showNotify('hidden')
        showBadge('hidden')
      } else {
        ipcRenderer.send(action)
      }
    })
  }
}

// ── positioning: anchored to the sidebar's settings row ───────────────────
/**
 * The settings-row anchor: { centerY, right } where centerY is the settings
 * trigger's vertical center and right is the sidebar panel's right edge.
 */
function anchorRect() {
  const vw = window.innerWidth
  const strip = Array.from(document.querySelectorAll('button'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => r.width > 0
      // The badge itself is a button in the left strip - it must never be
      // its own anchor (that drifts it left every reposition tick).
      && !(badge && (el === badge || badge.contains(el)))
      && r.left < Math.min(320, vw * 0.3))
  if (!strip.length) return null
  const settings = strip.reduce((a, b) => (b.r.bottom > a.r.bottom ? b : a))
  let left = settings.r.left
  let right = settings.r.right
  let node = settings.el
  while (node.parentElement) {
    const pr = node.parentElement.getBoundingClientRect()
    if (pr.width <= 0 || pr.width > vw * 0.6 || pr.left > settings.r.left + 40) break
    left = Math.min(left, pr.left)
    right = Math.max(right, pr.right)
    node = node.parentElement
  }
  return { centerY: settings.r.top + settings.r.height / 2, left, right }
}

/**
 * Place the badge on the settings row, flush to the panel's right edge.
 * Hidden while the settings panel is open, on the boot screen (no anchor),
 * and when the sidebar is collapsed to the narrow rail.
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

function startPositioning() {
  if (positionStarted) return
  positionStarted = true
  positionBadge()
  window.addEventListener('resize', positionBadge)
  setInterval(positionBadge, ANCHOR_INTERVAL_MS)
}

// ── IPC wiring ────────────────────────────────────────────────────────────
ipcRenderer.on('update:available', (_e, info) => {
  showBadge('ready')
  showNotify('available', { shortCommit: info.shortCommit })
})
ipcRenderer.on('update:progress', (_e, percent) => {
  showBadge('downloading', percent)
  showNotify('downloading', { percent })
})
ipcRenderer.on('update:done', (_e, info) => {
  doneKind = info.kind || 'zip'
  showBadge('done')
  showNotify('done', { shortCommit: info.shortCommit })
})
ipcRenderer.on('update:error', (_e, message) => {
  showBadge('error')
  showNotify('error', { message })
})
// Install is being prepared (zip extraction) - the app quits and relaunches.
ipcRenderer.on('update:installing', () => {
  showNotify('installing')
})
// Manual check result: already latest - green check, auto-hides after 3 s.
ipcRenderer.on('update:uptodate', () => {
  showBadge('uptodate')
  showNotify('hidden')
  uptodateTimer = setTimeout(() => showBadge('hidden'), 3000)
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
