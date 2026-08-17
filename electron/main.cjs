'use strict'

/**
 * DeepSeek Harness desktop app — Electron main process.
 *
 * The packaged .app bundles two extra resources:
 *   resources/node  — a standalone Node runtime (dsh needs ^22.19 || >=24)
 *   resources/dsh   — the full deepseek-harness workspace built from upstream
 *
 * This process:
 *   1. picks a free port (default 3080, increments when busy)
 *   2. spawns <resources>/node/bin/node <resources>/dsh/apps/cli/lib/bin.js
 *      web --host 127.0.0.1 --port <port>  (cwd = resources/dsh)
 *   3. shows a splash while polling http://127.0.0.1:<port>/
 *   4. opens a BrowserWindow at the ready URL
 *   5. on quit, SIGTERMs the dsh process group, then SIGKILL after a grace
 *      period — no orphan processes survive
 */

const { app, BrowserWindow, Menu, shell, dialog, session, nativeTheme, ipcMain } = require('electron')
const { spawn, execFile } = require('node:child_process')
const { createServer } = require('node:net')
const http = require('node:http')
const { existsSync, mkdirSync, createWriteStream } = require('node:fs')
const { join } = require('node:path')
const appearance = require('./appearance.js')
const updater = require('./updater.js')

const HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 120_000
const SHUTDOWN_GRACE_MS = 6_000
const isDev = process.argv.includes('--dev')

let serverProc = null
let installProc = null
let mainWindow = null
let splashWindow = null
let serverReady = false
let quitting = false
let logStream = null
let insertedCssKeys = [] // injected appearance style keys, replaced on change

// ── bundled runtime paths ────────────────────────────────────────────────
// In dev (electron .) they live under ./resources; packaged they live under
// Contents/Resources (process.resourcesPath).
function runtimeRoot() {
  const candidates = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'node'))
    candidates.push(join(process.resourcesPath, 'dsh'))
  }
  candidates.push(join(__dirname, '..', 'resources', 'node'))
  candidates.push(join(__dirname, '..', 'resources', 'dsh'))
  return {
    nodeDir: existsSync(candidates[0]) ? candidates[0] : candidates[2],
    dshDir: existsSync(candidates[1]) ? candidates[1] : candidates[3],
  }
}

/** Absolute path of a bundled extra resource, or null when absent. */
function bundledPath(name) {
  const candidates = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, name))
  candidates.push(join(__dirname, '..', 'resources', name))
  return candidates.find((p) => existsSync(p))
}

/** node executable path inside the bundled Node runtime (platform-aware). */
function nodeBinPath(nodeDir) {
  return process.platform === 'win32'
    ? join(nodeDir, 'node.exe')
    : join(nodeDir, 'bin', 'node')
}

// ── logging ──────────────────────────────────────────────────────────────
function logFile() {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'dsh-server.log')
}

function writeLog(line) {
  const stamp = `[${new Date().toISOString()}] ${line}`
  console.log(line)
  try {
    if (!logStream) logStream = createWriteStream(logFile(), { flags: 'a' })
    logStream.write(stamp + '\n')
  } catch { /* best-effort */ }
}

// ── free port ────────────────────────────────────────────────────────────
function pickPort() {
  return new Promise((res, rej) => {
    const base = Number(process.env.DSH_WEB_PORT) || 3080
    const candidates = []
    for (let i = 0; i < 20; i++) candidates.push(base + i)
    const tryPort = (idx) => {
      if (idx >= candidates.length) {
        const srv = createServer()
        srv.listen(0, HOST, () => {
          const p = srv.address().port
          srv.close(() => res(p))
        })
        srv.on('error', () => rej(new Error('no free port')))
        return
      }
      const port = candidates[idx]
      const srv = createServer()
      srv.once('error', () => tryPort(idx + 1))
      srv.once('listening', () => srv.close(() => res(port)))
      srv.listen(port, HOST)
    }
    tryPort(0)
  })
}

// ── first-launch dependency install (Windows) ─────────────────────────────
// The packaged Windows app ships WITHOUT dsh/node_modules: pnpm junctions on
// Windows are absolute-path links with dependency cycles, so no copy or
// archive of the installed tree is portable. On first launch we run
// `pnpm install` against the bundled offline store, rebuilding a correct,
// self-contained tree at the user's install path (~10s locally).
// Strategy: OFFLINE FIRST (bundled store covers the full dependency set),
// with an ONLINE fallback that fetches any packages the store lacks — this
// keeps first launch working even if the bundled store is incomplete.
function runPnpmInstall(nodeBin, pnpmCli, dshDir, storeDir, offline) {
  return new Promise((resolve, reject) => {
    const args = [pnpmCli, 'install',
      ...(offline ? ['--offline'] : []),
      '--store-dir', storeDir,
      '--config.node-linker=hoisted',
      '--config.confirmModulesPurge=false',
      '--reporter=append-only']
    writeLog(`${offline ? '离线' : '在线'}安装 dsh 运行时依赖… (cwd: ${dshDir})`)
    const proc = spawn(nodeBin, args, {
      cwd: dshDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    installProc = proc
    const onOut = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line) writeLog('[install] ' + line)
      }
    }
    proc.stdout.on('data', onOut)
    proc.stderr.on('data', onOut)
    proc.on('error', (err) => reject(new Error('无法启动 pnpm: ' + err.message)))
    proc.on('exit', (code) => {
      if (installProc === proc) installProc = null
      if (code === 0) resolve()
      else reject(new Error(`pnpm install 失败 (code=${code})`))
    })
  })
}

function installServerDeps(nodeBin, dshDir) {
  const pnpmCli = join(bundledPath('pnpm-cli'), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const storeDir = bundledPath('pnpm-store')
  if (!existsSync(pnpmCli) || !storeDir) {
    return Promise.reject(new Error('缺少离线安装资产 pnpm-cli/pnpm-store — 安装包不完整，请重新解压。'))
  }
  return runPnpmInstall(nodeBin, pnpmCli, dshDir, storeDir, true).catch((offlineErr) => {
    writeLog('离线安装失败，尝试在线安装: ' + offlineErr.message)
    return runPnpmInstall(nodeBin, pnpmCli, dshDir, storeDir, false).catch((onlineErr) => {
      throw new Error(`依赖安装失败（离线与在线均失败）。\n离线: ${offlineErr.message}\n在线: ${onlineErr.message}\n日志: ${logFile()}`)
    })
  })
}

// ── server lifecycle ─────────────────────────────────────────────────────
function launchServer(port) {
  const { nodeDir, dshDir } = runtimeRoot()
  const nodeBin = nodeBinPath(nodeDir)
  const dshBin = join(dshDir, 'apps', 'cli', 'lib', 'bin.js')

  if (!existsSync(nodeBin)) {
    return fatal('缺少运行时', `未找到内嵌 Node: ${nodeBin}\n请运行 npm run prepare 后重新打包。`)
  }
  if (!existsSync(dshBin)) {
    return fatal('缺少 dsh', `未找到 dsh: ${dshBin}\n请运行 npm run prepare 后重新打包。`)
  }

  const args = [dshBin, 'web', '--host', HOST, '--port', String(port)]
  writeLog(`启动 dsh: ${nodeBin} ${args.join(' ')} (cwd: ${dshDir})`)

  serverProc = spawn(nodeBin, args, {
    cwd: dshDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group → clean group-shutdown on quit
    windowsHide: true,
  })

  const onOut = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line) writeLog('[dsh] ' + line)
    }
  }
  serverProc.stdout.on('data', onOut)
  serverProc.stderr.on('data', onOut)

  serverProc.on('error', (err) => {
    writeLog('无法启动 Node: ' + err.message)
    if (!serverReady) fatal('无法启动服务', err.message)
  })
  serverProc.on('exit', (code, signal) => {
    writeLog(`dsh 进程退出 code=${code} signal=${signal}`)
    serverProc = null
    if (!serverReady) {
      fatal('服务启动失败', `进程退出 (code=${code})。\n日志: ${logFile()}`)
    }
  })
}

function waitForServer(port) {
  return new Promise((res, rej) => {
    const url = `http://${HOST}:${port}/`
    const start = Date.now()
    const ping = () => {
      const req = http.get(url, { timeout: 2000 }, (r) => {
        r.resume()
        if (r.statusCode && r.statusCode < 500) return res(url)
        schedule()
      })
      req.on('error', schedule)
      req.on('timeout', () => { req.destroy(); schedule() })
    }
    const schedule = () => {
      if (Date.now() - start > READY_TIMEOUT_MS) return rej(new Error('服务启动超时'))
      setTimeout(ping, 1000)
    }
    ping()
  })
}

function stopServer() {
  if (!serverProc) return Promise.resolve()
  const proc = serverProc
  serverProc = null
  return new Promise((r) => {
    let done = false
    const finish = () => { if (!done) { done = true; r() } }
    proc.once('exit', finish)
    const killGroup = (sig) => {
      if (process.platform === 'win32') {
        // Windows has no process-group signals; taskkill /T kills the whole tree.
        try { execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {}) } catch { /* gone */ }
        return
      }
      try { process.kill(-proc.pid, sig) } catch {
        try { proc.kill(sig) } catch { /* gone */ }
      }
    }
    if (process.platform === 'win32') { killGroup('SIGKILL'); return }
    killGroup('SIGTERM')
    setTimeout(() => { killGroup('SIGKILL'); finish() }, SHUTDOWN_GRACE_MS)
  })
}

// ── appearance ────────────────────────────────────────────────────────────
// Window-chrome fixes injected into the MAIN world (isolated-world DOM
// creation is invisible to the page): a top drag bar so double-clicking the
// empty top strip zooms the window (hiddenInset has no title bar), and the
// traffic-light safe zone on the sidebar, both kept alive across React
// re-renders by a main-world poll.
const CHROME_FIXES_JS = `(() => {
  const styleId = 'dsh-chrome-fixes'
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = '.dsh-drag-bar{position:fixed;top:0;left:300px;right:52px;height:34px;-webkit-app-region:drag;z-index:2147483645;}'
    document.head.appendChild(style)
  }
  const ensureBar = () => {
    if (document.querySelector('.dsh-drag-bar')) return
    const bar = document.createElement('div')
    bar.className = 'dsh-drag-bar'
    document.body.appendChild(bar)
  }
  const safeZone = () => {
    const sidebar = [...document.querySelectorAll('div,aside,nav,section')].find((el) => {
      const r = el.getBoundingClientRect()
      return r.x === 0 && r.y === 0 && r.width >= 180 && r.width <= 420 && r.height > 500
    })
    if (sidebar && sidebar.style.paddingTop !== '40px') sidebar.style.paddingTop = '40px'
  }
  ensureBar()
  safeZone()
  if (!window.__dshChromePoll) {
    window.__dshChromePoll = setInterval(() => { ensureBar(); safeZone() }, 2000)
  }
})()`

function applyAppearance(win = mainWindow) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const cfg = appearance.load()

  // System chrome (scrollbars, menus, dialogs) follows the theme. Setting
  // themeSource fires nativeTheme 'updated'; assigning the SAME value also
  // fires it, which looped with the 'updated' listener below and pegged the
  // renderer at 100% CPU - only assign on change.
  const themeTarget = cfg.theme === 'system' ? 'system' : cfg.theme
  if (nativeTheme.themeSource !== themeTarget) nativeTheme.themeSource = themeTarget
  // dsh UI theme: body[data-ds-dark-theme] drives all dark CSS variables.
  appearance.applyThemeToPage(win, appearance.isDark(cfg))

  // Font size / family / wallpaper via injected CSS. Replace previous styles.
  for (const key of insertedCssKeys) {
    try { win.webContents.removeInsertedCSS(key) } catch { /* already gone */ }
  }
  insertedCssKeys = []
  win.webContents.insertCSS(appearance.appearanceCss(cfg)).then((key) => {
    insertedCssKeys.push(key)
  }).catch(() => { /* page not ready */ })

  // macOS: double-click-to-zoom drag bar + traffic-light safe zone (main
  // world). Windows keeps the native title bar, so there is no overlay to
  // guard and nothing to inject.
  if (process.platform === 'darwin') {
    win.webContents.executeJavaScript(CHROME_FIXES_JS, true).catch(() => {})
  }
}

function setAppearance(patch) {
  const cfg = { ...appearance.load(), ...patch }
  appearance.save(cfg)
  applyAppearance()
}

// Follow the OS theme live when appearance.theme === 'system'.
nativeTheme.on('updated', () => {
  if (appearance.load().theme === 'system') applyAppearance()
})

// ── windows ──────────────────────────────────────────────────────────────
function showSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 360,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    backgroundColor: '#0b0e14',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  splashWindow.loadFile(join(__dirname, 'splash.html'))
  splashWindow.on('closed', () => { splashWindow = null })
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    // macOS: hiddenInset — no title bar row, the traffic lights float over the
    // content (VS Code style), so the dark dsh UI owns the whole window.
    // Windows: keep the native title bar (hiddenInset is macOS-only).
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
    } : {}),
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (splashWindow) { splashWindow.close(); splashWindow = null }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    applyAppearance(mainWindow)
  })
  mainWindow.loadURL(url)
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })

  // Route external links to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http://') || u.startsWith('https://')) {
      shell.openExternal(u)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // dsh session exports → default into ~/Downloads.
  mainWindow.webContents.session.on('will-download', (_e, item) => {
    try {
      item.setSaveDialogOptions({
        defaultPath: join(app.getPath('downloads'), item.getFilename()),
      })
    } catch { /* default */ }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

function fatal(title, msg) {
  writeLog(`FATAL: ${title} — ${msg}`)
  if (splashWindow) { splashWindow.close(); splashWindow = null }
  try { dialog.showErrorBox(title, msg) } catch { /* headless */ }
  app.quit()
}

// ── menu ──────────────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const view = {
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'forceReload', label: '强制重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '重置缩放' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
    ],
  }
  // Appearance settings: theme, font size, font family, wallpaper. Persisted
  // to userData/appearance.json and applied via nativeTheme + injected CSS.
  const radio = (label, value, current, click) => ({
    label,
    type: 'radio',
    checked: value === current,
    click: () => click(value),
  })
  const cfg = appearance.load()
  const wallpaperItems = [
    radio('无', 'none', cfg.wallpaper, (v) => setAppearance({ wallpaper: v })),
    radio('深色渐变', 'gradient-dark', cfg.wallpaper, (v) => setAppearance({ wallpaper: v })),
    radio('浅色渐变', 'gradient-light', cfg.wallpaper, (v) => setAppearance({ wallpaper: v })),
    { type: 'separator' },
    {
      label: '选择图片…',
      click: async () => {
        const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
        if (!picked.canceled && picked.filePaths[0]) {
          setAppearance({ wallpaper: `custom:${picked.filePaths[0]}` })
        }
      },
    },
    ...(cfg.wallpaper.startsWith('custom:') ? [{ type: 'separator' }, { label: '移除自定义壁纸', click: () => setAppearance({ wallpaper: 'none' }) }] : []),
  ]
  const appearanceMenu = {
    label: '外观',
    submenu: [
      {
        label: '主题',
        submenu: [
          radio('浅色', 'light', cfg.theme, (v) => setAppearance({ theme: v })),
          radio('深色', 'dark', cfg.theme, (v) => setAppearance({ theme: v })),
          radio('跟随系统', 'system', cfg.theme, (v) => setAppearance({ theme: v })),
        ],
      },
      {
        label: '字号',
        submenu: [
          radio('小', 'small', cfg.fontSize, (v) => setAppearance({ fontSize: v })),
          radio('标准', 'normal', cfg.fontSize, (v) => setAppearance({ fontSize: v })),
          radio('大', 'large', cfg.fontSize, (v) => setAppearance({ fontSize: v })),
          radio('特大', 'xlarge', cfg.fontSize, (v) => setAppearance({ fontSize: v })),
        ],
      },
      {
        label: '字体',
        submenu: [
          radio('系统', 'system', cfg.fontFamily, (v) => setAppearance({ fontFamily: v })),
          radio('圆体', 'rounded', cfg.fontFamily, (v) => setAppearance({ fontFamily: v })),
          radio('等宽', 'mono', cfg.fontFamily, (v) => setAppearance({ fontFamily: v })),
        ],
      },
      {
        label: '壁纸',
        submenu: wallpaperItems,
      },
    ],
  }
  // REQUIRED on macOS: clipboard shortcuts (Cmd+C/V/X) only work when the
  // menu declares the standard edit roles. Without this menu, paste silently
  // fails everywhere in the app.
  const edit = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'delete', label: '删除' },
      { role: 'selectAll', label: '全选' },
    ],
  }
  const template = isMac
    ? [
        {
          label: 'DeepSeek Harness',
          submenu: [
            { role: 'about', label: '关于 DeepSeek Harness' },
            { label: '检查更新…', click: () => { checkForUpdate(false) } },
            { type: 'separator' },
            { role: 'hide', label: '隐藏' },
            { role: 'hideOthers' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
          ],
        },
        edit,
        appearanceMenu,
        view,
        { role: 'windowMenu', label: '窗口' },
      ]
    : [
        { label: '文件', submenu: [{ role: 'quit', label: '退出' }, { label: '检查更新…', click: () => { checkForUpdate(false) } }] },
        edit,
        appearanceMenu,
        view,
        { role: 'windowMenu', label: '窗口' },
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── auto-update ───────────────────────────────────────────────────────────
let updateTimer = null
let latestRelease = null
let downloadedDmg = null // dmg fallback path only
let downloading = false
let installStarted = false
let pendingUpdate = null // { tag, zipPath, target } - ready for in-place install
let ignoredTag = null // a release the user explicitly ignored (silenced)
let dismissedTag = null // a release the user closed the notification for (persisted)

/** Notify the page's update badge about an update state. */
function sendUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/** Remember the ignored tag so this release never nags again. */
function ignoreUpdate(tag) {
  ignoredTag = tag
  try {
    const dir = updater.updatesDir()
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ignored.json'), JSON.stringify({ ignoredTag: tag }))
    writeLog(`已忽略更新: ${tag}`)
  } catch (err) {
    writeLog(`忽略记录失败: ${err.message}`)
  }
}

/**
 * Remember that the user closed the notification (x / 稍后) for this
 * version. Unlike 忽略 the badge keeps its state, and the silence survives
 * app restarts - the periodic checks must not keep re-popup'ing a version
 * the user has already dismissed. A NEWER version, or an explicit menu
 * check, notifies again.
 */
function dismissUpdate(tag) {
  dismissedTag = tag
  try {
    const dir = updater.updatesDir()
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'dismissed.json'), JSON.stringify({ dismissedTag: tag }))
    writeLog(`已关闭更新提醒: ${tag}`)
  } catch (err) {
    writeLog(`关闭提醒记录失败: ${err.message}`)
  }
}

function loadDismissedTag() {
  try {
    const { readFileSync } = require('node:fs')
    return JSON.parse(readFileSync(join(updater.updatesDir(), 'dismissed.json'), 'utf8')).dismissedTag || null
  } catch {
    return null
  }
}

function loadIgnoredTag() {
  try {
    const { readFileSync } = require('node:fs')
    return JSON.parse(readFileSync(join(updater.updatesDir(), 'ignored.json'), 'utf8')).ignoredTag || null
  } catch {
    return null
  }
}

/**
 * Check GitHub for a newer build. When one exists, the page shows the
 * standard update notification ([更新] [忽略]) - downloading starts only on
 * the user's action. An ignored version stays silent; a later version
 * prompts again. A dismissed version stays silent for periodic/launch
 * checks (the user closed its notification); an explicit menu check still
 * reports it. Non-silent results show on the badge.
 */
async function checkForUpdate(silent = false) {
  try {
    const latest = await updater.fetchLatestRelease()
    if (!latest) {
      writeLog('更新检查失败: 无法获取最新 release')
      if (!silent) sendUpdate('update:error', '无法连接 GitHub，请检查网络')
      return
    }
    latestRelease = latest
    if (updater.hasUpdate(latest)) {
      if (latest.tag === ignoredTag) {
        writeLog(`新版本 ${latest.tag} 已被忽略`)
        return
      }
      if (latest.tag === dismissedTag && silent) {
        writeLog(`新版本 ${latest.tag} 提醒已关闭，静默`)
        return
      }
      writeLog(`发现新版本: ${latest.tag} (当前 ${updater.bundledCommit().slice(0, 12)}/${updater.bundledAppBuild()})`)
      sendUpdate('update:available', { ...latest, shortCommit: latest.upstream })
    } else {
      writeLog('已是最新版本')
      if (!silent) sendUpdate('update:uptodate', { shortCommit: latest.upstream })
    }
  } catch (err) {
    writeLog(`更新检查失败: ${err.message}`)
    if (!silent) sendUpdate('update:error', err.message)
  }
}

/**
 * Download the new build in the background (zip → in-place install; dmg →
 * download-and-open fallback). Notifies the badge along the way.
 */
async function performUpdate() {
  const latest = latestRelease
  if (!latest || downloading || installStarted) return
  // Already staged for this tag (also covers a restart with the zip on disk).
  if (pendingUpdate && pendingUpdate.tag === latest.tag) {
    sendUpdate('update:done', { kind: latest.kind, shortCommit: latest.upstream })
    return
  }
  if (latest.kind === 'zip') {
    const zipPath = updater.assetPath(latest.tag, latest.assetName)
    const { statSync } = require('node:fs')
    try { if (statSync(zipPath).size === latest.size) { stageZip(latest, zipPath); return } } catch { /* download */ }
  }
  downloading = true
  try {
    writeLog(`开始下载: ${latest.assetName}`)
    const file = await updater.downloadUpdate(latest, (percent) => {
      sendUpdate('update:progress', percent)
    })
    if (latest.kind === 'zip') {
      stageZip(latest, file)
    } else {
      downloadedDmg = file
      writeLog(`下载完成: ${file}（dmg 手动安装）`)
      sendUpdate('update:done', { kind: 'dmg', shortCommit: latest.upstream })
    }
  } catch (err) {
    writeLog(`下载失败: ${err.message}`)
    sendUpdate('update:error', err.message)
  } finally {
    downloading = false
  }
}

/** Mark a downloaded zip as ready; the badge switches to "restart to apply". */
function stageZip(latest, zipPath) {
  pendingUpdate = { tag: latest.tag, zipPath, target: updater.bundlePath() }
  writeLog(`更新就绪: ${latest.tag} (${zipPath})`)
  sendUpdate('update:done', { kind: 'zip', shortCommit: latest.upstream })
}

/**
 * Apply the staged zip: spawn the detached swap helper (it waits for this
 * process to exit, swaps Contents, relaunches) and quit.
 */
function installNow() {
  if (!pendingUpdate || !pendingUpdate.target || installStarted) return
  installStarted = true
  const updatesDir = updater.updatesDir()
  const isWin = process.platform === 'win32'
  const scriptPath = join(updatesDir, isWin ? 'install.cmd' : 'install.sh')
  const logPath = join(updatesDir, 'install.log')
  const tmp = join(pendingUpdate.target, '.update.tmp')
  try {
    const { writeFileSync, mkdirSync, rmSync } = require('node:fs')
    const { execFileSync } = require('node:child_process')
    mkdirSync(updatesDir, { recursive: true })
    writeFileSync(scriptPath, updater.installScript(), { mode: 0o755 })
    // Extract BEFORE quitting (macOS): the swap helper then only renames
    // (milliseconds), so a manual relaunch racing the swap can never boot
    // the old bundle mid-swap - that race made the update "not apply" and
    // the reminder loop forever.
    if (!isWin) {
      sendUpdate('update:installing')
      rmSync(tmp, { recursive: true, force: true })
      execFileSync('ditto', ['-x', '-k', pendingUpdate.zipPath, tmp], { stdio: 'ignore' })
    }
  } catch (err) {
    writeLog(`安装准备失败: ${err.message}`)
    sendUpdate('update:error', '更新包解压失败，请重试')
    installStarted = false
    return
  }
  writeLog(`开始安装: ${pendingUpdate.tag}`)
  // The swap helper is platform-specific: /bin/sh on macOS (does not exist
  // on Windows), cmd.exe for the .cmd helper on Windows. Must match
  // updater.installScript()'s platform branch.
  const child = isWin
    ? spawn('cmd.exe', ['/c', scriptPath,
        String(process.pid), pendingUpdate.zipPath, pendingUpdate.target, logPath],
      { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', [scriptPath,
        String(process.pid), tmp, pendingUpdate.target, logPath],
      { detached: true, stdio: 'ignore' })
  // Never let a spawn failure crash the main process with Electron's
  // uncaught-exception dialog — log it and keep the app running.
  child.on('error', (err) => {
    writeLog(`安装脚本启动失败: ${err.message}`)
  })
  child.unref()
  app.quit()
}

// ── bootstrap ─────────────────────────────────────────────────────────────
async function bootstrap() {
  buildMenu()

  // System chrome follows the configured appearance (system default).
  const bootTheme = appearance.load().theme === 'system' ? 'system' : appearance.load().theme
  if (nativeTheme.themeSource !== bootTheme) nativeTheme.themeSource = bootTheme

  // Auto-update: check shortly after launch (silent), then periodically; the
  // 检查更新… menu item checks on demand. Downloading starts from the
  // notification's 更新 button; applying happens on quit or via 立即重启.
  ipcMain.on('update:download', () => {
    if (!latestRelease) { checkForUpdate(false); return }
    performUpdate()
  })
  ipcMain.on('update:ignore', () => {
    if (latestRelease) ignoreUpdate(latestRelease.tag)
  })
  ipcMain.on('update:dismiss', () => {
    if (latestRelease) dismissUpdate(latestRelease.tag)
  })
  ipcMain.on('update:open-installer', () => {
    if (downloadedDmg) updater.openInstaller(downloadedDmg)
  })
  ipcMain.on('update:check', () => { checkForUpdate(false) }) // badge retry
  ipcMain.on('update:install', () => { installNow() }) // notification's restart
  // Seamless: quitting with a staged update applies it automatically.
  app.on('before-quit', () => {
    if (pendingUpdate && !installStarted) installNow()
  })
  ignoredTag = loadIgnoredTag()
  dismissedTag = loadDismissedTag()
  setTimeout(() => { checkForUpdate(true) }, updater.CHECK_DELAY_MS)
  updateTimer = setInterval(() => { checkForUpdate(true) }, updater.CHECK_INTERVAL_MS)

  // Allow clipboard access: modern Electron denies unhandled permission
  // requests by default, which breaks navigator.clipboard.readText() used by
  // the dsh UI (e.g. "copy code block"). Paste into inputs itself is covered
  // by the Edit menu roles, but these permissions keep the web APIs working.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(/^clipboard/.test(permission) || permission === 'fullscreen')
  })

  showSplash()
  try {
    const port = await pickPort()
    writeLog('端口: ' + port)
    const { nodeDir, dshDir } = runtimeRoot()
    // First launch on Windows: dsh/node_modules is not shipped (see
    // installServerDeps) — install it from the bundled offline store.
    if (process.platform === 'win32' && !existsSync(join(dshDir, 'node_modules'))) {
      await installServerDeps(nodeBinPath(nodeDir), dshDir)
    }
    launchServer(port)
    if (!serverProc) return // fatal already reported
    const url = await waitForServer(port)
    serverReady = true
    writeLog('就绪: ' + url)
    createWindow(url)
  } catch (err) {
    if (serverProc) await stopServer()
    fatal('启动失败', err.message + `\n\n日志: ${logFile()}`)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap)

  app.on('window-all-closed', () => { app.quit() })

  app.on('before-quit', async (e) => {
    if (quitting) return
    if (serverProc || installProc) {
      e.preventDefault()
      quitting = true
      writeLog('正在停止 dsh 服务…')
      if (installProc) {
        try { execFile('taskkill', ['/pid', String(installProc.pid), '/T', '/F'], () => {}) } catch { /* gone */ }
      }
      await stopServer()
      app.quit()
    }
  })

  process.on('exit', () => {
    if (installProc) {
      if (process.platform === 'win32') {
        try { execFile('taskkill', ['/pid', String(installProc.pid), '/T', '/F'], () => {}) } catch { /* gone */ }
      } else {
        try { installProc.kill('SIGKILL') } catch { /* gone */ }
      }
    }
    if (serverProc) {
      if (process.platform === 'win32') {
        try { execFile('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], () => {}) } catch { /* gone */ }
      } else {
        try { process.kill(-serverProc.pid, 'SIGKILL') } catch { /* gone */ }
      }
    }
  })
}
