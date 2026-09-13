# harness 补丁说明

本目录维护对 `deepseek-harness` 仓库的本地补丁。上游更新（git pull）后补丁会被冲掉，
请重新应用并重建 harness：

```bash
bash patches/apply-patches.sh          # 默认路径 ../deepseek-harness 相对仓库根
cd ../deepseek-harness && pnpm install && pnpm run build
```

## sdk-server.patch（packages/sdk/server）

1. **resume 回退**：`createSession` 遇到 "already exists"（磁盘已有持久化会话）时
   自动回退 `ctx.agents.resume`，重启 runtime 后同 sessionId 续聊保留模型上下文。
2. **session/interrupt**：新增 JSON-RPC 方法，调用 `agent.cancel({kind:'user'})`
   中止当前 turn（客户端"停止"按钮 / 发送即打断）。
3. **session.stream 转发**：订阅 agent 作用域的 `agent/assistant-stream` 流帧，
   作为 `session.stream` 通知转发（客户端实时思考/输出显示）。
4. **审批桥**：注册 `approval/request` answerer，把审批问题作为 `session.approval`
   通知转发客户端并挂起工具调用，新增 `session/approvalDecide` 方法回传人工决策；
   未决策时工具调用一直等待（fail-closed 问题由此解决）。
5. **变更计划协议**：systemPrompt 注入 "change-plan protocol" 段——模型在大改动前
   先在工作区 `.dsh-changes/` 写变更说明文档，再执行改动（执行经审批桥人工放行）。
6. **package.json**：devDependencies 增加 dsh-system-prompt / dsh-user-approval
   （类型声明合并所需）。
