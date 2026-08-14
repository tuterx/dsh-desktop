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

const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const http = require('node:http')
const { existsSync, mkdirSync, createWriteStream } = require('node:fs')
const { join } = require('node:path')

const HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 120_000
const SHUTDOWN_GRACE_MS = 6_000
const isDev = process.argv.includes('--dev')

let serverProc = null
let mainWindow = null
let splashWindow = null
let serverReady = false
let quitting = false
let logStream = null

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

// ── server lifecycle ─────────────────────────────────────────────────────
function launchServer(port) {
  const { nodeDir, dshDir } = runtimeRoot()
  const nodeBin = join(nodeDir, 'bin', 'node')
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
      try { process.kill(-proc.pid, sig) } catch {
        try { proc.kill(sig) } catch { /* gone */ }
      }
    }
    killGroup('SIGTERM')
    setTimeout(() => { killGroup('SIGKILL'); finish() }, SHUTDOWN_GRACE_MS)
  })
}

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
            { type: 'separator' },
            { role: 'hide', label: '隐藏' },
            { role: 'hideOthers' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
          ],
        },
        edit,
        view,
        { role: 'windowMenu', label: '窗口' },
      ]
    : [
        { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
        edit,
        view,
        { role: 'windowMenu', label: '窗口' },
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── bootstrap ─────────────────────────────────────────────────────────────
async function bootstrap() {
  buildMenu()

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
    if (serverProc) {
      e.preventDefault()
      quitting = true
      writeLog('正在停止 dsh 服务…')
      await stopServer()
      app.quit()
    }
  })

  process.on('exit', () => {
    if (serverProc) {
      try { process.kill(-serverProc.pid, 'SIGKILL') } catch { /* gone */ }
    }
  })
}
