/**
 * dsh-host-electron: a native desktop surface for the dsh web profile.
 *
 * When activated (DSH_DESKTOP=1), this plugin spawns an Electron child process
 * that loads the dsh web UI through a custom `dsh-app://` protocol. A preload
 * script overrides `fetch` and `WebSocket` to carry all RPC over an IPC bridge,
 * so the existing `WebApiClient` / `createWebConnectionRpc` run unchanged - only
 * the transport is swapped from browser HTTP/WS to Electron IPC.
 *
 * The plugin injects `webServer` so the port is bound before it reads
 * `ctx.webServer.port`; it owns the Electron process group and tears it down on
 * dispose via `ctx.effect` (the same detached-group + SIGTERM→SIGKILL pattern
 * `subprocess-local` uses), so no orphan survives a dsh shutdown.
 *
 * @module @deepseek-ai/dsh-host-electron
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'host-electron'

/** Wait for the web server to bind before reading its port. */
export const inject = ['webServer']

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Plugin config: resolved from the cordis.patch.yml row's `config` block. */
export interface ElectronConfig {
  /** Open DevTools on launch (DSH_DESKTOP_DEV=1). */
  dev: boolean
  /** Explicit path to the Electron binary; auto-detected when absent. */
  electronPath?: string
}

export const Config: z<ElectronConfig> = z.object({
  dev: z.boolean().default(false),
  electronPath: z.string(),
})

/** Credential-shaped names and DSH_* vars never leak into the Electron child. */
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SENSITIVE_ENV.test(key) && !key.startsWith('DSH_')) {
      out[key] = value
    }
  }
  return out
}

/**
 * Resolve the Electron executable. `require.resolve('electron')` returns the
 * npm package path; the actual binary lives at the `path.txt` relative path
 * inside the package. A GUI Electron launch has a minimal PATH and cannot see
 * nvm-managed installs, so probe well-known locations as a fallback.
 */
function resolveElectron(configPath?: string): string {
  if (configPath && existsSync(configPath)) return configPath

  // 1. require.resolve('electron') -> read path.txt -> resolve binary
  try {
    const pkgDir = dirname(require.resolve('electron/package.json'))
    const rel = readFileSync(join(pkgDir, 'path.txt'), 'utf8').trim()
    const bin = join(pkgDir, rel)
    if (existsSync(bin)) return bin
  } catch {
    /* electron not installed as a resolvable package */
  }

  // 2. Probe well-known install locations (mirrors desktop/ resolveNode)
  const home = homedir()
  const candidates = [
    '/opt/homebrew/bin/electron',
    '/usr/local/bin/electron',
    join(home, '.nvm/versions/node/v24.16.0/bin/electron'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  throw new Error(
    'host-electron: Electron binary not found. Install it (pnpm add -D electron) '
    + 'or set DSH_ELECTRON_PATH to the Electron executable.',
  )
}

/**
 * Spawn the Electron window process and register its teardown.
 *
 * The child runs detached in its own process group so `process.kill(-pid)`
 * tears down the whole Electron tree (main + GPU + renderer helpers) on
 * dispose. Stdout/stderr are forwarded to the dsh logger for diagnostics.
 */
export function apply(ctx: Context, config: ElectronConfig): void {
  const port = ctx.get('webServer')?.port
  if (port === undefined) {
    ctx.logger.warn('host-electron: webServer service has no port - skipping Electron launch')
    return
  }

  const electronPath = resolveElectron(config.electronPath)
  const mainScript = join(__dirname, 'electron-main.cjs')
  const preloadScript = join(__dirname, 'preload.cjs')

  if (!existsSync(mainScript) || !existsSync(preloadScript)) {
    ctx.logger.error(
      `host-electron: Electron scripts missing (expected at ${mainScript}). `
      + 'Run pnpm --filter @deepseek-ai/dsh-host-electron build.',
    )
    return
  }

  ctx.logger.info(`host-electron: launching Electron on port ${String(port)}`)

  const child = spawn(electronPath, [mainScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...scrubEnv(process.env),
      DSH_PORT: String(port),
      DSH_PRELOAD: preloadScript,
      DSH_DEV: config.dev ? '1' : '0',
    },
    windowsHide: false,
  }) as ChildProcess

  const onOut = (buf: Buffer): void => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line) ctx.logger.info(`[electron] ${line}`)
    }
  }
  child.stdout?.on('data', onOut)
  child.stderr?.on('data', onOut)

  child.on('error', (err) => {
    ctx.logger.error(`host-electron: failed to spawn Electron: ${err.message}`)
  })

  child.on('exit', (code, signal) => {
    ctx.logger.info(`host-electron: Electron exited code=${code} signal=${signal}`)
  })

  // Tear down the entire Electron process group on dispose. SIGTERM first,
  // then SIGKILL after a grace period - identical escalation to subprocess-local.
  ctx.effect(() => async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    ctx.logger.info('host-electron: stopping Electron…')
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, sig)
      } catch {
        try { child.kill(sig) } catch { /* already gone */ }
      }
    }
    killGroup('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killGroup('SIGKILL')
        resolve()
      }, 6000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }, 'host-electron: Electron process teardown')
}
