'use strict'

/**
 * Preload - runs in the isolated context before the dsh page loads.
 *
 * Provides:
 *  - the update badge: a blue SVG download icon pinned to the bottom-right
 *    (same row as the dsh sidebar's settings button). Shows when the updater
 *    finds a newer build; clicking it downloads the new DMG (progress ring
 *    while downloading), then opens it for installation.
 *  - a tiny dshDesktop descriptor for shell integration.
 *
 * The isolated world shares the page DOM, so the badge is injected here and
 * styled via a <style> element - no page script changes needed.
 */

const { contextBridge, ipcRenderer } = require('electron')

// ── update badge ─────────────────────────────────────────────────────────
// Bottom-right, on the same row as the dsh sidebar's settings button.
const BADGE_STYLE = `
.dsh-update-badge {
  position: fixed;
  right: 16px;
  bottom: 14px;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(135deg, #5b7cfa, #3b5bdb);
  box-shadow: 0 4px 14px rgba(77, 107, 254, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483646;
  opacity: 0;
  transform: translateY(10px) scale(0.9);
  transition: opacity 0.25s ease, transform 0.25s ease;
  border: none;
  padding: 0;
}
.dsh-update-badge.visible { opacity: 1; transform: translateY(0) scale(1); }
.dsh-update-badge:hover { filter: brightness(1.12); }
.dsh-update-badge svg { width: 20px; height: 20px; display: block; }
.dsh-update-badge .dsh-update-ring {
  position: absolute; inset: 0; width: 100%; height: 100%;
}
.dsh-update-badge .dsh-update-ring circle {
  fill: none; stroke: rgba(255,255,255,0.85); stroke-width: 3;
  stroke-linecap: round; transform: rotate(-90deg); transform-origin: center;
}
.dsh-update-badge.downloading svg.arrow { display: none; }
.dsh-update-badge .dsh-update-tooltip {
  position: absolute;
  right: 46px;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(20, 22, 28, 0.92);
  color: #e6edf3;
  font: 12px/1.4 -apple-system, "PingFang SC", sans-serif;
  padding: 6px 10px;
  border-radius: 8px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.dsh-update-badge:hover .dsh-update-tooltip { opacity: 1; }
.dsh-update-badge.done { background: linear-gradient(135deg, #2fb344, #1d8f3a); }
`

const ARROW_SVG = `
<svg class="arrow" viewBox="0 0 24 24" fill="none">
  <path d="M12 4v11" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M7.5 11.5L12 16l4.5-4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M5 20h14" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
</svg>
`

let badge = null
let badgeState = 'hidden' // hidden | ready | downloading | done | error

function ensureBadge() {
  if (badge) return badge
  const style = document.createElement('style')
  style.textContent = BADGE_STYLE
  ;(document.head || document.documentElement).appendChild(style)

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  ring.setAttribute('class', 'dsh-update-ring')
  ring.setAttribute('viewBox', '0 0 38 38')
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '19'); circle.setAttribute('cy', '19')
  circle.setAttribute('r', '15')
  circle.setAttribute('stroke-dasharray', `${2 * Math.PI * 15}`)
  circle.setAttribute('stroke-dashoffset', `${2 * Math.PI * 15}`)
  ring.appendChild(circle)

  badge = document.createElement('button')
  badge.className = 'dsh-update-badge'
  badge.innerHTML = ARROW_SVG
  badge.appendChild(ring)
  const tooltip = document.createElement('span')
  tooltip.className = 'dsh-update-tooltip'
  badge.appendChild(tooltip)
  badge.addEventListener('click', () => {
    if (badgeState === 'ready') {
      ipcRenderer.send('update:download')
    } else if (badgeState === 'done') {
      ipcRenderer.send('update:open-installer')
    }
  })
  ;(document.body || document.documentElement).appendChild(badge)
  return badge
}

function showBadge(state, text, percent) {
  clearTimeout(uptodateTimer)
  const el = ensureBadge()
  badgeState = state
  el.classList.toggle('visible', state !== 'hidden')
  el.classList.toggle('downloading', state === 'downloading')
  el.classList.toggle('done', state === 'done')
  const tooltip = el.querySelector('.dsh-update-tooltip')
  if (tooltip) tooltip.textContent = text || ''
  if (state === 'downloading' && typeof percent === 'number') {
    const circle = el.querySelector('.dsh-update-ring circle')
    if (circle) {
      const len = 2 * Math.PI * 15
      circle.setAttribute('stroke-dashoffset', String(len * (1 - percent / 100)))
    }
  }
  if (state !== 'downloading') {
    const circle = el.querySelector('.dsh-update-ring circle')
    if (circle) circle.setAttribute('stroke-dashoffset', String(2 * Math.PI * 15))
  }
}

let uptodateTimer = null

// ── IPC wiring ────────────────────────────────────────────────────────────
ipcRenderer.on('update:available', (_e, info) => {
  showBadge('ready', `发现新版本 (${info.shortCommit})\n点击下载更新`, 0)
})
ipcRenderer.on('update:progress', (_e, percent) => {
  showBadge('downloading', `正在下载 ${percent}%`, percent)
})
ipcRenderer.on('update:done', (_e, info) => {
  showBadge('done', '下载完成，点击安装', 100)
})
ipcRenderer.on('update:error', (_e, message) => {
  showBadge('ready', `更新失败: ${message}`, 0)
})
// Manual check result: already latest - green badge, auto-hides after 3 s.
ipcRenderer.on('update:uptodate', (_e, info) => {
  showBadge('done', `已是最新版本 (${info.shortCommit})`, 100)
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
