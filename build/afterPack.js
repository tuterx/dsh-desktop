'use strict'

/**
 * electron-builder afterPack hook.
 *
 * electron-builder treats any node_modules inside extraResources as a
 * dependency tree to collect (npm-style), which silently DROPS the whole
 * node_modules directory when it cannot parse a pnpm symlink layout. dsh's
 * workspace is exactly that layout (node_modules/.pnpm + relative symlinks),
 * so we re-copy it verbatim after packaging, preserving the symlinks.
 *
 * Runs after the app bundle is assembled, before the DMG is built.
 */

const { execSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const source = path.join(packager.projectDir, 'resources', 'dsh', 'node_modules')
  // appOutDir is release/mac-arm64; the bundle itself is <productName>.app inside it.
  const appDir = path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  const target = path.join(appDir, 'Contents', 'Resources', 'dsh', 'node_modules')

  if (!fs.existsSync(source)) {
    console.log('[afterPack] no source node_modules - skipping (dev?)')
    return
  }

  console.log('[afterPack] copying dsh/node_modules (pnpm layout, preserving symlinks)…')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  execSync(`rsync -a --links "${source}/" "${target}/"`, { stdio: 'inherit' })
  console.log(`[afterPack] done: ${fs.readdirSync(target).length} top-level entries`)
}
