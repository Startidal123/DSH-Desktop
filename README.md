# DSH Client

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面客户端。三列布局（会话管理 / 对话 / 统计审批），开箱自动部署，无需预装 git / node / pnpm，支持客户端自热更新。

## 本仓库是什么

这是一个**源码 + 发布通道二合一**的仓库：

```
├── src/               # 渲染层源码（React）
├── electron/          # 主进程源码（Electron）
├── dist/              # 前端构建产物（npm run publish 时生成）
├── patches/           # 对 deepseek-harness 的客户端补丁
├── scripts/           # 打包 / 发布 / 图标脚本
└── version.json       # 发布版本戳
```

**客户端自更新机制**：各机器上运行的客户端在空闲时静默检查本仓库的 main 分支，浅克隆后只取 payload 部分（`dist/` `electron/` `patches/` `package.json` `version.json` `README.md`）热替换到安装目录的 `resources/app/`——纯源码目录（`src/`、`scripts/`）会被拉取但不参与应用。因此：

- **界面改动** → 窗口刷新，秒级生效，无需重启
- **主进程改动** → 自动重启应用
- **坏更新包** → 结构校验拒绝 / 启动失败自动回滚 / 坏版本黑名单防循环

开发机上改完代码，一条 `npm run publish` 即完成全网更新分发。

## 快速开始（客户端用户）

**方式一（推荐，免 zip）**：仓库切换到 **client 分支** → Download ZIP → 解压 → 双击 `setup.bat`（自动从国内镜像下载运行时并组装，1~3 分钟）

**方式二**：`npm install && npm run dist` 本地打包。

然后：
1. 运行 `DSH Client.exe`，打开 **设置 → Harness 更新 → 检查并更新**：自动下载便携工具链（git/pnpm）→ 克隆 harness → 应用补丁 → 构建，全程 5~10 分钟
2. 配置 API 密钥：官方模型在 **设置 → DeepSeek 官方模型密钥** 直接填写；自定义端点在模型下拉 →「+ 添加自定义模型」
3. 欢迎页直接输入发送，自动创建新对话

## 功能速览

| 区域 | 功能 |
|---|---|
| 左列 | 会话搜索 / 置顶 / 重命名；`.dsh-changes/` 变更记录查看 |
| 中列 | 实时思考与输出流；工具调用卡片；图片输入 + 点击放大；回复复制；回到底部 |
| 右列 | 待审操作（敏感操作人工批准）；Token 用量；缓存命中率；任务清单 |
| 输入区 | 构建/计划模式（Tab 切换）；思考强度；工作路径显示与切换 |

**构建模式**正常执行（敏感操作经审批桥暂停待批）；**计划模式**只读调研输出计划，切回构建后「引用计划并执行」一键闭环。

## 模型与自定义端点

支持任意 OpenAI 兼容端点（火山方舟、百炼、OpenRouter、vLLM 等），每个模型独立保存 Base URL / API Key / 最大输出 tokens。多模态需模型支持（如 GLM-5.3-Flash、DeepSeek-V4.1-Flash）。

## 数据位置（迁移时拷贝 settings.json 即可）

| 内容 | 路径 |
|---|---|
| 模型配置 / 设置 | `%APPDATA%\dsh-client\settings.json` |
| 历史会话 / 图片附件 | `%APPDATA%\dsh-client\sessions.json`、`attachments\` |
| 崩溃日志 | `%APPDATA%\dsh-client\crash.log` |
| harness 仓库 / 工作区（默认） | exe 同级 `harness\`、`workspace\` |

设置标题右侧可一键注册**文件夹右键菜单**：右键任意文件夹 →「用 DSH Client 打开」即以该目录为工作区启动。

## 开发

```bash
npm install        # 依赖
npm run dev        # 开发模式（热更新）
npm run publish    # 构建 + 推送发布（客户端自动更新通道）
npm run dist       # 打 zip 分发版（含 exe）
```

架构决策、修改指南、踩坑记录见 [PROJECT.md](PROJECT.md)（给下一个开发者/AI 的完整交接文档）。

## 常见问题

- **打开黑屏**：窗口会显示红色错误文字，另见 `crash.log`；显卡驱动问题可用 `DSH Client.exe --disable-gpu`
- **发消息没回复**：看对话流红色错误条（如 max_tokens 超端点上限，在模型配置调低）
- **杀毒报警**：未签名 exe 的正常误报，将客户端文件夹加入信任区

MIT License

test change
