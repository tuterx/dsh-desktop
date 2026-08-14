'use strict'

/**
 * electron-builder afterPack hook.
 *
 * macOS: electron-builder treats any node_modules inside extraResources as a
 * dependency tree to collect (npm-style), which silently DROPS the whole
 * node_modules directory when it cannot parse a pnpm symlink layout. dsh's
 * workspace is exactly that layout (node_modules/.pnpm + relative symlinks),
 * so we re-copy it verbatim after packaging, preserving the symlinks.
 *
 * Windows: node_modules is NOT shipped. pnpm junctions on Windows are
 * absolute-path links with dependency cycles (vendor/cordis <-> vendor/include),
 * so no copy or archive of the installed tree can be portable. The packaged
 * app installs deps on FIRST LAUNCH from the bundled offline store
 * (resources/pnpm-store + resources/pnpm-cli, see electron/main.cjs). This
 * hook only verifies those offline-bootstrap assets landed in the package.
 */

const { execSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const source = path.join(packager.projectDir, 'resources', 'dsh', 'node_modules')

  if (process.platform === 'win32') {
    // Windows layout: win-unpacked/resources/... (no .app wrapper).
    const res = path.join(appOutDir, 'resources')
    // electron-builder's extraResources collector resolves dependency trees
    // and silently drops node_modules it can't match — including the plain
    // npm layout of our bundled pnpm CLI. pnpm-cli is a real-directory npm
    // install (no links), so copy it verbatim here.
    const dstCli = path.join(res, 'pnpm-cli')
    const srcCli = path.join(packager.projectDir, 'resources', 'pnpm-cli')
    if (!fs.existsSync(path.join(dstCli, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))) {
      if (!fs.existsSync(path.join(srcCli, 'node_modules'))) {
        throw new Error('[afterPack] resources/pnpm-cli/node_modules missing — run prepare.sh first. Aborting.')
      }
      console.log('[afterPack] copying pnpm-cli/node_modules (npm layout, no links)…')
      fs.cpSync(path.join(srcCli, 'node_modules'), path.join(dstCli, 'node_modules'), { recursive: true, force: true })
    }
    const checks = {
      'pnpm CLI': path.join(res, 'pnpm-cli', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      'offline store index': path.join(res, 'pnpm-store', 'v11', 'index.db'),
      'offline store files': path.join(res, 'pnpm-store', 'v11', 'files'),
      'dsh workspace': path.join(res, 'dsh', 'apps', 'cli', 'lib', 'bin.js'),
      'node runtime': path.join(res, 'node', 'node.exe'),
    }
    const missing = Object.entries(checks).filter(([, p]) => !fs.existsSync(p)).map(([k]) => k)
    if (missing.length) {
      throw new Error(`[afterPack] Windows package missing: ${missing.join(', ')} — Aborting; do not ship this build.`)
    }
    console.log('[afterPack] verified Windows offline-bootstrap assets (pnpm-cli, pnpm-store, dsh, node)')
    return
  }

  if (!fs.existsSync(source)) {
    console.log('[afterPack] no source node_modules - skipping (dev?)')
    return
  }

  // macOS: re-copy the pnpm layout, preserving RELATIVE symlinks, into the .app.
  const appDir = path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  const target = path.join(appDir, 'Contents', 'Resources', 'dsh', 'node_modules')

  console.log('[afterPack] copying dsh/node_modules (pnpm layout, preserving symlinks)…')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  execSync(`rsync -a --links "${source}/" "${target}/"`, { stdio: 'inherit' })
  console.log(`[afterPack] done: ${fs.readdirSync(target).length} top-level entries`)
}
