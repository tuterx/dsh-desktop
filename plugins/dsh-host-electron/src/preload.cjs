'use strict'

/**
 * Preload script for the dsh-host-electron plugin.
 *
 * Runs in the renderer's isolated context before any page script. It overrides
 * `globalThis.fetch` and `globalThis.WebSocket` so that every RPC call the dsh
 * web client makes (via WebApiClient and createWebConnectionRpc) is carried over
 * Electron IPC instead of the browser's HTTP/WebSocket stack.
 *
 * contextIsolation: true is preserved throughout. The override script executes
 * in the page's MAIN world (where the dsh client code lives), so it cannot
 * touch ipcRenderer directly - it goes through the `dshBridge` API exposed by
 * contextBridge below, which proxies to ipcRenderer from the isolated world.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron')

const PORT = process.env.DSH_PORT || '3080'

// The main world talks to IPC exclusively through this bridge. Functions are
// serializable across the contextBridge boundary; channel names are fixed
// strings (never user input), so there is no injection surface.
contextBridge.exposeInMainWorld('dshBridge', {
  port: PORT,
  fetch: (url, init) => ipcRenderer.invoke('dsh:fetch', url, init),
  wsOpen: (url, id) => ipcRenderer.send('dsh:ws:open', url, id),
  wsSend: (id, data) => ipcRenderer.send('dsh:ws:send', id, data),
  wsClose: (id, code, reason) => ipcRenderer.send('dsh:ws:close', id, code, reason),
  // Subscribe to a relayed WS channel. The callback is invoked from the
  // isolated world and forwarded; only the channel key is constructed here.
  wsOn: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})

// The override logic runs in the page's main world via webFrame.executeJavaScript,
// which executes before the page's module scripts (the preload runs first).
const overrideScript = `
(function () {
  var PORT = ${PORT};
  var BASE = 'http://127.0.0.1:' + PORT;
  var bridge = window.dshBridge;

  // ── fetch override ────────────────────────────────────────────────────
  // Route dsh-app:// and same-origin API calls through the IPC bridge; pass
  // through any other fetch unchanged.

  var realFetch = globalThis.fetch;

  function shouldRouteToIpc(urlStr) {
    if (urlStr.indexOf('dsh-app://') === 0) return true;
    if (urlStr.indexOf('http://dsh.internal') === 0) return true;
    try {
      var u = new URL(urlStr, location.origin);
      return u.origin === location.origin || u.origin === 'null';
    } catch (e) {
      return false;
    }
  }

  function rewriteUrl(urlStr) {
    try {
      var u = new URL(urlStr, location.origin);
      return BASE + u.pathname + u.search + u.hash;
    } catch (e) {
      return urlStr;
    }
  }

  globalThis.fetch = function (input, init) {
    var urlStr = typeof input === 'string' ? input : (input && input.url) || String(input);

    if (!shouldRouteToIpc(urlStr)) {
      return realFetch(input, init);
    }

    var target = rewriteUrl(urlStr);

    var serialInit = { method: (init && init.method) || 'GET', headers: init && init.headers };
    if (init && init.body !== undefined) {
      if (typeof init.body === 'string') {
        serialInit.body = init.body;
      } else if (init.body instanceof ArrayBuffer) {
        serialInit.body = new TextDecoder().decode(init.body);
      } else if (init.body && init.body.byteLength !== undefined) {
        serialInit.body = new TextDecoder().decode(init.body);
      } else {
        serialInit.body = String(init.body);
      }
    }

    return bridge.fetch(target, serialInit).then(function (res) {
      var responseInit = {
        status: res.status,
        statusText: res.statusText,
        headers: new Headers(res.headers),
      };
      return new Response(res.body, responseInit);
    });
  };

  // ── WebSocket override ────────────────────────────────────────────────
  // The dsh client opens WebSockets for the two event streams (mux + host).
  // Intercept construction, send the URL to the main process which opens a
  // real WS to the dsh server and relays frames back over IPC.

  var RealWebSocket = globalThis.WebSocket;
  var socketIdSeq = 0;
  var listeners = {}; // id -> { type -> [fn] }

  function IpcWebSocket(url, protocols) {
    var self = this;
    self._id = 'ws-' + (++socketIdSeq);
    self._url = url;
    self._protocols = protocols;
    self.readyState = 0; // CONNECTING
    self._onprops = {};

    // Rewrite to ws://127.0.0.1:port for the main process relay.
    var rewritten = url;
    try {
      var u = new URL(url, location.origin);
      if (u.protocol === 'dsh-app:' || u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:') {
        rewritten = 'ws://127.0.0.1:' + PORT + u.pathname + u.search;
      }
    } catch (e) { /* pass through as-is */ }

    self._unsubscribes = [
      bridge.wsOn('dsh:ws:open:' + self._id, function () {
        self.readyState = 1; // OPEN
        emit(self, 'open', new Event('open'));
      }),
      bridge.wsOn('dsh:ws:message:' + self._id, function (data) {
        emit(self, 'message', new MessageEvent('message', { data: data }));
      }),
      bridge.wsOn('dsh:ws:close:' + self._id, function (code, reason) {
        self.readyState = 3; // CLOSED
        emit(self, 'close', new CloseEvent('close', { code: code || 1000, reason: reason || '' }));
        self._unsubscribes.forEach(function (fn) { fn() });
      }),
      bridge.wsOn('dsh:ws:error:' + self._id, function () {
        emit(self, 'error', new Event('error'));
      }),
    ];

    bridge.wsOpen(rewritten, self._id);
  }

  function emit(ws, type, ev) {
    var id = ws._id;
    if (!listeners[id]) return;
    var fns = listeners[id][type];
    if (fns) fns.slice().forEach(function (fn) { try { fn.call(ws, ev) } catch (e) { console.error(e) } });
    var prop = ws._onprops[type];
    if (typeof prop === 'function') { try { prop.call(ws, ev) } catch (e) { console.error(e) } }
  }

  IpcWebSocket.prototype.addEventListener = function (type, listener) {
    var id = this._id;
    if (!listeners[id]) listeners[id] = {};
    if (!listeners[id][type]) listeners[id][type] = [];
    listeners[id][type].push(listener);
  };
  IpcWebSocket.prototype.removeEventListener = function (type, listener) {
    var id = this._id;
    var arr = listeners[id] && listeners[id][type];
    if (arr) {
      var i = arr.indexOf(listener);
      if (i !== -1) arr.splice(i, 1);
    }
  };
  IpcWebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new DOMException('WebSocket is not in OPEN state', 'InvalidStateError');
    bridge.wsSend(this._id, data);
  };
  IpcWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 2; // CLOSING
    bridge.wsClose(this._id, code, reason);
  };

  // onopen/onmessage/onclose/onerror accessors
  ['open', 'message', 'close', 'error'].forEach(function (type) {
    Object.defineProperty(IpcWebSocket.prototype, 'on' + type, {
      get: function () { return this._onprops[type] },
      set: function (fn) { this._onprops[type] = fn },
    });
  });

  Object.defineProperty(IpcWebSocket.prototype, 'url', {
    get: function () { return this._url },
  });

  IpcWebSocket.CONNECTING = 0;
  IpcWebSocket.OPEN = 1;
  IpcWebSocket.CLOSING = 2;
  IpcWebSocket.CLOSED = 3;

  globalThis.WebSocket = IpcWebSocket;
})();
`

webFrame.executeJavaScript(overrideScript).catch((err) => {
  console.error('[host-electron] override script failed:', err.message)
})

// Also expose a minimal descriptor for any future shell integrations.
contextBridge.exposeInMainWorld('dshDesktop', {
  port: PORT,
  isElectron: true,
})
