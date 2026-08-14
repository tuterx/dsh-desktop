# dsh-desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）
打包成原生 **macOS / Windows 桌面应用**，并**自动跟随上游仓库更新**。
核心是桌面端（Electron 壳 + 内嵌 dsh 运行时，零依赖、离线可用）；仓库同时
包含 beta 插件 `plugins/dsh-host-electron`（以 dsh 原生插件方式运行桌面端）。

## 产物

- macOS: `release/DeepSeek-Harness-<version>-arm64.dmg` — 可安装的桌面应用（Apple Silicon）
- Windows: `release/DeepSeek-Harness-<version>-win-x64.zip` — 绿色版（解压即用）
- 应用内含完整 dsh 运行时（自带的 Node 24 + 上游 workspace），用户**零网络依赖**；
  Windows 首次启动时自动用捆绑的离线 store 安装依赖（约 10 秒）

## 自动跟随上游

`.github/workflows/auto-build-dmg.yml`（macOS）与
`auto-build-win.yml`（Windows）每 6 小时检查一次上游
`deepseek-ai/deepseek-harness` 的 HEAD：

- 上游有新 commit → 自动构建 → 以 `dsh-<commit>` 为 tag 发布到 GitHub Release
- 上游无变化 → 跳过（不重复构建）
- 也可以在 Actions 页面手动触发 `workflow_dispatch`

## 本地构建

```sh
npm install                       # electron + electron-builder
npm run prepare:resources         # 拉上游 → 构建 → 下载 Node 24 → resources/
npm run dist                      # macOS: electron-builder → release/*.dmg
npm run dist:win                  # Windows: zip 绿色版 → release/*.zip
```

只重新生成图标：

```sh
npm run icon
```

> Windows 注意：`dist:win` 需要 Git Bash（`bash`）与 pnpm（`corepack enable`）。
> 首次构建从 npmmirror 下载 Electron/Node 二进制，网络不通时可用
> `NODE_MIRROR` / `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`
> 环境变量切换镜像，`UPSTREAM_REPO` 可指向上游镜像仓库。

## 架构

### macOS (`DeepSeek Harness.app`)

```
DeepSeek Harness.app
├── Electron 主进程 (electron/main.cjs)
│   ├── 选空闲端口 → spawn resources/node/bin/node
│   │      resources/dsh/apps/cli/lib/bin.js web --host 127.0.0.1 --port <port>
│   ├── 启动闪屏 → 轮询端口就绪 → BrowserWindow 加载 http://127.0.0.1:<port>
│   └── 退出时 SIGTERM 整个 dsh 进程组（6s 后 SIGKILL 兜底）— 无孤儿进程
└── Contents/Resources
    ├── node/   独立 Node 24 runtime（dsh engines: ^22.19 || >=24）
    └── dsh/    上游 workspace 完整闭包（apps/cli/lib + apps/web/dist + node_modules）
```

### Windows (`win-unpacked/`)

```
win-unpacked/
├── DeepSeek Harness.exe   (Electron 主进程，逻辑同 macOS 版)
└── resources/
    ├── node.exe           独立 Node 24 runtime（win-x64）
    └── dsh/               上游 workspace 完整闭包（apps/cli/lib + apps/web/dist + node_modules）
```

### 关键工程决策

| 决策 | 原因 |
|------|------|
| 启动器模式（spawn dsh web + HTTP 加载） | 分发最稳定；只依赖 `dsh web` CLI，对上游内部 API 免疫 |
| 捆绑独立 Node 24 | Electron 自带 Node 不满足 dsh engines（需 ^22.19 \|\| >=24） |
| macOS `afterPack` rsync 复制 `node_modules` | electron-builder 无法解析 pnpm 符号链接布局，会静默丢弃整个 node_modules；POSIX 下 pnpm symlink 是相对的，rsync `--links` 可原样保留 |
| Windows 首次启动现场安装依赖 | pnpm 在 Windows 的 junction 是绝对路径链接且存在依赖环（vendor/cordis ↔ vendor/include），任何拷贝/归档要么产生死链要么无限递归——node_modules 不进安装包，首次启动用捆绑的离线 store 跑 `pnpm install --offline`，链接生成在用户安装路径上，天然自包含 |
| Windows `afterPack` 校验 | 钩子只校验离线资产（pnpm-cli / pnpm-store / dsh / node）是否落包，缺失即中止构建 |
| 内嵌上游 git 仓库（depth 1） | 每次构建 `git fetch + reset --hard`，实现自动跟随；fetch 失败但本地 HEAD 与上次构建一致时跳过（幂等），不一致则硬失败 |
| npmmirror 镜像 | Electron / Node 二进制从 GitHub 下载慢或超时，CI 与本地构建均走镜像 |

## 目录

```
dsh-desktop/
├── electron/               # 应用主进程 + preload + 启动闪屏
├── scripts/
│   ├── prepare.sh          # 拉上游 → 构建 → 收集闭包（幂等，HEAD 未变则跳过）
│   ├── build-dmg.sh        # macOS: prepare + electron-builder
│   ├── build-win.sh        # Windows: prepare + electron-builder
│   └── icon.sh             # favicon.svg → icon.icns
├── build/afterPack.js      # 打包后处理 node_modules（mac 复制 / win 重建）
├── assets/icon.icns        # DeepSeek 鲸鱼图标（macOS；Windows 用 icon.png）
└── .github/workflows/      # 自动跟随上游 + 发布（macOS + Windows）
```

## 已知限制

- **未签名**：macOS 本地构建的 DMG 无 Developer ID 签名（Gatekeeper 拦截时
  右键 → 打开）；Windows zip 无 Authenticode 签名（SmartScreen 提示
  "仍要运行"）。要消除提示需配置 `CSC_LINK`/`CSC_KEY_PASSWORD` 证书。
- macOS 仅构建 **arm64**（Apple Silicon）；Windows 仅 x64。
- 上游为开发者预览版，构建可能偶发失败——CI 会跳过该次发布，下个周期重试。
- Windows 为 zip 绿色版：首次启动需联网无关的依赖安装（捆绑离线 store，
  约 10 秒）；NSIS 安装版因 pnpm junction 的绝对路径/循环限制暂未提供。

## Beta 备选方案：dsh-host-electron 插件（路径③）

仓库还包含一个 **beta 插件** `plugins/dsh-host-electron/`——以 dsh 原生插件方式
运行桌面端（`DSH_DESKTOP=1 dsh web`，dsh 进程自己拉起 Electron，RPC 走 IPC
桥接）。与打包版（路径②）互补：

| | 打包版 (本工程) | 插件版 (beta) |
|---|---|---|
| 形态 | 独立 .app，用户零依赖 | `dsh plugin` 安装的 Cordis 插件 |
| 上游兼容 | 只依赖 `dsh web` CLI | 依赖 `ctx.webServer` 等内部 API |
| 构建 | `npm run dist` | `pnpm --filter ... build` 后发布 npm |
| 适合 | 分发、稳定使用 | 插件生态、源码集成 |

详见 [plugins/dsh-host-electron/README.md](plugins/dsh-host-electron/README.md)。
