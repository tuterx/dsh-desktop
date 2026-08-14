'use strict'

/**
 * Auto-update checks for the dsh desktop app.
 *
 * The CI workflow publishes one GitHub Release per build
 * (tag "dsh-<upstream12><app7>", asset DeepSeek-Harness-*.dmg), where:
 *   - upstream12 = first 12 hex of the bundled upstream deepseek-harness commit
 *   - app7       = first 7 hex of the dsh-desktop repo commit that built the shell
 *
 * This module:
 *   1. compares the CURRENT bundled identity (resources/UPSTREAM_COMMIT +
 *      resources/APP_BUILD) with the LATEST release tag on
 *      github.com/tuterx/dsh-desktop
 *   2. downloads the new DMG to ~/Downloads with progress events
 *
 * Updating is download-and-open (not silent): the DMG is unsigned, so
 * Squirrel-style auto-install is not possible. The user installs the new
 * build from the downloaded DMG.
 *
 * Backward compatibility: the first release used the full 40-hex upstream
 * commit as the tag (no app part). parseTag tolerates it (app === null) and
 * hasUpdate falls back to comparing the upstream half only, so an app that
 * predates the app7 format still treats any new-format tag as an update.
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

/** The dsh-desktop shell commit this build was made from. */
function bundledAppBuild() {
  try {
    const path = process.resourcesPath
      ? join(process.resourcesPath, 'APP_BUILD')
      : join(__dirname, '..', 'resources', 'APP_BUILD')
    return require('node:fs').readFileSync(path, 'utf8').trim()
  } catch {
    return '0000000'
  }
}

/**
 * Split a release tag into its (upstream, app) identity.
 * "dsh-<upstream12><app7>" → { upstream, app }; a legacy 40-hex commit tag
 * (first release, no app part) still parses with app === null.
 */
function parseTag(tag) {
  const m = /^dsh-([0-9a-f]{12})([0-9a-f]{7})$/.exec(tag)
  if (m) return { upstream: m[1], app: m[2] }
  const legacy = /^dsh-([0-9a-f]{40})$/.exec(tag)
  return legacy ? { upstream: legacy[1].slice(0, 12), app: null } : null
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
          const id = parseTag(tag)
          const asset = (data.assets || []).find((a) => a.name.endsWith('.dmg'))
          resolve(id && asset ? {
            upstream: id.upstream,
            app: id.app,
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

/**
 * Is there a newer build than the one bundled? An update exists when either
 * the upstream commit or the app-shell build differs from what we have.
 */
function hasUpdate(latest, current = bundledCommit(), currentApp = bundledAppBuild()) {
  if (!latest || !latest.upstream) return false
  if (latest.upstream !== current.slice(0, 12)) return true
  // Old-format tags carry no app identity; skip that comparison for them.
  return Boolean(latest.app && latest.app !== currentApp)
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
  bundledAppBuild,
  parseTag,
  fetchLatestRelease,
  hasUpdate,
  downloadDmg,
  openInstaller,
}
