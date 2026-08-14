#!/usr/bin/env bash
# =============================================================================
# prepare.sh -- pull the latest upstream deepseek-harness, build it, and collect
# the runtime closure (dsh workspace + standalone Node) into ./resources.
#
#   resources/dsh/   full upstream workspace, built (apps/cli/lib, apps/web/dist)
#   resources/node/  standalone Node runtime matching dsh's engines
#   resources/dsh/UPSTREAM_COMMIT  pinned upstream commit for version display
#   resources/APP_BUILD            dsh-desktop shell commit (release identity)
#
# Usage: bash scripts/prepare.sh [--force]
#   --force  rebuild even when upstream is unchanged
#   env APP_SHA  shell commit to record (CI sets ${{ github.sha }})
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RES="$ROOT/resources"

NODE_VERSION="v24.16.0"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/deepseek-ai/deepseek-harness}"
UPSTREAM_BRANCH="master"

# Host platform: macOS (darwin-arm64) vs Windows (win-x64, run from Git Bash).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;;
  *) IS_WIN=0 ;;
esac
NODE_PLATFORM="$([ "$IS_WIN" -eq 1 ] && echo "win-x64" || echo "darwin-arm64")"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

echo "-- dsh-desktop prepare --------------------------------------"

# -- 1. upstream workspace -------------------------------------------------
HEAD_FILE="$RES/UPSTREAM_COMMIT"
if [ -d "$RES/dsh/.git" ]; then
  echo "[upstream] pulling latest $UPSTREAM_BRANCH..."
  # Network can be flaky; only continue without a fresh fetch when the local
  # HEAD still matches the commit we already built (idempotent rebuilds).
  # A HEAD mismatch with a failed fetch is a hard error — never silently
  # rebuild from an unknown/old commit.
  if ! git -C "$RES/dsh" fetch origin "$UPSTREAM_BRANCH" --depth 1 >/dev/null 2>&1; then
    if [ -f "$HEAD_FILE" ] && [ "$(git -C "$RES/dsh" rev-parse HEAD)" = "$(cat "$HEAD_FILE")" ]; then
      echo "[upstream] fetch failed (network); local HEAD matches last build -- continuing"
    else
      echo "[upstream] fetch failed and local HEAD differs from last build" >&2
      exit 1
    fi
  fi
  git -C "$RES/dsh" reset --hard "origin/$UPSTREAM_BRANCH" >/dev/null
  # -fd (not -fdx): drop untracked non-ignored files, but KEEP ignored build
  # artifacts (lib/, dist/, node_modules) and the npm-generated lockfile so
  # the unchanged-commit skip works and Windows builds don't re-resolve deps.
  git -C "$RES/dsh" clean -fd --exclude=node_modules --exclude=package-lock.json >/dev/null || true
else
  echo "[upstream] cloning $UPSTREAM_REPO..."
  mkdir -p "$RES"
  git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_REPO" "$RES/dsh"
fi

UPSTREAM_COMMIT="$(git -C "$RES/dsh" rev-parse HEAD)"
echo "[upstream] pinned commit: ${UPSTREAM_COMMIT:0:12}"

# Shell identity: which dsh-desktop commit built this DMG. Always written
# (not a build gate) so the in-app updater can detect shell-code updates.
APP_SHA="${APP_SHA:-$(git rev-parse --short HEAD 2>/dev/null || true)}"
APP_SHA="${APP_SHA:0:7}"
[ -n "$APP_SHA" ] || APP_SHA="0000000"
echo "$APP_SHA" > "$RES/APP_BUILD"
echo "[shell]   app build: $APP_SHA"

# Skip rebuild when unchanged (unless forced). The marker lives OUTSIDE the
# upstream checkout (resources/UPSTREAM_COMMIT) because `git clean` inside the
# clone would otherwise delete it and force a rebuild every time.
if [ "$FORCE" -eq 0 ] && [ -f "$HEAD_FILE" ] && [ "$(cat "$HEAD_FILE")" = "$UPSTREAM_COMMIT" ] \
   && [ -f "$RES/dsh/apps/cli/lib/bin.js" ] && [ -f "$RES/dsh/apps/web/dist/index.html" ]; then
  echo "[upstream] unchanged since last build -- skipping build"
else
  echo "[build] install + build (this takes several minutes)..."
  cd "$RES/dsh"
  command -v pnpm >/dev/null || { echo "ERROR: pnpm not found -- install it first (corepack enable or npm i -g pnpm)" >&2; exit 1; }
  # Windows: hoisted layout minimizes junctions; the tree itself is NOT shipped
  # (the zip excludes node_modules, and the app installs deps on first launch
  # from the bundled offline store — see section 3.5).
  PNPM_LINKER_FLAG=()
  [ "$IS_WIN" -eq 1 ] && PNPM_LINKER_FLAG=(--config.node-linker=hoisted)
  pnpm install --reporter=append-only "${PNPM_LINKER_FLAG[@]}"
  npm run build
  echo "$UPSTREAM_COMMIT" > "$HEAD_FILE"
  cd "$ROOT"
fi

# -- 1a. prune dev-only tooling from node_modules (runtime closure only) ----
# The monorepo's dev toolchain (typescript, vite, vitest, tsdown, eslint,
# lefthook, ...) is never imported at runtime; deleting it trims ~300MB from
# the packaged app. The CI smoke step boots the web server afterwards, so a
# future upstream change that starts requiring one of these fails CI instead
# of shipping a broken app. Idempotent - safe on every prepare run.
if [ -d "$RES/dsh/node_modules/.pnpm" ]; then
  echo "[prune] removing dev-only tooling from node_modules..."
  # set -e-safe: find/rm failures are tolerable (idempotent prune)
  (cd "$RES/dsh/node_modules" && find .pnpm -maxdepth 1 -type d \( \
      -name "typescript@*" -o -name "vite@*" -o -name "vitest@*" -o -name "tsdown@*" \
      -o -name "eslint@*" -o -name "lefthook@*" -o -name "tsx@*" -o -name "rolldown*" \
      -o -name "jiti@*" -o -name "lightningcss@*" -o -name "esbuild@*" -o -name "@esbuild*" \
      -o -name "publint@*" -o -name "knip@*" -o -name "jscpd@*" -o -name "vitepress@*" \
      -o -name "oxlint*" -o -name "@oxlint*" -o -name "@rolldown*" -o -name "@types+*" \
      -o -name "playwright*" -o -name "@eslint+*" -o -name "prettier*" \) -exec rm -rf {} + 2>/dev/null || true)
  # Top-level entries are symlinks on macOS but REAL DIRECTORIES in the
  # Windows hoisted layout — rm -f cannot remove a directory, so use rm -rf
  # there. Failures are tolerable (idempotent prune, set -e-safe).
  RM_TOP="rm -f"
  [ "$IS_WIN" -eq 1 ] && RM_TOP="rm -rf"
  for t in typescript vite vitest tsdown eslint lefthook tsx rolldown jiti lightningcss \
           esbuild publint knip jscpd vitepress oxlint prettier playwright-core; do
    $RM_TOP "$RES/dsh/node_modules/$t" 2>/dev/null || true
  done
fi

# -- 2. standalone Node runtime --------------------------------------------
NODE_ARCHIVE="node-$NODE_VERSION-$NODE_PLATFORM"
if [ "$IS_WIN" -eq 1 ]; then
  NODE_URL="$NODE_MIRROR/$NODE_VERSION/$NODE_ARCHIVE.zip"
  NODE_BIN="$RES/node/node.exe"
else
  NODE_URL="$NODE_MIRROR/$NODE_VERSION/$NODE_ARCHIVE.tar.gz"
  NODE_BIN="$RES/node/bin/node"
fi
if [ -x "$NODE_BIN" ] && "$NODE_BIN" --version 2>/dev/null | grep -q "$NODE_VERSION"; then
  echo "[node] already present: $("$NODE_BIN" --version)"
else
  echo "[node] downloading $NODE_ARCHIVE..."
  rm -rf "$RES/node" "$RES/$NODE_ARCHIVE"
  curl -fL --retry 3 -o "$RES/$NODE_ARCHIVE.zip" "$NODE_URL"
  if [ "$IS_WIN" -eq 1 ]; then
    unzip -q "$RES/$NODE_ARCHIVE.zip" -d "$RES"
    mv "$RES/$NODE_ARCHIVE" "$RES/node"
  else
    mv "$RES/$NODE_ARCHIVE.zip" "$RES/$NODE_ARCHIVE.tar.gz"
    tar -xzf "$RES/$NODE_ARCHIVE.tar.gz" -C "$RES"
    mv "$RES/$NODE_ARCHIVE" "$RES/node"
  fi
  rm -f "$RES/$NODE_ARCHIVE.zip" "$RES/$NODE_ARCHIVE.tar.gz"
  "$NODE_BIN" --version
fi

# -- 3. Windows offline bootstrap (store + pnpm CLI) -----------------------
# The packaged app installs dsh's node_modules ON FIRST LAUNCH (main.cjs):
# pnpm junctions are absolute-path links with dependency cycles on Windows, so
# no copy/archive of the installed tree can be portable. Instead we bundle the
# pnpm content store and a pnpm CLI; first launch runs
#   pnpm install --offline --store-dir <bundled store>
# which rebuilds a correct, self-contained tree at the user's install path.
if [ "$IS_WIN" -eq 1 ]; then
  # (a) standalone pnpm CLI (offline installs don't need the network)
  PNPM_CLI="$RES/pnpm-cli"
  if [ -f "$PNPM_CLI/node_modules/pnpm/bin/pnpm.cjs" ] && [ "$FORCE" -eq 0 ]; then
    echo "[pnpm-cli] already present"
  else
    echo "[pnpm-cli] installing pnpm@11.7.0 (local, offline installs)..."
    rm -rf "$PNPM_CLI"
    npm install --prefix "$PNPM_CLI" --no-audit --no-fund pnpm@11.7.0
  fi

  # (b) offline content store (copied verbatim — real files, no links)
  STORE_SRC="$(pnpm store path 2>/dev/null || true)"
  STORE_DST="$RES/pnpm-store"
  if [ -n "$STORE_SRC" ] && [ -d "$STORE_SRC" ] && [ -f "$STORE_DST/.ds-store-ready" ] && [ "$FORCE" -eq 0 ]; then
    echo "[store] already present: $(du -sh "$STORE_DST" 2>/dev/null | cut -f1)"
  else
    echo "[store] copying pnpm store from $STORE_SRC ..."
    rm -rf "$STORE_DST"
    # pnpm treats --store-dir as the store ROOT and uses <root>/v11 as the
    # content dir (it appends the store version). Mirror that layout so the
    # packaged store is recognized by `pnpm install --offline`.
    mkdir -p "$STORE_DST/v11"
    # robocopy silently copies NOTHING when given mixed separators
    # (D:\.pnpm-store\v11/files) — normalize both paths to native Windows.
    STORE_SRC_WIN="$(cygpath -w "$STORE_SRC")"
    STORE_DST_WIN="$(cygpath -w "$STORE_DST")"
    # files/ holds plain content-addressed files — robocopy copies them as-is.
    # MSYS_NO_PATHCONV stops Git Bash from mangling /E, /R:1 etc. into paths.
    MSYS_NO_PATHCONV=1 robocopy "$STORE_SRC_WIN\\files" "$STORE_DST_WIN\\v11\\files" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NC /NS /NP || RC=$?
    RC="${RC:-0}"
    if [ "$RC" -ge 8 ]; then echo "[store] robocopy failed (code $RC)" >&2; exit 1; fi
    # index.db is a SQLite DB in WAL mode: the main file lags behind and new
    # package records live in the -wal file until checkpoint. A plain copy
    # would ship a stale index. VACUUM INTO performs an online backup that
    # merges the WAL.
    "$RES/node/node.exe" -e "
      const { DatabaseSync } = require('node:sqlite')
      const src = process.argv[1], dst = process.argv[2]
      const db = new DatabaseSync(src, { readOnly: true })
      db.exec(\"VACUUM INTO '\" + dst.replace(/'/g, \"''\") + \"'\")
      db.close()
      console.log('[store] index.db backed up (WAL merged)')
    " "$STORE_SRC/index.db" "$STORE_DST/v11/index.db" || { echo "[store] index.db backup failed" >&2; exit 1; }
    touch "$STORE_DST/.ds-store-ready"
    echo "[store] done: $(du -sh "$STORE_DST" 2>/dev/null | cut -f1)"
  fi
fi

# -- 4. report -------------------------------------------------------------
SIZE=$(du -sh "$RES" 2>/dev/null | cut -f1)
echo "--------------------------------------------------------------"
echo "[OK]  resources ready: $SIZE"
echo "   upstream commit: ${UPSTREAM_COMMIT:0:12}"
echo "   next: npm install && npm run dist   (macOS: release/*.dmg)"
echo "         npm install && npm run dist:win   (Windows: release/*.exe)"
