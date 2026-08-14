import { defineConfig } from 'tsdown'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Cordis host entry builds as ESM (like every host package). The Electron
 * main and preload scripts are CommonJS (Electron's require discipline) and
 * are copied verbatim into lib/ after the build - they are path-loaded by the
 * host entry at spawn time, not bundled.
 *
 * Paths are resolved against this config file's location because the workspace
 * build (root `tsdown --env.DSH_BUILD_FACE host`) runs with cwd at the repo
 * root, not at the package directory.
 */
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  async onSuccess() {
    mkdirSync(join(here, 'lib'), { recursive: true })
    copyFileSync(join(here, 'src/electron-main.cjs'), join(here, 'lib/electron-main.cjs'))
    copyFileSync(join(here, 'src/preload.cjs'), join(here, 'lib/preload.cjs'))
  },
})
