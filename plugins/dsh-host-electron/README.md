# dsh-host-electron (BETA)

> **Beta 备选方案** — 与 [dsh-desktop](../README.md)（路径② 启动器打包版）互补的
> 另一种桌面化形态：以 **dsh 原生插件** 方式运行（`DSH_DESKTOP=1 dsh web`），
> dsh 进程自己拉起 Electron 窗口，RPC 全部走 **IPC 桥接**。
>
> 选择建议：
> - 想要**开箱即用的 .app**（零依赖、自动跟上游）→ 用 dsh-desktop 打包版
> - 想要**插件生态集成**（`dsh plugin` 安装、profile 组合、源码体验）→ 用本插件

Desktop surface plugin for DeepSeek Harness: spawns an Electron window over the
dsh web server and carries all RPC over an **IPC bridge** instead of the
browser's HTTP/WebSocket stack.

Part of the `dsh-plugin` ecosystem - installs as a standard Cordis bundle.

## Architecture

```
dsh 进程 (Cordis)
├─ webServer ── 绑定 127.0.0.1:<port>，注入 __DSH_BOOT__
└─ host-electron (本插件) ── inject: [webServer]
    ├─ 读 ctx.webServer.port
    ├─ spawn Electron 子进程 (detached 进程组)
    └─ ctx.effect → SIGTERM→SIGKILL 清理整个进程组

Electron 子进程
├─ electron-main.cjs
│   ├─ dsh-app:// 自定义协议 → 代理到 http://127.0.0.1:<port>
│   │   (HTML 带 __DSH_BOOT__；assets/plugins 全部 200)
│   ├─ ipcMain.handle('dsh:fetch') → net.fetch 代理 API 调用
│   └─ WebSocket 中继 → 打开真实 WS (events.mux / events.host)，帧转发
└─ preload.cjs (contextIsolation: true)
    ├─ contextBridge 暴露 dshBridge (invoke/send/on 通道)
    └─ 主 world 覆盖 globalThis.fetch + WebSocket → 全部走 IPC
        (WebApiClient / createWebConnectionRpc 原封不动，传输被透明替换)
```

**设计要点**（都是调试中踩过的坑）：

| 决策 | 原因 |
|------|------|
| 协议 handler 直接返回 `net.fetch` 的 Response | `new Response(...)` 重包装会破坏流 → 全部 `ERR_FAILED` |
| 不透传 `request.headers`/`body`/`duplex` | 并发资源加载时 `net.fetch` 抛 `ERR_FAILED`；干净 GET 稳定 |
| 原地 `response.headers.set('Access-Control-Allow-Origin', '*')` | 页面 `<script type="module" crossorigin>` 走 CORS 模式，dsh 服务器无 CORS 头 |
| 主 world 覆盖脚本只能通过 `dshBridge` 调 IPC | `contextIsolation` 下主 world 没有 `ipcRenderer` |

## 安装与使用

### 从源码（本仓库内）

```sh
# 1. 构建
pnpm install
pnpm run build          # 自动包含本包（tsconfig.host.json 已引用）

# 2. 让 profile 能解析本包（开发期用符号链接，正式用 dsh plugin 命令）
ln -sfn "$(pwd)/packages/host/electron" ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-host-electron

# 3. 启动桌面版
DSH_DESKTOP=1 \
DSH_ELECTRON_PATH=/path/to/electron \    # 未设置时自动探测 require.resolve('electron')
pnpm dsh web --patch packages/host/electron/cordis.patch.yml
```

### 作为独立 npm 插件（dsh-plugin 标准方式）

```sh
dsh plugin --profile desktop add @deepseek-ai/dsh-host-electron
DSH_DESKTOP=1 dsh --profile desktop
```

或把 `@deepseek-ai/dsh-host-electron` 加入 profile 的
`dsh.profile.bundles`（`dsh-base` + `dsh-web-app` 之后）。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_DESKTOP` | - | 设为 `1` 才激活本插件（row `disabled` 条件） |
| `DSH_DESKTOP_DEV` | - | 设为 `1` 打开 DevTools 并输出详细代理/IPC 日志 |
| `DSH_ELECTRON_PATH` | 自动探测 | 显式指定 Electron 可执行文件路径 |

## 生命周期

- **启动**：`webServer` 绑定后插件才激活（`inject: [webServer]`），读到端口后
  spawn Electron。
- **退出**：`ctx.effect` 返回的 disposer 对进程组发 SIGTERM，6 秒后 SIGKILL
  兜底——与 `subprocess-local` 相同的清理模式，dsh 退出不留孤儿进程。

## 文件

```
packages/host/electron/
├── package.json            # dsh.bundle.patch + peerDeps (electron optional)
├── cordis.patch.yml        # insert electron-window row (DSH_DESKTOP 门控)
├── tsconfig.json
├── tsdown.config.ts        # ESM 打包 + 把 .cjs 复制进 lib/
└── src/
    ├── index.ts            # Cordis 插件：spawn + ctx.effect 生命周期
    ├── electron-main.cjs   # 协议代理 + IPC fetch + WS 中继 + 窗口
    └── preload.cjs         # contextBridge + 主 world fetch/WebSocket 覆盖
```

## 与 desktop/（路径② 外部壳）的关系

- `desktop/`：Electron 在 dsh **进程外**，spawn `dsh web` 子进程（HTTP 加载）。
- 本插件：dsh **进程内**原生化（`DSH_DESKTOP=1 dsh web`），IPC 承载 RPC。

两者互补；本插件是 "everything is a plugin" 的正式形态。
