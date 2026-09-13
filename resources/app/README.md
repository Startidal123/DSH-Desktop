# DSH Client — DeepSeek Harness 桌面客户端

基于 [deepseek-harness](https://github.com/deepseek-harness) 的 Windows 桌面客户端。开箱自动部署，无需预装 git / node / pnpm。

## 快速开始

**方式一（免 zip）**：仓库 → client 分支 → Download ZIP → 双击 `setup.bat`
**方式二**：`npm install && npm run dist` 本地打包。

然后：设置 → Harness 更新 → 检查并更新（自动部署工具链 + harness + 补丁 + 构建）
最后：配置 API 密钥（设置 → DeepSeek 官方模型密钥 / 模型下拉添加自定义端点）

## 功能

- 三列布局：会话管理 / 对话 / 统计审批
- 构建模式（可执行）与计划模式（只读调研 + 一键执行计划）
- 实时思考与输出流 / 随时打断
- 审批桥 / `.dsh-changes/` 变更文档
- 模型下拉（官方 + 任意 OpenAI 兼容端点，独立 maxTokens）
- 图片输入 + 保存 / Lightbox / 文本搜索 / 消息折叠
- 会话搜索 / 置顶 / 右键菜单 / 按工作区分组
- 亮暗主题 / 隐藏统计栏 / 原生窗口按钮适配

MIT License
