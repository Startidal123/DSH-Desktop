# DSH Client — DeepSeek Harness 桌面客户端

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面客户端。开箱自动部署，无需预装 git / node / pnpm。

## 安装

1. 仓库 → `client` 分支 → Download ZIP → 双击 `setup.bat`（自动从国内镜像下载 Electron 并组装）
2. 启动后：设置 → Harness 更新 → 检查并更新（自动部署工具链 + harness + 补丁 + 构建）
3. 配置 API 密钥（设置 → 模型密钥，或主界面模型下拉添加自定义端点）

已装客户端的机器无需重装：应用自动检测并从 `main` 分支热更新。

## 功能

- 三列布局：会话管理 / 对话 / 统计审批
- 构建模式（可执行）与计划模式（只读调研 + 一键执行计划）
- 实时思考与输出流 / 随时打断 / 审批桥 / `.dsh-changes/` 变更文档
- 模型下拉（官方 + 任意 OpenAI 兼容端点，独立 maxTokens）
- 图片输入 / 消息折叠（状态跨会话记忆）/ Ctrl+F 对话内搜索
- 会话按工作区分组、置顶、搜索 / 自绘窗口按钮 / 亮暗主题

MIT License
