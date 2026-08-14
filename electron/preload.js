'use strict'

/**
 * Preload - runs in an isolated context before the dsh page loads.
 *
 * The dsh web UI is fully self-contained (it talks to its local server over
 * HTTP/WebSocket), so no Node APIs are exposed to the page. Only a tiny,
 * safe descriptor is bridged for shell integration.
 */

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  electron: process.versions.electron,
  node: process.versions.node,
})
