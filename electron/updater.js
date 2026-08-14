'use strict'

/**
 * Auto-update checks for the dsh desktop app.
 *
 * The CI workflow publishes one GitHub Release per upstream commit
 * (tag "dsh-<commit>", asset DeepSeek-Harness-*.dmg). This module:
 *   1. compares the CURRENT bundled upstream commit (resources/UPSTREAM_COMMIT)
 *      with the LATEST release tag on github.com/tuterx/dsh-desktop
 *   2. downloads the new DMG to ~/Downloads with progress events
 *
 * Updating is download-and-open (not silent): the DMG is unsigned, so
 * Squirrel-style auto-install is not possible. The user installs the new
 * build from the downloaded DMG.
 */

const { app, shell } = require('electron')
const { createWriteStream } = require('node:fs')
const { join } = require('node:path')
const https = require('node:https')
const { net } = require('electron')

const REPO = 'tuterx/dsh-desktop'
const CHECK_INTERVAL_MS = 30 * 60 * 1000 // re-check every 30 min
const CHECK_DELAY_MS = 8 * 1000 // after window is up

/** The upstream commit this build was made from. */
function bundledCommit() {
  try {
    const path = process.resourcesPath
      ? join(process.resourcesPath, 'UPSTREAM_COMMIT')
      : join(__dirname, '..', 'resources', 'UPSTREAM_COMMIT')
    return require('node:fs').readFileSync(path, 'utf8').trim()
  } catch {
    return 'unknown'
  }
}

/** Fetch the latest release info from GitHub. Returns null on failure. */
function fetchLatestRelease() {
  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${REPO}/releases/latest`
    const req = https.get(url, {
      headers: { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' },
      timeout: 15_000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return resolve(null)
      }
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const tag = String(data.tag_name || '')
          const commit = tag.startsWith('dsh-') ? tag.slice(4) : ''
          const asset = (data.assets || []).find((a) => a.name.endsWith('.dmg'))
          resolve(commit && asset ? {
            commit,
            tag,
            name: data.name || tag,
            assetUrl: asset.browser_download_url,
            assetName: asset.name,
            size: asset.size,
            publishedAt: data.published_at,
          } : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/** Is there a newer build than the one bundled? */
function hasUpdate(latest, current = bundledCommit()) {
  return Boolean(latest && latest.commit && latest.commit !== current)
}

/**
 * Download the release DMG to ~/Downloads, reporting progress via onProgress.
 * @returns the downloaded file path.
 */
async function downloadDmg(latest, onProgress) {
  const target = join(app.getPath('downloads'), latest.assetName)
  const response = await net.fetch(latest.assetUrl, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)

  const total = Number(response.headers.get('content-length')) || latest.size || 0
  let received = 0
  const reader = response.body.getReader()
  const file = createWriteStream(target)

  // Stream chunks to disk with progress callbacks.
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (!file.write(Buffer.from(value))) {
      await new Promise((r) => file.once('drain', r))
    }
    if (total > 0) onProgress?.(Math.round((received / total) * 100), received, total)
  }
  await new Promise((r) => file.end(r))
  return target
}

/** Open the downloaded DMG for installation. */
function openInstaller(dmgPath) {
  return shell.openPath(dmgPath)
}

module.exports = {
  REPO,
  CHECK_INTERVAL_MS,
  CHECK_DELAY_MS,
  bundledCommit,
  fetchLatestRelease,
  hasUpdate,
  downloadDmg,
  openInstaller,
}
