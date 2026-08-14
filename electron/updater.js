'use strict'

/**
 * Auto-update checks for the dsh desktop app.
 *
 * The CI workflow publishes one GitHub Release per build
 * (tag "dsh-<upstream12><app7>", assets DeepSeek-Harness-*-mac.zip + .dmg),
 * where:
 *   - upstream12 = first 12 hex of the bundled upstream deepseek-harness commit
 *   - app7       = first 7 hex of the dsh-desktop repo commit that built the shell
 *
 * This module:
 *   1. compares the CURRENT bundled identity (resources/UPSTREAM_COMMIT +
 *      resources/APP_BUILD) with the LATEST release tag on
 *      github.com/tuterx/dsh-desktop
 *   2. downloads the new build to <userData>/updates/<tag>/ with progress events
 *
 * Updating is SEAMLESS (Codex-style): the zip is extracted and swapped in
 * place by a detached helper after the app quits, then the app relaunches -
 * no DMG, no re-install. The DMG remains as a manual-install fallback for
 * releases that carry no zip (kind === 'dmg' → download-and-open).
 *
 * Backward compatibility: the first release used the full 40-hex upstream
 * commit as the tag (no app part). parseTag tolerates it (app === null) and
 * hasUpdate falls back to comparing the upstream half only, so an app that
 * predates the app7 format still treats any new-format tag as an update.
 */

const { app, shell } = require('electron')
const { createWriteStream, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
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

/**
 * The running .app bundle - the target of an in-place update. Only meaningful
 * when packaged (dev runs from electron/dist, which must never be swapped).
 */
function bundlePath() {
  return app.isPackaged ? resolve(process.resourcesPath, '..', '..') : null
}

/** Per-release staging directory for downloaded artifacts. */
function updatesDir() {
  return join(app.getPath('userData'), 'updates')
}

/**
 * Where a downloaded asset for `tag` lives (or would live).
 */
function assetPath(tag, assetName) {
  return join(updatesDir(), tag, assetName)
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
          // Prefer the zip (seamless in-place update); the DMG is the
          // manual-install fallback for older releases.
          const assets = data.assets || []
          const asset = assets.find((a) => /\.zip$/.test(a.name) && /-mac\.zip$/.test(a.name))
            || assets.find((a) => a.name.endsWith('.dmg'))
          resolve(id && asset ? {
            upstream: id.upstream,
            app: id.app,
            tag,
            name: data.name || tag,
            kind: /\.zip$/.test(asset.name) ? 'zip' : 'dmg',
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
 * Download the release asset (zip preferred, dmg fallback) to
 * <userData>/updates/<tag>/, reporting progress via onProgress.
 * @returns the downloaded file path.
 */
async function downloadUpdate(latest, onProgress) {
  const target = assetPath(latest.tag, latest.assetName)
  mkdirSync(join(updatesDir(), latest.tag), { recursive: true })

  // Already downloaded in a previous session? Skip the transfer.
  const { statSync } = require('node:fs')
  try {
    if (statSync(target).size === latest.size) return target
  } catch { /* not present - download */ }

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

/**
 * The detached helper that performs the in-place swap: waits for the old app
 * process to exit, unpacks the zip next to the bundle (same volume), swaps
 * Contents atomically (mv = rename), and relaunches. Launched by the main
 * process right before app.quit(), it survives the parent's exit.
 */
function installScript() {
  return `#!/bin/sh
# dsh-desktop in-place updater (detached helper, spawned before quit)
OLD_PID="$1"; ZIP="$2"; TARGET="$3"; LOG="$4"
echo "[updater] start old_pid=$OLD_PID zip=$ZIP target=$TARGET" >> "$LOG"
i=0
while kill -0 "$OLD_PID" 2>/dev/null; do
  i=$((i+1))
  [ "$i" -gt 90 ] && { echo "[updater] timeout waiting for old app" >> "$LOG"; exit 1; }
  sleep 1
done
sleep 1
TMP="$TARGET/.update.tmp"
rm -rf "$TMP"
if ! ditto -x -k "$ZIP" "$TMP" 2>>"$LOG"; then
  echo "[updater] extract failed" >> "$LOG"
  rm -rf "$TMP"; open "$TARGET"; exit 1
fi
APP_IN="$(find "$TMP" -maxdepth 2 -type d -name "*.app" | head -1)"
if [ -z "$APP_IN" ] || [ ! -d "$APP_IN/Contents/MacOS" ]; then
  echo "[updater] bad payload" >> "$LOG"
  rm -rf "$TMP"; open "$TARGET"; exit 1
fi
rm -rf "$TARGET/Contents"
if ! mv "$APP_IN/Contents" "$TARGET/Contents" 2>>"$LOG"; then
  echo "[updater] swap failed" >> "$LOG"
  rm -rf "$TMP"; open "$TARGET"; exit 1
fi
rm -rf "$TMP"
echo "[updater] swapped" >> "$LOG"
open "$TARGET"
echo "[updater] relaunched" >> "$LOG"
`
}

/** Open the downloaded DMG for manual installation (dmg fallback). */
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
  bundlePath,
  updatesDir,
  assetPath,
  fetchLatestRelease,
  hasUpdate,
  downloadUpdate,
  installScript,
  openInstaller,
}
