# dsh-desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）
打包成原生 macOS 桌面应用（.dmg），并**自动跟随上游仓库更新**。

## 产物

- `release/DeepSeek-Harness-<version>-arm64.dmg` — 可安装的桌面应用（Apple Silicon）
- 应用内含完整 dsh 运行时（自带的 Node 24 + 上游 workspace），用户**零依赖**

## 自动跟随上游

`.github/workflows/auto-build-dmg.yml` 每 6 小时检查一次上游
`deepseek-ai/deepseek-harness` 的 HEAD：

- 上游有新 commit → 自动构建 → 以 `dsh-<commit>` 为 tag 发布到 GitHub Release
- 上游无变化 → 跳过（不重复构建）
- 也可以在 Actions 页面手动触发 `workflow_dispatch`

## 本地构建

```sh
npm install                       # electron + electron-builder
npm run prepare:resources         # 拉上游 → pnpm build → 下载 Node 24 → resources/
npm run dist                      # electron-builder → release/*.dmg
```

只重新生成图标：

```sh
npm run icon
```

## 架构

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

### 关键工程决策

| 决策 | 原因 |
|------|------|
| 启动器模式（spawn dsh web + HTTP 加载） | .app 分发最稳定；只依赖 `dsh web` CLI，对上游内部 API 免疫 |
| 捆绑独立 Node 24 | Electron 自带 Node 不满足 dsh engines（需 ^22.19 \|\| >=24） |
| `afterPack` 钩子 rsync 复制 `node_modules` | electron-builder 无法解析 pnpm 符号链接布局，会静默丢弃整个 node_modules；rsync `--links` 保持相对符号链接 |
| 内嵌上游 git 仓库（depth 1） | 每次构建 `git fetch + reset --hard`，实现自动跟随 |
| npmmirror 镜像 | Electron / Node 二进制从 GitHub 下载慢或超时，CI 与本地构建均走镜像 |

## 目录

```
dsh-desktop/
├── electron/               # 应用主进程 + preload + 启动闪屏
├── scripts/
│   ├── prepare.sh          # 拉上游 → 构建 → 收集闭包（幂等，HEAD 未变则跳过）
│   ├── build-dmg.sh        # prepare + electron-builder
│   └── icon.sh             # favicon.svg → icon.icns
├── build/afterPack.js      # 打包后补复制 node_modules
├── assets/icon.icns        # DeepSeek 鲸鱼图标（从上游 favicon 生成）
└── .github/workflows/      # 自动跟随上游 + 发布
```

## 已知限制

- **未签名**：本地构建的 DMG 无 Developer ID 签名。首次运行时若 Gatekeeper
  拦截，请右键 → 打开。要消除提示需配置 `CSC_LINK`/`CSC_KEY_PASSWORD`（Apple
  Developer 证书）。
- 仅构建 **arm64**（Apple Silicon）；x64 用户需调整 `build.mac.target.arch`。
- 上游为开发者预览版，构建可能偶发失败——CI 会跳过该次发布，下个周期重试。

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
