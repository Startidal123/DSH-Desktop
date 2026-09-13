# DSH Client 项目交接文档

> 给下一个开发者（人或 AI）的完整地图。读完本文即可按需修改，无需通读源码。
> 最后更新：2026-09-12 · 版本 0.1.0 · Electron 33 + React 18 + Vite 6

## 1. 项目是什么

**deepseek-harness（dsh）的桌面客户端**。dsh 是 DeepSeek 开源的 coding-agent 框架（客户端可在设置里指向任意部署位置，默认自动部署到客户端目录旁的 `harness/`），自带 Web UI 但耦合较深；本项目是一个独立的 Electron 三列客户端，通过 **stdio JSON-RPC（SDK 协议）** 驱动 dsh 的 `sdk` profile 子进程。

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
│  main.mjs（窗口/IPC/右键菜单/自动重连/主题桥）          │
│  dsh-runtime.mjs ← 核心：spawn + JSON-RPC + 会话聚合   │
│  harness-update.mjs（git/pnpm 流水线）                 │
│        │ spawn: node <harness>/apps/cli/lib/bin.js    │
│               --profile sdk                           │
└─ harness runtime 子进程（打补丁的 SDK server）─────────┘
```

**JSON-RPC 协议**（newline-delimited，详见 harness 的 `packages/sdk/protocol/src/types.ts`）：
- 请求：`initialize`（cwd/provider/model/reasoningEffort/maxTokens）、`session/prompt`（sessionId + contentBlocks，未知 ID 惰性建会话）、`session/interrupt`、`session/approvalDecide`、`shutdown`
- 通知（server→client）：`session.event`（SessionEvent 流）、`session.status`（idle/running）、`session.stream`（LLM 流帧，**补丁新增**）、`session.approval` / `session.approval-withdrawn`（**补丁新增**）、`subagent.started/finished`

## 3. 文件职责速查

### electron/（主进程，改后需重启 Electron，不热更）

| 文件 | 职责 |
|---|---|
| `main.mjs` | 窗口创建（暗色 titleBarOverlay + 主题联动 `dsh:setNativeTheme`）；全部 `ipcMain.handle`；`killOrphanRuntimes`（启动清残留防写句柄占用）；`scheduleReconnect`（崩溃指数退避重连×5）；`runHarnessPipeline`（更新流水线入口，ensureTools 自动装便携工具链）；`runClientUpdate` / `silentSelfUpdate`（客户端自更新：空闲守卫 → 先客户端后 harness；界面改动 reload / 主进程改动 relaunch）；右键菜单注册（HKCU 注册表 `Directory\shell\DSHClient`，命令带 `--workspace "%V"`）；渲染错误写 `userData/crash.log`；窗口 ready-to-show 写 `client-boot-ok`（loader 回滚判据）；`appRoot` 解析（dev=项目目录，打包=exe 目录，harness/workspace 默认相对它） |
| `loader.mjs` | **打包版启动入口**（package.json main 指向它）：三标记状态机——`client-boot-attempt`（loader 启动时写 = 当前 commit）+ `client-boot-ok`（main ready-to-show 时写并清 attempt）。回滚判据 = **同 commit 尝试过且从未到达 ready**（attempt 匹配但无成功标记），而非"标记不匹配"——单纯的不匹配只是新更新首启的正常状态（历史 bug：旧逻辑按不匹配回滚，导致每次主进程更新被误回滚形成翻转循环）；import main.mjs 抛错 → 黑名单+回滚+relaunch。**此文件必须保持极简，永不参与自更新内容变更** |
| `dsh-runtime.mjs` | **核心类 DshRuntime**：spawn runtime（优先构建产物 `lib/bin.js`，回退 tsx 源码；系统 node 缺失时用 `process.execPath + ELECTRON_RUN_AS_NODE`）；JSON-RPC 收发；**会话聚合**（applyEvent：user 去重保留带图片预览的 echo、assistant/usage 累计、tool 卡片配对、todo last-write-wins、turn/end 错误转 note-error 红条）；`applyStreamChunk`（livePreview 实时思考/输出）；审批通知进 `session.approvals`；图片落盘 `attachments/` + `dshimg://` 协议引用；**会话持久化** `sessions.json`（stripBlocks 瘦身：文本截断、图片只留 path 引用）；prompt 时 PLAN_PREFIX 注入（计划模式）；resume 失败回退新 ID；orderedSessions（置顶优先+时间倒序） |
| `harness-update.mjs` | `setToolchain`（接收便携工具链注入，run() 内做 git/pnpm 命令前缀替换+env 合并）；`harnessStatus`（HEAD/版本/补丁状态）；`fetchLatest`（**直连 GitHub 失败自动回退 ghfast.top 镜像**）；`updateHarness`（无仓库→clone --depth 1；有→checkout 补丁文件+stash+ff merge；然后 ensurePatched 幂等补丁→installAndBuild）；**build stamp**（`.dsh-build-stamp` 记 HEAD+补丁 md5，没变跳过 install/build） |
| `toolchain.mjs` | `ensureTools(appRoot, electronExe)`：系统缺 git → 下载 MinGit 到 `tools/git`（GitHub→ghfast 回退）；缺 pnpm → 下载独立 pnpm.exe（npmmirror）；缺 node → **Electron 二进制硬链接为 tools/node.exe**（ELECTRON_RUN_AS_NODE 模式，PATH 注入给 pnpm run scripts）。`toolchainStatus` 供设置页显示来源 |
| `client-update.mjs` | 客户端 payload 自更新：`remoteHead`（ls-remote + 镜像回退）对比 `.installed-commit`；浅克隆发布仓库；校验 payload 结构（缺 dist/electron/patches/main.mjs 即拒绝）；拷贝到 `resources/app-next`；**目录改名交换**（app→app-old，app-next→app，重试 3 次防占用）；`mainChanged` 对比 electron/ 目录 md5 决定 reload vs relaunch |
| `preload.mjs` | contextBridge 白名单桥，与 main 的 IPC 一一对应（`dsh:*` 命名空间） |

### src/（渲染进程，vite 热更）

| 文件 | 职责 |
|---|---|
| `App.jsx` | 状态根：snapshot/runtime 事件订阅；5s 状态对账（防 HMR 后徽章卡死）；主题（localStorage + 原生按钮联动）；switchModel（非 DeepSeek 官方模型自动关思考并记忆原值）；计划闭环回调 |
| `ChatPanel.jsx` | 最大组件：消息流渲染（Markdown-lite/工具卡片/图片 Lightbox/复制按钮）；LiveThinking（思考折叠卡自动沉底）+ live-output（输出实时渲染在外部）；**构建/计划模式**（按钮+Tab 切换，input-card 色条 class）；composer（发送=打断中则先 interrupt；防连击 800ms）；work-dots（12 点扫描工作指示）；jump-bottom（滚动>240px 出现，autoScroll 距底 40px 内才跟随）；计划提示条（plan-ready → applyPlan 组合 EXECUTE PLAN 消息）。**状态区**：标题下 meta-line（小圆点+就绪/工作中/启动中/未连接 · 消息数 · 当前模型名，无边框轻量行，类名 meta-dot/meta-state）；欢迎页为 WhaleMark 大图标 |
| `Sidebar.jsx` | 会话列表（置顶 PinIcon/重命名内联/删除）；搜索（点击放大镜展开，min-width 120/max 168）；ChangePlanCard（15s 轮询 `.dsh-changes/`，点击弹文档查看器）；session-top-spacer 把标题推到中部（max 300px，列表多时收缩） |
| `StatsPanel.jsx` | Token 卡（billed input = input+cacheRead+cacheWrite）、缓存命中率环形图、TodoList、**待审操作卡**（批准/拒绝 → decideApproval） |
| `ModelDropdown.jsx` | 模型下拉：官方组（`src/models.js` 目录）+ 自定义端点组（增删表单：label/baseURL/apiKey/model/maxTokens）+ active 判断（`config.activeCustom`） |
| `EffortControl.jsx` | 思考强度 ⚡ 弹层：SVG 泡泡（2 泳道×6，等间隔相位+独立速度±18%+双层浮动 drift/bob），档位改速度（4.6/2.4/1.7s）与颜色（蓝/绿/红），密度三档统一（用户要求） |
| `SettingsModal.jsx` | 工作区/harness 路径（默认值提示）；Harness 更新区块（repo 地址、自动更新开关、状态行、检查并更新/仅应用补丁、进度日志）；配置文件路径+打开按钮；标题右侧 ContextMenuButton（右键菜单注册，下方一行小字说明） |
| `markdown.js` | 轻量 Markdown 渲染（code/bold/link/标题/列表）+ formatTokens + renderMarkdown |
| `WhaleMark.jsx` | DeepSeek 官方蓝鲸 logo（单 path，currentColor，viewBox 0 0 27 22）。**单一数据源**：`scripts/make-icon.mjs` 用正则从这里提取 path 生成 exe 图标，改鲸鱼只需改此文件 |

### patches/

`sdk-server.patch`：对 harness `packages/sdk/server/` 的全部改动（**git diff 格式，上游更新后重应用**）。五项内容：
1. **resume 回退**：createSession 遇 "already exists" → `ctx.agents.resume`（重启续聊保留上下文）
2. **session/interrupt**：调 `agent.cancel({kind:'user'})`
3. **session.stream**：agent.ctx 订阅 `agent/assistant-stream` 转发流帧
4. **审批桥**：`approval/request` answerer → `session.approval` 通知 + `session/approvalDecide` 方法（挂起工具调用等人工决策）
5. **变更计划协议**：systemPrompt.section 注入（大改动前模型写 `.dsh-changes/CP-*.md`）

`apply-patches.sh`：重应用脚本（先 git apply --check，冲突则 --reject 留人工）。
**改 harness server 后**：`git diff packages/sdk/server/ > ../dsh-client/patches/sdk-server.patch` 刷新资产。

### scripts/

`make-icon.mjs`：从 WhaleMark.jsx 提取鲸鱼 path → sharp 渲染 16~256px PNG → png-to-ico 打包 `build/icon.ico`。

`publish-payload.mjs`（`npm run publish`）：干净构建 dist → 根目录写 version.json → git add -A + commit + push（发布仓库 = 源码仓库同体，main 分支即发布通道；首次 `--repo <url>` 设 remote）。客户端自更新从此拉取。

`package-dist.mjs`：打包流水线五步（**不能用 electron-builder 的 portable target**——Defender 会删 rcedit 修改中的 exe）：① vite build + version.json（**asar:false，产物为 resources/app/ 明文目录**——自更新热换的前提）② `electron-builder --win dir`（预期在 rename 步失败）③ 手工补 exe+运行时文件+payload 版本戳 ④ **rcedit 嵌入鲸鱼图标**（rcedit-x64.exe 从 winCodeSign 缓存解出，7zip-bin 解压零新依赖；被安全软件拦截时自动回退无图标 exe）⑤ Compress-Archive 出 zip。release 被占用时明确提示先关客户端。

## 客户端自更新体系（单仓库 DSH-Desktop）

发布仓库（默认 `https://github.com/Startidal123/DSH-Desktop`，DEFAULT_CONFIG.clientUpdateRepo）与源码仓库同体：**main 分支即发布通道，无需分支区分**——publish 是手动阀门，dev 模式读本地源码不碰仓库。

- **检查**：`git ls-remote <repo> main` vs 安装时写入的 `.installed-commit`；CHANNEL 常量默认 main（预留 beta 通道，改一处即可）
- **生效**：electron/ 有差异（**行尾规范化后对比**——CRLF 污染的克隆不得误判为主进程变更）→ `app.relaunch()`；仅 dist 变 → `win.webContents.reload()` 秒级
- **安全**：payload 结构校验拒坏包；交换用改名而非删除（失败自动放弃，运行中的安装无损）；`app-old` 保留至新 payload 首次健康启动；boot 状态机（attempt/ok 双标记）见 §3 loader.mjs——**切勿改回"boot-ok 不匹配即回滚"**（历史 bug：新更新首启必然不匹配 → 误回滚 → 翻转循环）
- **回滚**：main.mjs 加载失败 → loader 写 `client-bad-commit` 黑名单（记录坏 commit）→ 回滚 app-old → relaunch；**黑名单防死循环**：静默更新跳过黑名单 commit（仓库持续坏版本时不会每 8 秒闪一次），手动"检查更新"清除黑名单强制重试
- **配置**：`clientUpdateRepo` / `clientAutoUpdate`（默认 true）；dev 模式（!isPackaged）自动跳过
- **payload 组成**：dist/ + electron/ + patches/ + package.json + version.json + README.md（PAYLOAD_PARTS/PAYLOAD_FILES）
- **发布仓库 .gitattributes = `* -text`**：二进制原样存储，杜绝 git 行尾转换破坏 md5 对比（publish 脚本自动生成）
- **loader.mjs 路径计算陷阱**：import.meta.url 算出的是 electron/ 子目录，app 目录 = dirname(electron/)——历史上这里错位导致 app-old 永远找不到，改路径时勿回退

## client 引导分支（免 zip 分发）

GitHub 单文件 100MB 上限放不下 189MB 的 exe，`npm run publish` 同时维护一个 **client 分支**（~3MB）：`setup.bat` + `rcedit-x64.exe` + `icon.ico` + 完整 payload。新机器流程：仓库页面切 client 分支 → Download ZIP → 解压双击 setup.bat → curl 从 **npmmirror** 拉 Electron 运行时（115MB，不走系统代理——PS Invoke-WebRequest 会撞代理的 TLS 坑）→ 组装 → rcedit 图标。**setup.bat 必须 GBK + CRLF**（cmd 解析器对 UTF-8 中文和 LF-only 都会错乱——两个历史坑，publish 脚本已自动转换）。已装客户端的机器永远不用这个分支（main 自动热更新）。

**publish 幂等性**（防 GitHub 噪音）：对 payload 实际内容（dist+electron+patches+package.json+README+setup 模板+rcedit/icon+electron 版本）算 md5 存入 `version.json.contentHash`。哈希不变 → version.json 不重写（builtAt 不刷新）→ main 无提交、client 检测远端哈希一致直接跳过强推——零推送零通知。曾因 builtAt 无条件刷新导致每次 publish 都强推 client、GitHub 每次都弹"分支有更新"（历史坑，勿回退）。注意 vite 构建必须确定性（同源码同产物，已验证），否则幂等失效。

## DeepSeek 官方密钥（settings 内置）

`config.dsApiKey` / `config.dsBaseUrl`：设置界面在**官方模型选中时**（`!activeCustom`）显示输入区。注入优先级 = 自定义模型凭证 > dsApiKey/dsBaseUrl > .env 文件（dsh-runtime start()）。改这两项触发 runtime 重启（needsRestart 列表）。hasApiKey 检测覆盖三来源。

## 4. 关键设计决策与历史教训（改代码前必读）

1. **凭证优先级**：runtime env 注入顺序 = customModels[activeCustom] 的 baseURL/apiKey > 官方模型设置 config.dsApiKey/dsBaseUrl（设置界面填写）> dsh-client/.env > harness/.env > 进程环境。`hasApiKey` 检测要覆盖 customModels.some(m=>m.apiKey) 与 dsApiKey（曾因只查废弃字段 `config.apiKey` 误报）。
2. **provider 路由**：所有模型（含火山等自定义端点）一律走 `deepseek-official`（适配器支持 `DEEPSEEK_BASE_URL` 指向任意 OpenAI 兼容端点）；客户端标识存 `activeCustom`，**绝不**把 `custom-*` 传给 initialize（会 no adapter registered 崩溃，历史事故）。
3. **maxTokens**：火山 flash 系上限 131072，harness 默认 256000 会被端点 400 拒绝（曾表现为"发消息无回复"，靠解压 session 日志定位 `turn/end reason:error`）。自定义模型各自存 maxTokens，initialize 时取激活模型的值。
4. **多模态**：harness 对未编目模型按 text-only 处理并替换图片为占位文本。图片模型需登记 `~/.dsh/settings.yaml` 的 `llm-deepseek.models`（含 `inputModalities: [text, image]`；models 是**整体替换**，必须带上官方 4 个）。
5. **会话 ID 跨重启**：runtime 重启后同 ID prompt → 补丁走 resume（磁盘日志恢复上下文）；resume 也失败（损坏）→ 客户端 fallback 换新 ID 并插提示 note。
6. **图片**：发送时落盘 `userData/attachments/<uuid>.<ext>`，echo/持久化只存文件名，渲染走 `dshimg://` 自定义协议（main.mjs protocol.handle，带路径穿越防护）。CSP 已放行 `img-src dshimg:`。
7. **缓存教训**：**vite 缓存会掩盖真实产物**——曾因缓存未发现 findModel 被误删导致新机器黑屏。**改完必须 `rm -rf node_modules/.vite dist` 再构建**，且用打包版（非 dev）验证。
8. **Windows 环境坑**：pnpm install 与 build 并发会互相打死；Defender 删 rcedit 修改中的 exe（打包方案绕过）；cmd 错误输出是 GBK（工具链预检用自定义中文消息规避）；taskkill /F 杀 Electron 会留孤儿 runtime 占写句柄（启动时清杀）。
9. **布局稳定性**：侧栏 `session-top-spacer`（flex, max-height 300px）把「变更记录+历史对话」标题推到中部；列表增删不影响标题位置（曾三次因居中布局抖动返工）。`justify-content: safe center` 用于需要居中但防溢出裁切的场景。
10. **echo 即时显示**：prompt() 里 echo push 在 ensureStarted **之前**（冷启动 10s+ 也不卡显示）；去重策略 = 收到 user/message 事件时按 messageId/文本匹配 echo 并**保留 echo**（它带图片预览，事件版只有 attachment 引用）。
11. **状态机**：`initializePromise` 成功后必须清空（否则 getState 永远 starting——历史 bug）；UI 每 5s 对账防通知丢失。
12. **构建跳过**：harness 更新的 build stamp（HEAD+patch md5）没变则跳过 install/build（92s → 1.6s）。
13. **品牌一致性**：鲸鱼图标单一数据源在 `WhaleMark.jsx`——界面（侧栏/标题栏/欢迎页）、dev 窗口图标（main.mjs 读 `build/icon.ico`）、打包 exe 图标（rcedit 嵌入）全部由它派生；改一处重跑 make-icon + dist 即全量更新。

## 5. IPC 通道总表（preload ↔ main）

`dsh:` getState / newSession / selectSession / deleteSession / renameSession / togglePinSession / sendPrompt(text, images, mode) / interrupt / decideApproval(id, outcome) / restart / updateConfig / addCustomModel / removeCustomModel / pickWorkspace / listChangePlans / checkHarnessPatches / harnessStatus / harnessUpdate / applyHarnessPatches / configLocations / openConfigFolder / setNativeTheme / contextMenuStatus / registerContextMenu / unregisterContextMenu

推送（main→renderer）：`dsh:snapshot`（80ms 防抖会话快照）/ `dsh:runtime`（status: starting/ready/dead）/ `dsh:harnessProgress`（更新流水线步骤）

## 6. 配置与数据文件

| 文件 | 内容 |
|---|---|
| `%APPDATA%\dsh-client\settings.json` | config：workspace/harnessDir（空=客户端目录下同名默认）、harnessRepo、harnessAutoUpdate、provider/model/activeCustom/reasoningEffort/maxTokens、customModels[]（label/baseURL/apiKey/model/provider/maxTokens） |
| `%APPDATA%\dsh-client\sessions.json` | 会话快照（消息/usage/todos/pinned；图片只存附件文件名） |
| `%APPDATA%\dsh-client\attachments\` | 图片附件（dshimg:// 服务） |
| `%APPDATA%\dsh-client\crash.log` | 渲染层错误/进程崩溃/GPU 事件（远程排障第一入口） |
| `~/.dsh/settings.yaml` | harness 全局：llm-deepseek 模型目录（多模态登记） |
| `~/.dsh/sessions/` | harness 会话日志（zstd 压缩 JSONL，resume 数据源） |
| `<harness>/.dsh-build-stamp` | 构建指纹（HEAD+补丁 md5） |

## 7. 常见修改场景速查

| 想改什么 | 去哪 |
|---|---|
| 界面样式/布局 | `src/app.css`（CSS 变量在 :root 与 [data-theme="light"]） |
| 聊天行为（渲染/输入/模式） | `src/components/ChatPanel.jsx` |
| 应用图标（exe/窗口/界面鲸鱼） | 改 `src/components/WhaleMark.jsx` → `node scripts/make-icon.mjs` → `npm run dist` |
| 新增官方预设模型 | `src/models.js` MODEL_GROUPS + `~/.dsh/settings.yaml`（若多模态） |
| RPC 协议行为/新方法 | harness `packages/sdk/server/src/server.ts` → 改后 **重建 harness + 刷新 patches/sdk-server.patch** |
| 消息聚合/事件处理 | `electron/dsh-runtime.mjs` applyEvent / applyStreamChunk |
| 更新流水线 | `electron/harness-update.mjs` |
| 打包 | `npm run dist`（scripts/package-dist.mjs） |

## 8. 命令

```bash
# 开发（热更，改 src/ 即时生效；改 electron/ 需重启）
npm run dev
# 重新生成应用图标（改 WhaleMark.jsx 后）
node scripts/make-icon.mjs
# 干净构建（改完代码的验证标准：先清缓存）
rm -rf node_modules/.vite dist && npx vite build
# 打包（win-unpacked + zip；需先关正在运行的 DSH Client.exe，release 目录被占用会明确提示）
npm run dist
# 发布 payload（客户端自更新通道）
npm run publish                        # 首次: npm run publish -- --repo <仓库地址>
# harness 重建（改 harness 源码/补丁后）
cd ../deepseek-harness && pnpm run build
# 补丁重应用（上游 git pull 后）
bash patches/apply-patches.sh && cd ../deepseek-harness && pnpm install && pnpm run build
```

## 9. 已知限制（有意接受）

- 消息列表无虚拟化（几千条会卡）
- 设置里改 harnessRepo 后需先「保存」再点「检查并更新」（更新读已存配置）
- goal 卡片未实现（harness 的 goal/change 事件结构复杂、优先级低）
- 亮色主题下 work-dots/approval 等彩色元素未逐个适配（基本可看）
- 非 DeepSeek 端点的思考强度已自动隐藏并置 off；官方模型 effort 词汇为 off/low/high/max
