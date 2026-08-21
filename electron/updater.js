'use strict'

/**
 * Auto-update checks for the dsh desktop app.
 *
 * The CI workflow publishes one GitHub Release per build
 * (tag "dsh-<upstream12><app7>", assets DeepSeek-Harness-*-mac.zip + .dmg on
 * macOS, DeepSeek-Harness-*-win-x64.zip on Windows), where:
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
 * no DMG, no re-install. macOS swaps the .app/Contents (ditto helper);
 * Windows swaps the extracted app directory (PowerShell helper). The DMG
 * remains as a manual-install fallback for macOS releases that carry no zip.
 *
 * Backward compatibility: the first release used the full 40-hex upstream
 * commit as the tag (no app part). parseTag tolerates it (app === null) and
 * hasUpdate falls back to comparing the upstream half only, so an app that
 * predates the app7 format still treats any new-format tag as an update.
 */

const { app, net, shell } = require('electron')
const { createWriteStream, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const https = require('node:https')

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

/**
 * Fetch the newest release info that carries an asset for THIS platform.
 * The platform workflows publish the same tag concurrently; a release may
 * briefly (or permanently) hold only the other platform's files, so the
 * bare /releases/latest is not enough - scan the recent list and pick the
 * newest release with a usable asset (zip preferred, dmg fallback).
 * Returns null on failure.
 */
function fetchLatestRelease() {
  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=10`
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
          const releases = JSON.parse(body)
          // GitHub sorts by created_at, but CI publishes many releases in one
          // batch (same created_at), so the list order is NOT publish order.
          // Pick the NEWEST release by published_at among those that carry a
          // usable asset for this platform; otherwise a just-published newer
          // build can sit behind an older one and the updater keeps finding
          // the stale version (and may stay silent if that one was dismissed).
          const usable = []
          for (const data of releases) {
            const tag = String(data.tag_name || '')
            const id = parseTag(tag)
            const assets = data.assets || []
            const asset = process.platform === 'win32'
              ? assets.find((a) => /-win.*\.zip$/.test(a.name))
              : assets.find((a) => /\.zip$/.test(a.name) && /-mac\.zip$/.test(a.name))
                || assets.find((a) => a.name.endsWith('.dmg'))
            if (id && asset) usable.push({ data, id, asset })
          }
          usable.sort((a, b) => String(b.data.published_at || '').localeCompare(String(a.data.published_at || '')))
          const best = usable[0]
          if (best) {
            const { data, id, asset } = best
            resolve({
              upstream: id.upstream,
              app: id.app,
              tag: String(data.tag_name || ''),
              name: data.name || String(data.tag_name || ''),
              kind: /\.zip$/.test(asset.name) ? 'zip' : 'dmg',
              assetUrl: asset.browser_download_url,
              assetName: asset.name,
              size: asset.size,
              publishedAt: data.published_at,
            })
            return
          }
          resolve(null)
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

// ── resumable chunked downloader ──────────────────────────────────────────
const CHUNK_COUNT = 4 // parallel Range connections
const MAX_ATTEMPTS = 3 // per chunk, with backoff
const RETRY_BASE_MS = 2000
const STALL_MS = 30_000 // no data for this long → abort chunk, retry

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Does the asset endpoint honor Range (206)? GitHub CDN does. */
async function supportsRange(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await net.fetch(url, { headers: { Range: 'bytes=0-0' } })
      const ok = res.status === 206
      await res.body?.cancel().catch(() => {})
      return ok
    } catch {
      if (attempt === 2) return false
      await sleep(1000)
    }
  }
  return false
}

/**
 * Download one Range chunk with retry+backoff and resume. The `.part` file
 * keeps whatever bytes actually reached disk (flushed), so a killed
 * connection or app restart continues from the real offset - never from
 * zero, never with a hole.
 */
async function downloadChunk(part, url, onBytes) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let file = null
    let reader = null
    let lastProgress = Date.now()
    // A connection that stops delivering data hangs forever; abort it so
    // the retry can resume from where the bytes actually landed.
    const stall = setInterval(() => {
      if (Date.now() - lastProgress > STALL_MS) {
        reader?.cancel().catch(() => {})
      }
    }, 5000)
    try {
      const need = part.end - part.start + 1 - part.size
      if (need <= 0) return
      const res = await net.fetch(url, { headers: { Range: `bytes=${part.start + part.size}-${part.end}` } })
      if (res.status !== 206) throw new Error(`端点不支持断点续传 (HTTP ${res.status})`)
      reader = res.body.getReader()
      file = createWriteStream(part.path, { flags: part.size > 0 ? 'a' : 'w' })
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!file.write(Buffer.from(value))) await new Promise((r) => file.once('drain', r))
        part.size += value.byteLength
        lastProgress = Date.now()
        onBytes(value.byteLength)
      }
      await new Promise((r) => file.end(r))
      clearInterval(stall)
      return
    } catch (err) {
      clearInterval(stall)
      // Flush whatever reached disk, then trust the FILE size as the resume
      // offset (bytes still buffered in the stream were never written).
      try { if (file) await new Promise((r) => file.end(r)) } catch { /* noop */ }
      try { part.size = require('node:fs').statSync(part.path).size } catch { part.size = 0 }
      if (attempt === MAX_ATTEMPTS) throw new Error(`分块 ${part.i + 1} 下载失败: ${err.message}`)
      await sleep(RETRY_BASE_MS * attempt)
    }
  }
}

/**
 * Download the release asset (zip preferred, dmg fallback) to
 * <userData>/updates/<tag>/, reporting progress via onProgress.
 *
 * Strategy: 4 parallel Range chunks with per-chunk retry/backoff and true
 * resume (partial `.part` files survive failures AND app restarts - the
 * next attempt picks up each chunk at its real on-disk offset). Endpoints
 * without Range support fall back to a plain single-stream download.
 * @returns the downloaded file path.
 */
async function downloadUpdate(latest, onProgress) {
  const finalPath = assetPath(latest.tag, latest.assetName)
  const dir = join(updatesDir(), latest.tag)
  mkdirSync(dir, { recursive: true })
  const { statSync, createWriteStream, createReadStream, unlinkSync } = require('node:fs')

  // Already fully downloaded in a previous session?
  try {
    if (statSync(finalPath).size === latest.size) return finalPath
  } catch { /* not present - download */ }

  if (!(await supportsRange(latest.assetUrl))) {
    return downloadSingle(latest, finalPath, onProgress)
  }

  const total = latest.size
  const chunkSize = Math.ceil(total / CHUNK_COUNT)
  const parts = []
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const start = i * chunkSize
    const end = Math.min(total - 1, start + chunkSize - 1)
    if (start > end) continue // tiny file: fewer real chunks
    const path = `${finalPath}.part${i}`
    let size = 0
    try { size = statSync(path).size } catch { /* fresh chunk */ }
    parts.push({ i, start, end, path, size })
  }

  let doneBytes = parts.reduce((s, p) => s + p.size, 0)
  let lastReport = 0
  const report = () => {
    if (doneBytes - lastReport < 64 * 1024) return
    lastReport = doneBytes
    onProgress?.(total > 0 ? Math.round((doneBytes / total) * 100) : 0)
  }
  report()

  await Promise.all(parts.map((p) => downloadChunk(p, latest.assetUrl, (n) => { doneBytes += n; report() })))

  // Every chunk must now be complete, then concatenate in order.
  for (const p of parts) {
    const expect = p.end - p.start + 1
    if (p.size !== expect) throw new Error(`分块 ${p.i + 1} 不完整 (${p.size}/${expect})`)
  }
  try { unlinkSync(finalPath) } catch { /* no stale final */ }
  const out = createWriteStream(finalPath)
  try {
    for (const p of parts) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(p.path)
        rs.on('error', reject)
        rs.pipe(out, { end: false })
        rs.on('end', resolve)
      })
    }
  } finally {
    await new Promise((r) => out.end(r))
  }
  if (statSync(finalPath).size !== total) throw new Error('文件校验失败: 大小不符')
  for (const p of parts) { try { unlinkSync(p.path) } catch { /* noop */ } }
  onProgress?.(100)
  return finalPath
}

/** Single-stream fallback for endpoints without Range support. */
async function downloadSingle(latest, target, onProgress) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await net.fetch(latest.assetUrl, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || latest.size || 0
      let received = 0
      const reader = response.body.getReader()
      const file = createWriteStream(target)
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!file.write(Buffer.from(value))) await new Promise((r) => file.once('drain', r))
        if (total > 0) onProgress?.(Math.round((received / total) * 100), received, total)
      }
      await new Promise((r) => file.end(r))
      return target
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`下载失败: ${err.message}`)
      await sleep(RETRY_BASE_MS * attempt)
    }
  }
}

/**
 * The detached helper that performs the in-place swap: waits for the old app
 * process to exit, unpacks the zip next to the bundle (same volume), swaps
 * the bundle atomically, and relaunches. Launched by the main process right
 * before app.quit(), it survives the parent's exit.
 * macOS: shell + ditto (swaps .app/Contents).
 * Windows: batch + PowerShell Expand-Archive (swaps the extracted app dir;
 * node_modules is not shipped, so the first launch after an update reinstalls
 * deps from the bundled offline store automatically).
 */
function installScript() {
  if (process.platform === 'win32') {
    return `@echo off
rem dsh-desktop in-place updater (Windows, detached helper)
set "OLD_PID=%~1"
set "ZIP=%~2"
set "TARGET=%~3"
set "LOG=%~4"
echo [updater] start old_pid=%OLD_PID% zip=%ZIP% target=%TARGET% >> "%LOG%"
:wait
tasklist /fi "PID eq %OLD_PID%" 2>nul | findstr /r "%OLD_PID%" >nul 2>&1
if errorlevel 1 goto exited
timeout /t 1 /nobreak >nul 2>&1
goto wait
:exited
timeout /t 1 /nobreak >nul 2>&1
set "TMP=%TARGET%\\.update.tmp"
rmdir /s /q "%TMP%" 2>nul
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%TMP%' -Force" >> "%LOG%" 2>&1
if errorlevel 1 goto failed
rem swap: drop old content, move new content in (same volume)
for /d %%D in ("%TARGET%\\*") do rmdir /s /q "%%D" 2>nul
for %%F in ("%TARGET%\\*") do del /q "%%F" 2>nul
for /d %%D in ("%TMP%\\*") do move "%%D" "%TARGET%\\" >> "%LOG%" 2>&1
for %%F in ("%TMP%\\*") do move "%%F" "%TARGET%\\" >> "%LOG%" 2>&1
rmdir /s /q "%TMP%" 2>nul
echo [updater] swapped >> "%LOG%"
start "" "%TARGET%\\DeepSeek Harness.exe"
echo [updater] relaunched >> "%LOG%"
exit /b 0
:failed
echo [updater] extract failed >> "%LOG%"
rmdir /s /q "%TMP%" 2>nul
start "" "%TARGET%\\DeepSeek Harness.exe"
exit /b 1
`
  }
  return `#!/bin/sh
# dsh-desktop in-place updater (detached helper, spawned before quit).
# The zip is ALREADY extracted by the main process before quitting; this
# helper only performs the swap - two instant renames (no rm window), so a
# relaunch racing the swap can never boot the old bundle mid-swap.
OLD_PID="$1"; TMP="$2"; TARGET="$3"; LOG="$4"
echo "[updater] start old_pid=$OLD_PID tmp=$TMP target=$TARGET" >> "$LOG"
i=0
while kill -0 "$OLD_PID" 2>/dev/null; do
  i=$((i+1))
  [ "$i" -gt 90 ] && { echo "[updater] timeout waiting for old app" >> "$LOG"; exit 1; }
  sleep 1
done
sleep 1
APP_IN="$(find "$TMP" -maxdepth 2 -type d -name "*.app" | head -1)"
if [ -z "$APP_IN" ] || [ ! -d "$APP_IN/Contents/MacOS" ]; then
  echo "[updater] bad payload" >> "$LOG"
  rm -rf "$TMP"; open "$TARGET"; exit 1
fi
# Rename old out of the way, rename new in - atomic on APFS, no rm window.
rm -rf "$TARGET/Contents.old" 2>/dev/null || true
mv "$TARGET/Contents" "$TARGET/Contents.old" 2>/dev/null || true
if ! mv "$APP_IN/Contents" "$TARGET/Contents" 2>>"$LOG"; then
  echo "[updater] swap failed - restoring old contents" >> "$LOG"
  [ -d "$TARGET/Contents.old" ] && mv "$TARGET/Contents.old" "$TARGET/Contents"
  rm -rf "$TMP"
  open "$TARGET"
  exit 1
fi
rm -rf "$TMP"
echo "[updater] swapped" >> "$LOG"
open "$TARGET"
echo "[updater] relaunched" >> "$LOG"
# Old contents cleanup happens after relaunch (the detached helper lingers).
rm -rf "$TARGET/Contents.old" 2>/dev/null || true
`
}

/** Open a downloaded asset for manual installation (dmg fallback on macOS). */
function openInstaller(installerPath) {
  return shell.openPath(installerPath)
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
