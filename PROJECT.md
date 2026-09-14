# DSH Client 项目交接文档

> 给下一个开发者（人或 AI）的完整地图。读完本文即可按需修改，无需通读源码。
> 最后更新：2026-09-14 · 版本 0.1.0 · Electron 33 + React 18 + Vite 6

## 1. 项目是什么

**deepseek-harness（dsh）的桌面客户端**。dsh 是 DeepSeek 开源的 coding-agent 框架（客户端可在设置里指向任意部署位置，默认自动部署到客户端目录旁的 `harness/`），自带 Web UI 但耦合较深；本项目是一个独立的 Electron 客户端，通过 **stdio JSON-RPC（SDK 协议）** 驱动 dsh 的 `sdk` profile 子进程。

三个组成部分（以默认便携布局为例，harness 由客户端自动部署在 exe 旁）：
```
<客户端目录>\
├── DSH Client.exe 等         # Electron 运行时（release\win-unpacked 产物）
├── harness\                  # dsh 本体（官方仓库 + 我们的补丁，见 §6，自动部署）
├── workspace\                # 默认工作区
├── tools\                    # 便携工具链（git/pnpm/node，按需自动下载）
└── resources\app\            # 应用代码（dist + electron + patches，自更新热换）
```

## 2. 架构与数据流

```
┌─ 渲染进程 (React, src/) ─────────────────────────────┐
│  App.jsx（状态根）→ Sidebar / ChatPanel / StatsPanel  │
│        │ window.dsh.*（contextBridge）                │
├─ preload.mjs（安全桥，仅 IPC）────────────────────────┤
│        │ ipcRenderer.invoke / on                     │
├─ 主进程 (electron/) ─────────────────────────────────┤
│  loader.mjs（启动入口：回滚判定）                       │
│  main.mjs（窗口/IPC/自绘窗口按钮/自动重连/更新管线）      │
│  dsh-runtime.mjs ← 核心：spawn + JSON-RPC + 会话聚合   │
│  client-update.mjs（客户端 payload 自更新）             │
│  harness-update.mjs（harness 更新管线）                 │
│  toolchain.mjs（便携 git/pnpm/node 按需下载）           │
│        │ spawn: node <harness>/apps/cli/lib/bin.js    │
│               --profile sdk                           │
└─ harness runtime 子进程（打补丁的 SDK server）─────────┘
```

**JSON-RPC 协议**（newline-delimited）：
- 请求：`initialize`（cwd/provider/model/reasoningEffort/maxTokens）、`session/prompt`（sessionId + contentBlocks，未知 ID 惰性建会话）、`session/interrupt`、`session/approvalDecide`、`shutdown`
- 通知（server→client）：`session.event`（SessionEvent 流）、`session.status`（idle/running）、`session.stream`（LLM 流帧，**补丁新增**）、`session.approval` / `session.approval-withdrawn`（**补丁新增**）、`subagent.started/finished`

## 3. 文件职责速查

### electron/（主进程，改后需重启 Electron，不热更）

| 文件 | 职责 |
|---|---|
| `loader.mjs` | **打包版启动入口**（package.json main 指向它）：三标记状态机——`client-boot-attempt`（loader 启动时写 = 当前 commit）+ `client-boot-ok`（main ready-to-show 时写并清 attempt）。回滚判据 = **同 commit 尝试过且从未到达 ready**；import main.mjs 抛错 → 黑名单+回滚+relaunch。**必须保持极简** |
| `main.mjs` | 窗口创建（`titleBarStyle: 'hidden'` 无 overlay——**自绘 HTML 窗口按钮**，原生按钮在部分系统 uncontrollable 故弃用；winControl IPC + maximize 事件推送）；`handleRuntimeDeath`（ERR_MODULE_NOT_FOUND → 自动清构建戳+重装重建 harness；其余走 scheduleReconnect 指数退避重连×5）；`runHarnessPipeline`（ensureTools 自动装便携工具链；「重装并重建」清构建戳强制完整重建）；`runClientUpdate` / `silentSelfUpdate`（检测新版本 → 通知渲染层显示徽标，用户手动应用）；右键菜单注册（HKCU 注册表，命令带 `--workspace "%V"`）；渲染错误写 `userData/crash.log`；`appRoot` 解析（dev=项目目录，打包=exe 目录） |
| `dsh-runtime.mjs` | **核心类 DshRuntime**：spawn runtime（优先构建产物，回退 tsx；系统 node 缺失时用 Electron 自带 `ELECTRON_RUN_AS_NODE`）；JSON-RPC 收发；**会话聚合**（user 去重保留带图片预览的 echo、assistant/usage 累计、tool 卡片配对、todo last-write-wins、turn/end 错误转 note-error 红条——**userInterrupted 标记抑制用户打断产生的 abort 错误**）；`applyStreamChunk`（livePreview 实时思考/输出）；审批通知进 `session.approvals`；图片落盘 `attachments/` + `dshimg://` 协议引用；**会话持久化** `sessions.json`（stripBlocks 瘦身）；prompt 时 PLAN_PREFIX 注入（计划模式）；resume 失败回退新 ID；orderedSessions（置顶优先+时间倒序）；**maxTokens 按模型独立**（active?.maxTokens ?? config.maxTokens，不钳位）；**reasoningEffort 仅官方模型发送**（自定义端点参数兼容性各异，不发让端点用默认值） |
| `client-update.mjs` | 客户端 payload 自更新：`remoteHead`（ls-remote + 镜像回退）对比 `.installed-commit`；浅克隆发布仓库；校验 payload 结构；拷贝到 `resources/app-next`；**目录改名交换**（app→app-old，app-next→app，重试 3 次）；`mainChanged` 对比 electron/ 目录 md5 决定 reload vs relaunch |
| `harness-update.mjs` | `setToolchain`（接收便携工具链注入）；`harnessStatus`（HEAD/版本/补丁状态）；`fetchLatest`（**直连 GitHub 失败自动回退 ghfast.top 镜像**）；`updateHarness`（无仓库→clone --depth 1；有→checkout 补丁文件+stash+ff merge；然后 ensurePatched 幂等补丁→installAndBuild）；**build stamp**（`.dsh-build-stamp` 记 HEAD+补丁 md5，没变跳过 install/build） |
| `toolchain.mjs` | `ensureTools(appRoot, electronExe)`：系统缺 git → 下载 MinGit；缺 pnpm → 下载独立 pnpm.exe（npmmirror）；缺 node → **Electron 二进制硬链接为 tools/node.exe**（ELECTRON_RUN_AS_NODE 模式） |
| `preload.mjs` | contextBridge 白名单桥：全部 `dsh:*` IPC + `winControl` / `winIsMaximized` / `onMaximized` / `saveImage` / `onClientProgress` / `onHarnessProgress` / `configLocations` / `openConfigFolder` / `contextMenu*` 等 |

### src/（渲染进程，vite 热更）

| 文件 | 职责 |
|---|---|
| `App.jsx` | 状态根：snapshot/runtime 事件订阅；5s 状态对账；主题（**默认 light**，localStorage + settings.json 双写）；**自绘窗口按钮**（winControl IPC + maximize 状态同步 + 双击拖拽区切换）；**右栏开关**（statsOpen state，localStorage 持久，按钮 hover 显示在右栏左缘）；双更新管线进度行缓冲（App 级，弹窗关闭重开不丢日志）；updateBadge（检测到新版本时设置按钮红点） |
| `ChatPanel.jsx` | 最大组件：消息流渲染（Markdown-lite/工具卡片/图片 Lightbox+保存/**折叠**/**hover 显示 meta**/图标式复制按钮）；LiveThinking + live-output（实时输出渲染在外部）；**构建/计划模式**（按钮+Tab 切换，input-card 色条）；**发送按钮内联圆形**（foot-right，与工具行垂直居中）；work-dots（12 点扫描工作指示）；jump-bottom（滚动>240px 出现）；**对话内搜索**（Ctrl+F，find-bar 浮动，匹配高亮+逐条跳转）；**welcome 模式**（无对话时：隐藏标题栏、大标题+输入框居中、模型下拉移输入框左下角） |
| `Sidebar.jsx` | 品牌头部（鲸鱼+DeepSeek+HARNESS 标签）；新对话按钮（亮色渐变蓝 / 暗色发光蓝底）；会话列表（**按工作区分组**、可折叠、IconFolderOpen 蓝色打开态图标）；右键菜单（置顶/重命名/删除）；搜索（点击放大镜展开）；相对时间（刚刚→X 分钟前→HH:mm→M/D）；ChangePlanCard（`.dsh-changes/` 文档查看器）；底部大按钮（42px+红点徽标） |
| `StatsPanel.jsx` | 无对话时返回 null（右栏收起）；Token 卡 / 缓存命中率环形图 / TodoList / 待审操作卡 |
| `ModelDropdown.jsx` | 模型下拉：官方组 + 自定义端点组（增删表单：label/baseURL/apiKey/model/maxTokens） |
| `EffortControl.jsx` | 思考强度弹层（SVG 泡泡动效，档位改速度与颜色） |
| `SettingsModal.jsx` | **左侧分页**（通用/模型密钥/更新/系统）；更新页含客户端+harness 双管线 + 进度日志；密钥页 DeepSeek 官方 key/BaseURL |
| `WhaleMark.jsx` | DeepSeek 官方蓝鲸 logo（单 path，currentColor）；图标生成单一数据源 |
| `markdown.js` | 轻量 Markdown 渲染 + formatTokens |

### patches/

`sdk-server.patch`：对 harness `packages/sdk/server/` 的全部改动（resume 回退 / session/interrupt / session.stream / 审批桥 / 变更计划协议）。

### scripts/

`make-icon.mjs`（鲸鱼 → ICO）、`publish-payload.mjs`（npm run publish：构建 + 内容哈希幂等 + main + client 双分支推送）、`package-dist.mjs`（npm run dist：打包 zip）。

## 4. 关键设计决策与历史教训

1. **凭证优先级**：customModels[activeCustom] 的 baseURL/apiKey > config.dsApiKey/dsBaseUrl > .env 文件 > 进程环境。
2. **provider 路由**：所有模型（含自定义端点）一律走 `deepseek-official`；客户端标识存 `activeCustom`，**绝不**把 `custom-*` 传给 initialize（会 no adapter registered 崩溃）。
3. **maxTokens 按模型独立**：不钳位，由用户在模型配置里自行设置（火山系模型上限 131072）。
4. **reasoningEffort 仅官方模型发送**：自定义端点参数兼容性各异（有的拒绝 `off`），不发让端点用默认值。
5. **多模态**：未编目模型按 text-only 处理。图片模型需登记 `~/.dsh/settings.yaml` 的 `llm-deepseek.models`（含 `inputModalities: [text, image]`）。
6. **会话 ID 跨重启**：同 ID prompt → 补丁走 resume（磁盘日志恢复上下文）；resume 失败 → 客户端 fallback 换新 ID。
7. **图片**：发送时落盘 `userData/attachments/`，渲染走 `dshimg://` 自定义协议（带路径穿越防护）。CSP 已放行。
8. **缓存教训**：**vite 缓存会掩盖真实产物**——改完必须 `rm -rf node_modules/.vite dist` 再构建，且用打包版（非 dev）验证。
9. **Windows 环境坑**：pnpm install 与 build 并发互相打死；Defender 删 rcedit 修改中的 exe；cmd 错误输出是 GBK；taskkill /F 杀 Electron 会留孤儿 runtime 占写句柄（启动时清杀）。
10. **原生窗口按钮不可控**：`titleBarOverlay` / `nativeTheme.themeSource` 在部分系统上无法控制按钮颜色（始终黑色）——**最终方案是自绘 HTML 按钮**（`titleBarStyle: 'hidden'` 无 overlay + winControl IPC）。勿回退。
11. **用户打断 ≠ 错误**：interrupt 后 LLM 层抛 abort → turn/end 带 error——`userInterrupted` 标记抑制（否则显示为红色错误行）。
12. **构建跳过**：harness 更新的 build stamp 没变则跳过 install/build。
13. **自更新幂等**：payload 内容哈希没变不推送（防 GitHub 噪音）。
14. **setup.bat 必须 GBK + CRLF**：cmd 解析器对 UTF-8 中文和 LF-only 都会错乱。
15. **loader.mjs 路径计算陷阱**：import.meta.url 算出的是 electron/ 子目录，app 目录 = dirname(electron/)。
16. **滚动条 CSS**：`:root::-webkit-scrollbar-thumb` 只作用于根元素——必须用 CSS 变量（`--scrollbar-thumb`）+ 全局选择器。
17. **Paper airplane 图标偏移**：`.send-btn svg { translate(-2px, 1px) }` 校准纸飞机视觉重心；StopIcon 需 `transform: none` 重置。

## 5. IPC 通道总表

`dsh:` getState / newSession / selectSession / deleteSession / renameSession / togglePinSession / sendPrompt(text, images, mode) / interrupt / decideApproval / restart / updateConfig / addCustomModel / removeCustomModel / pickWorkspace / saveImage / listChangePlans / checkHarnessPatches / harnessStatus / harnessUpdate / applyHarnessPatches / clientStatus / clientUpdate / resetUpdateTasks / configLocations / openConfigFolder / contextMenuStatus / registerContextMenu / unregisterContextMenu / winControl / winIsMaximized

推送：`dsh:snapshot` / `dsh:runtime` / `dsh:harnessProgress` / `dsh:clientProgress` / `dsh:win-maximized`

## 6. 配置与数据文件

| 文件 | 内容 |
|---|---|
| `%APPDATA%\dsh-client\settings.json` | config：workspace/harnessDir/harnessRepo/harnessAutoUpdate/clientUpdateRepo/clientAutoUpdate/provider/model/activeCustom/reasoningEffort/maxTokens/customModels[]/dsApiKey/dsBaseUrl/theme |
| `%APPDATA%\dsh-client\sessions.json` | 会话快照（消息/usage/todos/pinned/workspace） |
| `%APPDATA%\dsh-client\attachments\` | 图片附件 |
| `%APPDATA%\dsh-client\crash.log` | 崩溃日志 |
| `~/.dsh/settings.yaml` | harness 全局：llm-deepseek 模型目录 |
| `<harness>/.dsh-build-stamp` | 构建指纹 |

## 7. 常见修改场景

| 想改什么 | 去哪 |
|---|---|
| 界面样式 | `src/app.css`（CSS 变量在 :root 与 [data-theme="light"]） |
| 聊天行为 | `src/components/ChatPanel.jsx` |
| 侧栏/会话 | `src/components/Sidebar.jsx` |
| 应用图标 | 改 `WhaleMark.jsx` → `node scripts/make-icon.mjs` → `npm run dist` |
| RPC 协议 | harness `packages/sdk/server/src/server.ts` → 改后重建 + 刷新补丁 |
| 更新管线 | `electron/client-update.mjs` / `electron/harness-update.mjs` |

## 8. 命令

```bash
npm run dev          # 开发（热更）
npm run publish      # 发布 payload（客户端自更新通道）
npm run dist         # 打 zip 分发版
node scripts/make-icon.mjs  # 重新生成应用图标
```

## 9. 已知限制

- 消息列表无虚拟化（几千条会卡）
- 设置里改 harnessRepo 后需先「保存」再点「检查并更新」
- 亮色主题下个别彩色元素未逐个适配
