'use strict'

/**
 * Electron main process for the dsh-host-electron plugin.
 *
 * Launched by the Cordis host plugin with DSH_PORT (the bound web server port)
 * and DSH_PRELOAD (the preload script path) in the environment.
 *
 * Responsibilities:
 * 1. Register a custom `dsh-app://` protocol that proxies all requests to the
 *    local HTTP server (http://127.0.0.1:DSH_PORT). This preserves the
 *    server-side __DSH_BOOT__ injection and serves assets/plugins identically.
 * 2. Bridge RPC: ipcMain.handle('dsh:fetch') proxies fetch calls to the server.
 * 3. Relay WebSocket event streams: the preload overrides WebSocket to send
 *    IPC messages; the main process opens real WebSockets to the server and
 *    forwards frames back over IPC.
 * 4. Manage the BrowserWindow lifecycle.
 */

const { app, BrowserWindow, protocol, ipcMain, session, shell, Menu, nativeTheme } = require('electron')
const { net } = require('electron')
const path = require('node:path')
const http = require('node:http')

const PORT = parseInt(process.env.DSH_PORT || '3080', 10)
const PRELOAD = process.env.DSH_PRELOAD
const DEV = process.env.DSH_DEV === '1'
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`

// ── custom protocol ──────────────────────────────────────────────────────
// Must be registered before app.ready. Privileged so fetch, streams, and
// standard URL parsing work. dsh-app://app/ -> proxy to http://127.0.0.1:port/

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsh-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      allowServiceWorkers: false,
      corsEnabled: true,
    },
  },
])

/** Rewrite a dsh-app:// URL to the corresponding http://127.0.0.1:port URL. */
function rewriteToHttp(dshAppUrl) {
  const u = new URL(dshAppUrl)
  // dsh-app://app/<path> -> http://127.0.0.1:port/<path>
  return `${BASE}${u.pathname}${u.search}${u.hash}`
}

// ── WebSocket relay ──────────────────────────────────────────────────────
// The preload's IpcWebSocket sends 'dsh:ws:open' with a URL and a client id.
// The main process opens a real WebSocket to the server and relays frames.

const wsChannels = new Map() // id -> { socket, webContents }

/** Open a real WebSocket to the dsh server for relay. */
function openRelaySocket(webContents, id, url) {
  // Node has no built-in WebSocket before v22; use a raw upgrade via http.
  // Electron's net module can also do this, but a manual frame parser is
  // overkill. Instead, use the global WebSocket (available in Node 22+).
  const realUrl = url.startsWith('ws://') || url.startsWith('wss://')
    ? url.replace(/^ws(s?):\/\//, 'http$1://')
    : rewriteToHttp(url)

  const ws = new WebSocket(realUrl)

  wsChannels.set(id, { socket: ws, webContents })

  ws.addEventListener('open', () => {
    if (!webContents.isDestroyed()) {
      webContents.send('dsh:ws:open:' + id)
    }
  })

  ws.addEventListener('message', (event) => {
    if (!webContents.isDestroyed()) {
      webContents.send('dsh:ws:message:' + id, event.data)
    }
  })

  ws.addEventListener('close', (event) => {
    wsChannels.delete(id)
    if (!webContents.isDestroyed()) {
      webContents.send('dsh:ws:close:' + id, event.code, event.reason)
    }
  })

  ws.addEventListener('error', () => {
    if (!webContents.isDestroyed()) {
      webContents.send('dsh:ws:error:' + id)
    }
  })
}

// ── IPC handlers ─────────────────────────────────────────────────────────

/** Proxy a fetch call to the local dsh server via Electron's net module. */
ipcMain.handle('dsh:fetch', async (_event, url, init) => {
  const target = rewriteToHttp(url)
  if (DEV) console.log(`[electron:ipc-fetch] ${init?.method || 'GET'} ${target}`)
  const response = await net.fetch(target, {
    method: init?.method || 'GET',
    headers: init?.headers,
    body: init?.body,
  })
  const headers = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  const body = await response.text()
  if (DEV) console.log(`[electron:ipc-fetch] ${target} => ${response.status} (${body.length}b)`)
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
  }
})

ipcMain.on('dsh:ws:open', (event, url, id) => {
  if (DEV) console.log(`[electron:ipc-ws] open id=${id} url=${url}`)
  openRelaySocket(event.sender, id, url)
})

ipcMain.on('dsh:ws:send', (_event, id, data) => {
  const ch = wsChannels.get(id)
  if (ch?.socket.readyState === WebSocket.OPEN) {
    ch.socket.send(data)
  }
})

ipcMain.on('dsh:ws:close', (_event, id, code, reason) => {
  const ch = wsChannels.get(id)
  if (ch) {
    ch.socket.close(code, reason)
    wsChannels.delete(id)
  }
})

// ── window ───────────────────────────────────────────────────────────────

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Load through the custom protocol - the handler proxies to the HTTP server,
  // which serves index.html with __DSH_BOOT__ already injected.
  mainWindow.loadURL('dsh-app://app/')

  // Diagnostics: report load progress and the rendered page state to stdout so
  // the host plugin's log forwarder can surface what went wrong without DevTools.
  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[electron] did-finish-load: ${mainWindow?.webContents.getURL()}`)
    mainWindow?.webContents.executeJavaScript('document.title + " | boot:" + (!!window.__DSH_BOOT__)').then((v) => {
      console.log(`[electron] page title: ${v}`)
    }).catch((e) => console.log(`[electron] page probe failed: ${e.message}`))
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[electron] did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[electron] render-process-gone reason=${details.reason}`)
  })
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (DEV) console.log(`[electron:console] ${message}`)
  })

  if (DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // Route external links to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http://') || u.startsWith('https://')) {
      shell.openExternal(u)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // Downloads (session export) -> default to ~/Downloads.
  mainWindow.webContents.session.on('will-download', (_e, item) => {
    try {
      item.setSaveDialogOptions({
        defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
      })
    } catch { /* default behavior */ }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── menu ─────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin'
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
        {
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
        },
        { role: 'windowMenu', label: '窗口' },
      ]
    : [
        { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
        {
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
        },
        { role: 'windowMenu', label: '窗口' },
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── bootstrap ────────────────────────────────────────────────────────────

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

  app.whenReady().then(() => {
    // Register the dsh-app:// protocol handler: proxy everything to the HTTP server.
    //
    // Three hard-won rules for protocol.handle + net.fetch:
    // 1. Return net.fetch's Response object DIRECTLY - re-wrapping it in
    //    `new Response(...)` breaks the stream and every load fails ERR_FAILED.
    // 2. Do NOT pass request.headers / request.body / duplex through to
    //    net.fetch - under concurrent asset loads that combination makes
    //    net.fetch throw ERR_FAILED. A clean GET works reliably.
    // 3. Mutate response.headers in place to add CORS headers: the page's
    //    `<script type="module" crossorigin>` tags load bundles in CORS mode,
    //    and the dsh server emits no Access-Control-Allow-Origin.
    // API POSTs never reach this handler: the preload fetch override routes
    // them over the dsh:fetch IPC channel instead.
    protocol.handle('dsh-app', async (request) => {
      const u = new URL(request.url)
      const target = `${BASE}${u.pathname}${u.search}`
      if (DEV) console.log(`[electron:proxy] ${request.method} ${request.url} -> ${target}`)
      try {
        const response = await net.fetch(target, { method: request.method })
        try {
          response.headers.set('Access-Control-Allow-Origin', '*')
          response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
          response.headers.set('Access-Control-Allow-Headers', '*')
        } catch { /* headers frozen - same-origin requests still work */ }
        if (DEV) console.log(`[electron:proxy] ${request.url} => ${response.status}`)
        return response
      } catch (err) {
        if (DEV) console.log(`[electron:proxy] ${request.url} FAILED: ${err.message}`)
        throw err
      }
    })

    buildMenu()
    nativeTheme.themeSource = 'dark'
    createWindow()
  })

  // The server is the whole app: quit on every platform when the window closes.
  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    // Close all relayed WebSockets cleanly.
    for (const [id, ch] of wsChannels) {
      try { ch.socket.close() } catch { /* ignore */ }
    }
    wsChannels.clear()
  })
}
