# DSH Client 项目交接文档

> 给下一个开发者（人或 AI）的完整地图。读完本文即可按需修改，无需通读源码。
> 最后更新：2026-09-14 · 版本 0.1.0 · Electron 33 + React 18 + Vite 6

## 1. 项目是什么

**deepseek-harness（dsh）的桌面客户端**。dsh 是 DeepSeek 开源的 coding-agent 框架，自带 Web UI 但耦合较深；本项目是独立的 Electron 客户端，通过 **stdio JSON-RPC（SDK 协议）** 驱动 dsh 的 `sdk` profile 子进程。harness 默认自动部署到 exe 旁的 `harness/`，设置里可指向任意位置。

```
<客户端目录>\
├── DSH Client.exe 等         # Electron 运行时
├── harness\                  # dsh 本体（官方仓库 + 客户端补丁，自动部署）
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
│  main.mjs（窗口/IPC/重连/更新管线/强制终止）             │
│  dsh-runtime.mjs ← 核心：spawn + JSON-RPC + 会话聚合   │
│  client-update.mjs（payload 自更新）                   │
│  harness-update.mjs（harness 更新管线，本地优先）        │
│  toolchain.mjs（便携工具链按需下载）                    │
│  proc-registry.mjs（更新子进程/下载注册表，按管线打标）   │
│        │ spawn: node <harness>/apps/cli/lib/bin.js    │
│               --profile sdk                           │
└─ harness runtime 子进程（打补丁的 SDK server）─────────┘
```

**JSON-RPC 协议**（newline-delimited）：
- 请求：`initialize`（cwd/provider/model/reasoningEffort/maxTokens）、`session/prompt`（未知 ID 惰性建会话）、`session/interrupt`、`session/approvalDecide`、`shutdown`
- 通知（server→client）：`session.event` / `session.status` / `session.stream`（**补丁新增**）/ `session.approval` / `session.approval-withdrawn`（**补丁新增**）/ `subagent.started/finished`

## 3. 文件职责速查

### electron/（主进程，改后需重启 Electron，不热更）

| 文件 | 职责 |
|---|---|
| `loader.mjs` | **打包版启动入口**（package.json main）：三标记回滚状态机——`client-boot-attempt` / `client-boot-ok`；回滚判据 = 同 commit 尝试过且从未 ready；import main.mjs 抛错 → 黑名单+回滚+relaunch。**必须保持极简** |
| `main.mjs` | 窗口与 IPC 中枢：自绘窗口按钮（`titleBarStyle: 'hidden'` 无 overlay + winControl IPC）；**单实例锁**（第二实例退出并聚焦，`--workspace` 启动转发给运行实例处理）；**settings.json 防护链**（原子写 tmp+rename、.bak 轮换 / .bad 隔离坏文件、宽松解析恢复手改的尾逗号/BOM、所有写点先吸收磁盘最新配置——freshDiskConfig）；`handleRuntimeDeath`（ERR_MODULE_NOT_FOUND → 清构建戳自动重装重建，一次性守卫、手动重启/重装会重置；其余指数退避重连×5）；`runHarnessPipeline`（**仅手动触发**，无静默自动更新；工具仅 `resolveTools` 解析、不安装）；`runClientUpdate` / `silentSelfUpdate`（仅检测新版本 → 设置按钮徽标，用户手动应用）；`dsh:installTool` / `dsh:toolchainStatus`（工具页）；`dsh:subagentSession` / `dsh:deleteSubagent` / `dsh:markSubagentViewed`（子代理查看器）；`dsh:resetUpdateTasks(target)` 按管线强制终止；右键菜单注册（HKCU，`--workspace "%V"`；冷启动进新工作区也会 focusWorkspaceSession）；`appRoot` 解析（dev=项目目录，打包=exe 目录） |
| `dsh-runtime.mjs` | **核心类 DshRuntime**：spawn runtime（优先构建产物，回退 tsx；系统缺 node 用 `ELECTRON_RUN_AS_NODE`）；**`ensureChatCompletionsProtocol`**（harness ≥0.1.6 起 llm-deepseek 默认改走 Anthropic 风格 Messages 协议——`/v1/messages` + `x-api-key`，自定义 OpenAI 兼容网关必 401；启动前自动把 `llm-deepseek.protocol: chat-completions` 写入 ~/.dsh/settings.yaml 用户设置层压制默认值，用户显式配置过则不动）；JSON-RPC 收发；**会话聚合**（echo 去重保留图片预览、usage 累计、tool 配对、**userInterrupted 抑制打断 abort 红条**）；`applyStreamChunk` 实时预览；审批队列；图片落盘 + `dshimg://` 协议；`sessions.json` 持久化（stripBlocks 瘦身：文本 50000/工具结果 5000/参数 8000 字符；**逐消息 usage 持久化**——数据层已留，明细 UI 暂缓）；`errors.log` 生成失败日志（时间/会话/**生效端点与 key 指纹**）；resume 失败回退新 ID；`updateConfig` 时为空 workspace 的旧会话回填烙印；`focusWorkspaceSession`（切换工作区后聚焦/新建该工作区会话，复用未使用的空会话）；**子代理系统**：`subagent.started/finished` 给子会话打标（subagent/parentId/subagentStatus/subagentIndex/viewed 全持久化，标号粘性防重拉顶号，遗留数据按时间回填），`orderedSessions` 过滤隐藏不出侧栏，snapshot 附 `subagents[]` 列表，`deleteSubagent`（防误删：运行中被删的子代理后续事件以隐藏身份+原标号重建，finished 的删除即生效），`markSubagentViewed` 未读标记 |
| `client-update.mjs` | payload 自更新：`remoteHead`（ls-remote + 镜像回退）对比 `.installed-commit` → 浅克隆 → 校验结构 → `resources/app-next` → **目录改名交换**（重试 3 次）；electron/ 目录 md5 对比决定 reload vs relaunch |
| `harness-update.mjs` | 更新管线（**本地优先**）：有仓库先 ensurePatched + installAndBuild（build stamp 没变秒过）确保本地可用，再 `probeNetwork`（curl 探 npm 镜像与 GitHub，走代理 env）+ fetch（直连 → ghfast.top 镜像），**网络不通优雅降级保留本地构建**；无仓库 → clone --depth 1（需网络，失败给指引）。install 显式 `--registry=npmmirror` + `runStreaming`（流式进度限频 1.5s/行 + 超时 `taskkill /T` 树杀，15 分钟） |
| `toolchain.mjs` | **工具仅由设置→工具页安装**：`installTool(name)`（单飞锁，进度打 'tools' 标）；`resolveTools(appRoot)` 供更新管线调用——只解析不安装（系统命令优先，否则用 tools/ 下已装副本，完全缺失抛错指引到工具页），在装任务进行中会等待其完成；下载带 **30s 停滞 / 5min 总量熔断**（代理黑洞快速失败）；`toolchainStatus` 返回每工具 `{source, version, path}` |
| `proc-registry.mjs` | 更新管线子进程与下载的注册表（按管线打标）；`killAll(tag)` 树杀该管线的子进程 + 中止其下载——强制终止互不误伤 |
| `preload.mjs` | contextBridge 白名单桥：全部 `dsh:*` IPC + `winControl` / `onMaximized` / `saveImage` / 进度订阅等 |

### src/（渲染进程，vite 热更）

| 文件 | 职责 |
|---|---|
| `App.jsx` | 状态根：snapshot/runtime 订阅；主题（默认 light，localStorage+settings.json 双写）；自绘窗口按钮；右栏开关（localStorage 持久）；三组进度行缓冲（harness/client/tools，弹窗重开不丢、点击对应按钮即清空）；updateBadge 红点 |
| `ChatPanel.jsx` | 最大组件：消息流（Markdown-lite/工具卡片/图片 Lightbox/**折叠**/**粘性 meta**——最后悬停气泡的时间/复制保持显示，切气泡才换，`meta-showing` 类驱动；无文本消息不渲染 meta 防空行）；`groupForDisplay`（工具/启停消息按 showToolActivity 开关隐藏或收成气泡左上角**小药丸标记**，点击展开完整卡片；`ActivityChips`）；**渲染防空白**（无 reasoning/文本的 assistant 行整行跳过、空代码围栏不产出空 pre、firstText 合并全部文本块——工具调用前后文本不丢）；折叠状态记忆 localStorage（键 = 会话ID+时间+**前 200 字符指纹**）；LiveThinking + live-output；构建/计划模式（Tab 切换）；Ctrl+F 对话内搜索；welcome 模式（dropUp 向上弹）；导出 `Message` 供子代理查看器复用 |
| `Sidebar.jsx` | 会话列表（**按工作区分组**、折叠记忆 localStorage、置顶/重命名/删除右键菜单）；搜索；相对时间；ChangePlanCard（`.dsh-changes/` 查看器）；底部设置按钮（红点徽标） |
| `StatsPanel.jsx` | Token 卡 / 缓存命中率环形图 / **任务列表卡**（「任务列表/子代理列表」药丸切换；子代理页：三列状态统计 黄=工作中/绿=待命/红=已关闭 + 数字标号排序的条目列表、待命未读红点、右键删除）/ 待审操作卡（无对话返回 null） |
| `SubagentModal.jsx` | 子代理只读查看器（宽版 `.modal.subagent-modal`——双类选择器防被 `.modal` 基类覆盖）：完整交互展示，中转消息以「父代理」徽标气泡显示（剥掉 "Agent xxx sent a message:" 包装行，`showInjected`），系统上下文样板仍隐藏；运行中实时刷新 |
| `ModelDropdown.jsx` | 模型下拉：官方组 + 自定义端点（label/baseURL/apiKey/model/maxTokens 增删） |
| `SettingsModal.jsx` | 分页（通用/模型密钥/**工具**/更新/**调试**/系统）；工具页三卡片（git/pnpm/node 来源/版本/路径 + 缺失时单装/重建 shim，进度日志+强停，**点击即清空各自日志**）；更新页双管线 + 进度日志 + **按管线强制终止**；**调试页**：「显示工具与子代理启停消息」开关（showToolActivity，即点即存，默认关——对话纯净模式）；harness 源码仓库**只读展示**（自定义需手改 settings.json）；系统页配置文件双路径（客户端 settings.json + harness 多模态目录 ~/.dsh/settings.yaml，各带打开按钮）；harness 无自动更新 |
| 其余 | `EffortControl`（思考强度弹层）/ `WhaleMark`（蓝鲸 logo，图标单一数据源）/ `markdown.js`（轻量渲染） |

### patches/ 与 scripts/

- `patches/sdk-server.patch`：harness `packages/sdk/server/` 全部改动（resume 回退 / interrupt / stream / 审批桥 / 变更计划协议）
- `scripts/make-icon.mjs`（鲸鱼 → ICO）、`publish-payload.mjs`（**main 分支 = 源码+payload，即已装客户端的自更新通道**；client 分支 = 首装引导）、`package-dist.mjs`（打 zip）

## 4. 关键设计决策与教训

**协议与凭证**
1. 凭证优先级：customModels[activeCustom] 的 baseURL/apiKey > config.dsApiKey/dsBaseUrl > .env > 进程环境
2. provider 路由：一律走 `deepseek-official`，**绝不**把 `custom-*` 传给 initialize（no adapter registered 崩溃）
3. maxTokens 按模型独立不钳位；reasoningEffort 仅官方模型发送（自定义端点兼容性各异）
4. 会话 ID 跨重启：同 ID prompt 走 resume（补丁恢复上下文），失败回退新 ID
5. 多模态需登记 `~/.dsh/settings.yaml` 的 `llm-deepseek.models`（含 `inputModalities`）

**更新与构建**
6. **pnpm 默认源 registry.npmjs.org 国内不通**——install 必须显式 `--registry=https://registry.npmmirror.com`
7. **exec 超时只杀 shell，pnpm 孙进程成孤儿继续锁 store**——长命令用 runStreaming（流式进度 + `taskkill /T` 树杀）
8. harness 更新本地优先：先保证本地可用再查更新；网络不通降级保留本地构建（首次部署除外）
9. build stamp（HEAD+补丁 md5）没变跳过 install/build；payload 内容哈希没变不推送（防 GitHub 噪音）
10. 工具下载熔断：30s 无数据 / 超 5min 中止——代理黑洞快速失败而非永久挂起

**配置持久化**
11. **settings.json 重置事故链**：手改带尾逗号/BOM → 严格 JSON.parse 抛错 → 静默按首装处理 → 默认值整体写回。防线：宽松解析恢复手改 + .bak/.bad 兜底 + 原子写 + 单实例锁 + 写前吸收磁盘（freshDiskConfig）——渲染层刷新缓存无用，写盘的永远是主进程
12. **vite 缓存掩盖真实产物**：改完必须 `rm -rf node_modules/.vite dist` 再构建，且用打包版验证

**Windows 与 UI 坑**
13. setup.bat 必须 GBK+CRLF；cmd 错误输出是 GBK；Defender 删 rcedit 修改中的 exe；taskkill /F 杀 Electron 留孤儿 runtime（启动时清杀）；**强杀后立即重启会撞单实例锁（error 32），需等旧进程退净**
14. 原生窗口按钮部分系统不可控——**自绘 HTML 按钮**（hidden 无 overlay），勿回退
15. 用户打断 ≠ 错误：interrupt 后 abort 由 `userInterrupted` 标记抑制，否则显示红条
16. loader.mjs 的 import.meta.url 在 electron/ 子目录，app 目录 = dirname(electron/)
17. `:root::-webkit-scrollbar-thumb` 只作用根元素——用 CSS 变量 + 全局选择器
18. 持久化 stripBlocks 会截断长文本——内容指纹只取前 200 字符保证重启前后一致
19. **CSS 类名撞车**：新组件复用已有类名（如设置页 `.tool-card` 撞聊天工具卡）会把样式打到别处——新组件一律独立前缀命名
20. **可滚动 flex 列表的子项必须 `flex-shrink: 0`**：带 `overflow:hidden` 的子项最小高度变 0，列表溢出时被压成空白条（工具卡空白框事故根因）
21. **固定定位的透明覆盖条会吃掉滚动条拖拽**（stats-edge 盖住聊天滚动条）——容器 `pointer-events:none`，仅按钮 `auto`
22. **同优先级 CSS 后者胜**：`.subagent-modal` 写在 `.modal` 基类之前，宽度被基类 440px 压死——覆盖基类用双类选择器 `.modal.subagent-modal`
23. **harness 0.1.6 起 llm-deepseek 默认走 Messages 协议**（`/v1/messages` + `x-api-key` 头）——自定义 OpenAI 兼容网关只认 `/chat/completions` + Bearer，必 401；客户端已在启动时自动写 `protocol: chat-completions` 压制（~/.dsh/settings.yaml 用户设置层 > 配置默认）。**升级 harness 后的"突然 401"先查协议**，错误文案 "Messages request failed" 即此协议

## 5. IPC 通道总表

`dsh:` getState / newSession / selectSession / deleteSession / renameSession / togglePinSession / sendPrompt(text, images, mode) / interrupt / decideApproval / restart / updateConfig / addCustomModel / removeCustomModel / pickWorkspace / saveImage / listChangePlans / checkHarnessPatches / harnessStatus / harnessUpdate / applyHarnessPatches / toolchainStatus / installTool / subagentSession / deleteSubagent / markSubagentViewed / clientStatus / clientUpdate / resetUpdateTasks(target: client/harness/tools) / configLocations / openConfigFolder / contextMenuStatus / registerContextMenu / unregisterContextMenu / winControl / winIsMaximized

推送：`dsh:snapshot` / `dsh:runtime` / `dsh:harnessProgress` / `dsh:clientProgress` / `dsh:toolsProgress` / `dsh:win-maximized`

## 6. 配置与数据文件

| 位置 | 内容 |
|---|---|
| `%APPDATA%\dsh-client\settings.json` | config：workspace / harnessDir / harnessRepo（设置页只读）/ clientUpdateRepo / clientAutoUpdate / provider / model / activeCustom / reasoningEffort / maxTokens / customModels[] / dsApiKey / dsBaseUrl / theme / **showToolActivity**（默认关：对话中隐藏工具与子代理启停消息，调试页开关）（harnessAutoUpdate 已废弃，更新仅手动）。**原子写**；`.bak` 上一版轮换 / `.bad` 坏文件隔离；支持手改（尾逗号/BOM 宽松恢复） |
| `%APPDATA%\dsh-client\sessions.json` | 会话快照（消息/usage/todos/pinned/workspace） |
| `%APPDATA%\dsh-client\attachments\` | 图片附件；`crash.log` 崩溃日志；`errors.log` **生成失败日志**（每次 LLM 请求失败记录时间/会话/**生效端点与凭证状态**——区分官方无 key 还是网关坏 key；256KB 轮换至 .old，系统页可查路径） |
| `~/.dsh/settings.yaml` | harness 全局：llm-deepseek 模型目录 |
| `<harness>/.dsh-build-stamp` | 构建指纹（HEAD+补丁 md5） |
| 渲染层 localStorage | `dsh-collapsed-msgs`（折叠记忆，≤400 条）/ `dsh-ws-collapsed`（分组折叠）/ 主题、右栏开关 |

## 7. 常见修改场景

| 想改什么 | 去哪 |
|---|---|
| 界面样式 | `src/app.css`（CSS 变量在 :root 与 [data-theme="light"]） |
| 聊天行为 | `src/components/ChatPanel.jsx` |
| 侧栏/会话 | `src/components/Sidebar.jsx` |
| 应用图标 | 改 `WhaleMark.jsx` → `node scripts/make-icon.mjs` → `npm run dist` |
| RPC 协议 | harness `packages/sdk/server/src/server.ts` → 重建 + 刷新补丁 |
| 更新管线 | `electron/client-update.mjs` / `electron/harness-update.mjs` / `electron/proc-registry.mjs` |

## 8. 命令

```bash
npm run dev          # 开发（热更）
npm run publish      # 发布 payload（main 分支 = 客户端自更新通道）
npm run dist         # 打 zip 分发版
node scripts/make-icon.mjs  # 重新生成应用图标
```

## 9. 已知限制

- 消息列表无虚拟化（几千条会卡）
- 亮色主题下个别彩色元素未逐个适配
