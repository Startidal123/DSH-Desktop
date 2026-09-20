import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
const DEFAULT_CONFIG = {
  harnessDir: '',
  workspace: '',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 0,
  customModels: [],
  activeCustom: '',
  harnessRepo: 'https://github.com/deepseek-ai/deepseek-harness',
  harnessAutoUpdate: true,
  clientUpdateRepo: 'https://github.com/Startidal123/DSH-Desktop',
  clientAutoUpdate: true,
  dsApiKey: '',
  dsBaseUrl: '',
}

function customModelActive(config) {
  const list = Array.isArray(config.customModels) ? config.customModels : []
  return list.find(m => m.provider === config.activeCustom) ?? null
}

const PLAN_PREFIX = '[PLAN MODE] 你处于计划模式：仅进行阅读、搜索、分析等只读调研。禁止创建、修改、删除任何文件，禁止执行有副作用的命令（写入、安装、构建、网络变更等）。请输出调研结论与分步执行计划；用户切换到构建模式后才会允许执行。\n\n用户消息：\n'

function loadEnvFile(file) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
  }
}

function addUsage(target, usage) {
  if (!usage) return
  target.inputTokens += usage.inputTokens ?? 0
  target.outputTokens += usage.outputTokens ?? 0
  target.cacheReadTokens += usage.cacheReadTokens ?? 0
  target.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  target.reasoningTokens += usage.reasoningTokens ?? 0
  target.totalTokens += usage.totalTokens ?? 0
  target.requests += 1
}

function blockText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text').map(b => b.text).join('\n').trim()
}

function truncate(text, n) {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

export class DshRuntime {
  constructor(onSnapshot, onRuntime, persistFile, attachmentDir, defaults = {}) {
    this.onSnapshot = onSnapshot
    this.onRuntime = onRuntime
    this.persistFile = persistFile
    this.attachmentDir = attachmentDir
    this.config = { ...DEFAULT_CONFIG, ...defaults }
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stderrTail = []
    this.stderrHead = ''
    this.sessions = new Map()
    this.dismissedSubagents = new Map()
    this.activeId = null
    this.initializePromise = null
    this.dead = false
    this.restarting = false
    this.flushTimer = null
    this.sessionEpoch = 0
    this.userInterrupted = false
    this.loadSessions()
  }

  updateConfig(partial) {
    Object.assign(this.config, partial)
    if (partial.workspace) {
      let fixed = false
      for (const s of this.sessions.values()) {
        if (!s.workspace) { s.workspace = this.config.workspace; fixed = true }
      }
      if (fixed) this.persist()
    }
  }

  /** Sessions ordered pinned-first then most-recently-active. Subagent
   *  sessions never appear in the sidebar — they surface via the stats
   *  panel's subagent list and viewer instead. */
  orderedSessions() {
    return [...this.sessions.values()]
      .filter(s => !s.subagent)
      .sort((a, b) => {
        const pin = (b.pinned === true) - (a.pinned === true)
        if (pin !== 0) return pin
        return b.updatedAt - a.updatedAt
      })
  }

  getState() {
    const active = this.sessions.get(this.activeId)
    return {
      config: this.config,
      runtime: this.dead ? 'stopped' : this.initializePromise ? 'starting' : this.child ? 'ready' : 'stopped',
      activeId: this.activeId,
      sessions: this.orderedSessions().map(s => this.summary(s)),
      active: active ? this.snapshot(active) : null,
    }
  }

  summary(s) {
    const searchText = [s.title]
    for (const m of s.messages.slice(-20)) {
      if (m.kind === 'user' || m.kind === 'user-local' || m.kind === 'assistant') {
        const t = blockText(m.content)
        if (t) searchText.push(t)
      } else if (m.kind === 'note' || m.kind === 'note-error') {
        searchText.push(m.note)
      }
    }
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      todoCount: s.todos.length,
      pinned: s.pinned === true,
      workspace: s.workspace ?? '',
      search: searchText.join(' ').slice(0, 4000),
    }
  }

  renameSession(id, title) {
    const s = this.sessions.get(id)
    if (!s) return
    s.title = String(title).trim().slice(0, 60) || s.title
    this.emitSnapshot()
  }

  togglePinSession(id) {
    const s = this.sessions.get(id)
    if (!s) return
    s.pinned = !s.pinned
    this.emitSnapshot()
  }

  snapshot(s) {
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      updatedAt: s.updatedAt,
      messages: s.messages,
      usage: s.usage,
      todos: s.todos,
      livePreview: s.livePreview ?? null,
      approvals: s.approvals ?? [],
      subagents: [...this.sessions.values()]
        .filter(x => x.subagent && x.parentId === s.id)
        .map(x => ({
          id: x.id,
          title: x.title,
          status: x.subagentStatus ?? x.status,
          updatedAt: x.updatedAt,
          messageCount: x.messages.length,
          index: x.subagentIndex ?? 99,
          viewed: x.viewed === true,
        }))
        .sort((a, b) => a.index - b.index),
    }
  }

  emitSnapshot() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const active = this.sessions.get(this.activeId)
      this.onSnapshot({
        activeId: this.activeId,
        sessions: this.orderedSessions().map(x => this.summary(x)),
        active: active ? this.snapshot(active) : null,
      })
      this.persist()
    }, 80)
  }

  persist() {
    if (!this.persistFile) return
    try {
      const data = [...this.sessions.values()].map(s => this.serializeSession(s))
      mkdirSync(dirname(this.persistFile), { recursive: true })
      writeFileSync(this.persistFile, JSON.stringify(data))
    } catch { /* best effort */ }
  }

  serializeSession(s) {
    return {
      id: s.id,
      title: s.title,
      status: 'idle',
      updatedAt: s.updatedAt,
      usage: s.usage,
      todos: s.todos,
      pinned: s.pinned === true,
      workspace: s.workspace ?? '',
      messages: s.messages.map(m => this.serializeMessage(m)),
      ...(s.subagent ? {
        subagent: true,
        parentId: s.parentId ?? '',
        subagentStatus: s.subagentStatus ?? '',
        subagentIndex: s.subagentIndex ?? 99,
        viewed: s.viewed === true,
      } : {}),
    }
  }

  serializeMessage(m) {
    if (m.kind === 'note' || m.kind === 'note-error') {
      // note-error MUST carry its note too — the generic branch below drops
      // it, and a restart would turn the red error row into an empty box
      return { kind: m.kind, note: m.note, time: m.time }
    }
    if (m.kind === 'tool') {
      return {
        kind: 'tool',
        name: m.name,
        arguments: typeof m.arguments === 'string' ? m.arguments.slice(0, 8000) : '',
        status: m.status,
        isError: m.isError === true,
        result: this.stripBlocks(m.result, 5000),
        time: m.time,
      }
    }
    return {
      kind: m.kind,
      role: m.role,
      source: m.source,
      time: m.time,
      content: this.stripBlocks(m.content, 50000),
      // per-message usage powers the token-breakdown view; without it the
      // detail list would go empty after a restart
      ...(m.usage ? { usage: m.usage } : {}),
    }
  }

  stripBlocks(blocks, maxChars) {
    if (!Array.isArray(blocks)) return []
    return blocks.map((b) => {
      if (b?.type === 'image') {
        if (b.path) return { type: 'image', mimeType: b.mimeType, path: b.path }
        if (b.data) return { type: 'image', mimeType: b.mimeType }
        return b
      }
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > maxChars) {
        return { ...b, text: b.text.slice(0, maxChars) + '…' }
      }
      return b
    })
  }

  loadSessions() {
    if (!this.persistFile || !existsSync(this.persistFile)) return
    try {
      const arr = JSON.parse(readFileSync(this.persistFile, 'utf8'))
      for (const s of arr ?? []) {
        if (!s?.id || this.sessions.has(s.id)) continue
        this.sessions.set(s.id, {
          id: s.id,
          title: s.title ?? '新对话',
          status: 'idle',
          messages: Array.isArray(s.messages) ? s.messages : [],
          usage: { ...emptyUsage(), ...(s.usage ?? {}) },
          todos: Array.isArray(s.todos) ? s.todos : [],
          updatedAt: s.updatedAt ?? Date.now(),
          toolByCallId: new Map(),
          serverEpoch: 0,
          pinned: s.pinned === true,
          workspace: s.workspace ?? '',
          ...(s.subagent ? {
            subagent: true,
            parentId: s.parentId ?? '',
            subagentStatus: s.subagentStatus ?? '',
            subagentIndex: s.subagentIndex ?? 99,
            viewed: s.viewed === true,
          } : {}),
        })
      }
      // start on the welcome screen: sessions stay listed in the sidebar,
      // but the chat pane opens empty until the user picks one or sends
      this.activeId = null
      // legacy subagent sessions predate the index field (they would all
      // show the 99 fallback) — backfill creation order per parent once
      {
        const byParent = new Map()
        for (const s of this.sessions.values()) {
          if (!s.subagent) continue
          const key = s.parentId ?? ''
          if (!byParent.has(key)) byParent.set(key, [])
          byParent.get(key).push(s)
        }
        let changed = false
        for (const group of byParent.values()) {
          if (group.every(x => Number.isInteger(x.subagentIndex) && x.subagentIndex > 0 && x.subagentIndex < 99)) continue
          group.sort((a, b) => a.updatedAt - b.updatedAt)
          group.forEach((x, i) => { x.subagentIndex = i + 1 })
          changed = true
        }
        if (changed) this.persist()
      }
    } catch { /* corrupt file: start fresh */ }
  }

  ensureSession(id) {
    let s = this.sessions.get(id)
    if (!s) {
      s = {
        id,
        title: '新对话',
        status: 'idle',
        messages: [],
        usage: emptyUsage(),
        todos: [],
        updatedAt: Date.now(),
        toolByCallId: new Map(),
        serverEpoch: this.sessionEpoch,
        workspace: this.config.workspace || '',
      }
      // events from a dismissed (user-deleted) subagent recreate its session
      // flagged with the original parent + index: a still-running subagent
      // thus REAPPEARS in the subagent list (accidental-delete protection)
      // and never leaks into the sidebar
      if (this.dismissedSubagents.has(id)) {
        const d = this.dismissedSubagents.get(id) ?? { parentId: '', index: 99 }
        s.subagent = true
        s.parentId = d.parentId
        s.viewed = true
        s.subagentIndex = d.index
      }
      this.sessions.set(id, s)
    }
    return s
  }

  newSession() {
    const id = randomUUID()
    this.ensureSession(id)
    this.activeId = id
    this.emitSnapshot()
    return id
  }

  selectSession(id) {
    if (this.sessions.has(id)) {
      this.activeId = id
      this.emitSnapshot()
    }
  }

  /** After an interactive workspace switch, focus a fresh session in the new
   *  workspace — reusing an untouched one so toggling back and forth doesn't
   *  pile up empty conversations. */
  focusWorkspaceSession() {
    const ws = this.config.workspace || ''
    const existing = this.orderedSessions()
      .find(s => (s.workspace ?? '') === ws && s.messages.length === 0 && s.title === '新对话')
    if (existing) {
      this.selectSession(existing.id)
      return existing.id
    }
    return this.newSession()
  }

  deleteSession(id) {
    this.sessions.delete(id)
    if (this.activeId === id) {
      this.activeId = this.sessions.keys().next().value ?? null
    }
    this.emitSnapshot()
  }

  async ensureStarted() {
    if (this.dead) throw new Error('runtime 已停止，请重启')
    if (this.child && !this.initializePromise) return
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = this.start()
    try {
      await this.initializePromise
    } catch (err) {
      this.initializePromise = null
      throw err
    }
  }

  async start() {
    this.onRuntime('starting')
    const envVars = {
      ...loadEnvFile(resolve(process.cwd(), '.env')),
      ...loadEnvFile(resolve(this.config.harnessDir, '.env')),
    }
    const env = { ...process.env }
    for (const [k, v] of Object.entries(envVars)) {
      if (env[k] === undefined || env[k] === '') env[k] = v
    }
    // credential priority: active custom model > official DeepSeek settings >
    // .env files
    const active = customModelActive(this.config)
    if (active?.baseURL) env.DEEPSEEK_BASE_URL = active.baseURL
    if (active?.apiKey) env.DEEPSEEK_API_KEY = active.apiKey
    if (!active) {
      if (this.config.dsBaseUrl) env.DEEPSEEK_BASE_URL = this.config.dsBaseUrl
      if (this.config.dsApiKey) env.DEEPSEEK_API_KEY = this.config.dsApiKey
    }
    // the runtime only registers the official route; custom models ride it
    // through DEEPSEEK_BASE_URL, so a leaked custom-* provider id is fatal
    const provider = String(this.config.provider).startsWith('custom-')
      ? 'deepseek-official'
      : this.config.provider
    // Prefer the system node; fall back to Electron's bundled node so the
    // runtime still boots on machines without a Node install
    let nodeBin = process.env.DSH_CLIENT_NODE ?? 'node'
    try {
      execSync('node --version', { stdio: 'ignore', windowsHide: true, timeout: 10000 })
    } catch {
      nodeBin = process.execPath
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    // Prefer the built CLI (fast start); fall back to tsx source mode for
    // unbuilt checkouts. Neither existing means the harness is absent — fail
    // with an actionable message instead of a confusing spawn crash.
    const builtBin = resolve(this.config.harnessDir, 'apps/cli/lib/bin.js')
    const srcBin = resolve(this.config.harnessDir, 'apps/cli/src/bin.ts')
    if (!existsSync(builtBin) && !existsSync(srcBin)) {
      throw new Error(`harness 未部署（${this.config.harnessDir}）：在「设置 → Harness 更新」点击“检查并更新”完成自动部署`)
    }
    const useBuilt = existsSync(builtBin)
    this.child = spawn(nodeBin, useBuilt
      ? [builtBin, '--profile', 'sdk']
      : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'sdk'], {
      cwd: this.config.harnessDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.onStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderrTail.push(chunk)
      if (this.stderrTail.length > 40) this.stderrTail.shift()
      // keep the head too: ERR_MODULE_NOT_FOUND puts the module name in the
      // FIRST line, and a tail-only slice cuts it off exactly when it matters
      if (this.stderrHead.length < 700) this.stderrHead += chunk
      // surface runtime diagnostics live instead of only after a crash
      process.stdout.write(`[dsh-runtime] ${chunk}`)
    })
    this.child.on('exit', (code) => {
      this.child = null
      this.initializePromise = null
      for (const { reject } of this.pending.values()) {
        reject(new Error('runtime 进程已退出'))
      }
      this.pending.clear()
      // a deliberate restart announces itself via start() → 'starting';
      // only unexpected exits surface as 'dead'
      if (this.restarting) return
      this.onRuntime('dead', {
        code,
        stderrHead: this.stderrHead.slice(0, 700),
        stderr: this.stderrTail.join('').slice(-4000),
      })
    })
    // a custom endpoint may cap output far below the DeepSeek default
    // (e.g. Volcano GLM-5.3-Flash rejects max_tokens > 131072), so its own
    // limit wins when set
    const effectiveMaxTokens = active?.maxTokens ?? this.config.maxTokens
    // custom endpoints vary in what reasoning params they accept (some reject
    // 'off' outright); official DeepSeek models get the full effort control
    const effectiveEffort = active ? '' : (this.config.reasoningEffort || '')
    await this.request('initialize', {
      cwd: this.config.workspace,
      provider,
      model: this.config.model,
      ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
      ...(effectiveMaxTokens > 0 ? { maxTokens: effectiveMaxTokens } : {}),
    }, 30000)
    this.onRuntime('ready')
    this.sessionEpoch += 1
    // the in-flight marker retires once the handshake is complete, so
    // getState reports "ready" instead of a forever-"starting"
    this.initializePromise = null
  }

  async stop() {
    this.dead = true
    if (!this.child) return
    const child = this.child
    try {
      await this.request('shutdown', undefined, 2000)
    } catch { /* teardown ladder below owns the rest */ }
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 3000)
    await new Promise(r => { child.once('exit', r); setTimeout(r, 4000) })
  }

  async restart() {
    this.restarting = true
    try {
      await this.stop().catch(() => {})
    } finally {
      this.restarting = false
    }
    this.dead = false
    this.stderrTail = []
    this.stderrHead = ''
    await this.ensureStarted()
  }

  onStdout(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.method === undefined && msg.id !== undefined) {
        const entry = this.pending.get(msg.id)
        if (entry) {
          this.pending.delete(msg.id)
          clearTimeout(entry.timer)
          if (msg.error) entry.reject(Object.assign(new Error(msg.error.message ?? 'JSON-RPC error'), { code: msg.error.code, data: msg.error.data }))
          else entry.resolve(msg.result)
        }
      } else if (msg.method !== undefined && msg.id === undefined) {
        this.onNotification(msg.method, msg.params).catch(() => {})
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) {
        reject(new Error('runtime 未运行'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null }) + '\n')
    })
  }

  async onNotification(method, params) {
    if (method === 'session.approval') {
      const s = this.ensureSession(params.sessionId)
      s.approvals = s.approvals ?? []
      s.approvals.push({
        id: params.approvalId,
        toolName: params.toolName,
        reason: params.reason ?? '',
      })
      this.emitSnapshot()
      return
    }
    if (method === 'session.approval-withdrawn') {
      const s = this.sessions.get(params.sessionId)
      if (s?.approvals) {
        s.approvals = s.approvals.filter(a => a.id !== params.approvalId)
        this.emitSnapshot()
      }
      return
    }
    if (method === 'session.stream') {
      this.applyStreamChunk(params.sessionId, params.frame)
      return
    }
    if (method === 'session.status') {
      const s = this.ensureSession(params.sessionId)
      s.status = params.status
      s.updatedAt = Date.now()
      this.emitSnapshot()
      return
    }
    if (method === 'session.event') {
      this.applyEvent(params.sessionId, params.event)
      this.emitSnapshot()
      return
    }
    if (method === 'subagent.started') {
      // the child's session.status/event notifications arrive with its own
      // session id and lazily create a shell session — flag it so it stays
      // out of the sidebar and links back to the parent for the viewer
      const child = this.ensureSession(params.childSessionId)
      child.subagent = true
      child.parentId = params.parentSessionId
      child.subagentStatus = 'running'
      child.viewed = false
      // the harness re-invokes finished subagents under the SAME child
      // session id — the creation index must be sticky, not recomputed on
      // every re-start (otherwise the numbers keep drifting upward)
      if (!Number.isInteger(child.subagentIndex) || child.subagentIndex <= 0) {
        child.subagentIndex = 1 + Math.max(0, ...[...this.sessions.values()]
          .filter(x => x.subagent && x.parentId === params.parentSessionId)
          .map(x => x.subagentIndex ?? 0))
      }
      const s = this.sessions.get(params.parentSessionId)
      if (s) {
        s.messages.push({ kind: 'note', note: `子任务已启动（${params.childSessionId.slice(0, 8)}）`, time: Date.now() })
      }
      this.emitSnapshot()
      return
    }
    if (method === 'subagent.finished') {
      const child = this.sessions.get(params.childSessionId)
      if (child) {
        child.subagent = true
        child.parentId = params.parentSessionId
        child.subagentStatus = params.status === 'ok' ? 'ok' : 'failed'
      }
      const s = this.sessions.get(params.parentSessionId)
      if (s) {
        s.messages.push({ kind: 'note', note: `子任务完成（${params.status === 'ok' ? '成功' : '失败'}）`, time: Date.now() })
      }
      this.emitSnapshot()
    }
  }

  /** Remove a subagent view the user no longer wants. The dismissal record
   *  keeps parent + index so that events from a STILL-RUNNING child
   *  recreate it with its original number (accidental-delete protection)
   *  while it never leaks into the sidebar as a stray conversation.
   *  Finished subagents have no further events, so their deletion sticks. */
  deleteSubagent(id) {
    const s = this.sessions.get(id)
    if (!s || !s.subagent) return false
    this.dismissedSubagents.set(id, { parentId: s.parentId ?? '', index: s.subagentIndex ?? 99 })
    this.sessions.delete(id)
    this.emitSnapshot()
    return true
  }

  markSubagentViewed(id) {
    const s = this.sessions.get(id)
    if (s?.subagent && s.viewed !== true) {
      s.viewed = true
      this.emitSnapshot()
    }
  }

  applyStreamChunk(sessionId, frame) {
    if (!frame || frame.type !== 'chunk') return
    const s = this.sessions.get(sessionId)
    if (!s) return
    const chunk = frame.chunk
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return
    let live = s.livePreview
    if (!live) {
      live = { reasoning: '', text: '', updatedAt: 0 }
      s.livePreview = live
    }
    if (chunk.type === 'reasoning-delta') live.reasoning += chunk.text
    else live.text += chunk.text
    live.updatedAt = Date.now()
    s.updatedAt = Date.now()
    this.emitSnapshot()
  }

  async interrupt() {
    if (!this.activeId) return
    this.userInterrupted = true
    await this.request('session/interrupt', { sessionId: this.activeId })
  }

  async decideApproval(approvalId, outcome) {
    await this.request('session/approvalDecide', { approvalId, outcome })
    for (const s of this.sessions.values()) {
      if (s.approvals?.length) {
        s.approvals = s.approvals.filter(a => a.id !== approvalId)
      }
    }
    this.emitSnapshot()
  }

  applyEvent(sessionId, event) {
    const s = this.ensureSession(sessionId)
    s.updatedAt = event.time ?? Date.now()
    const data = event.data ?? {}
    switch (event.type) {
      case 'user/message': {
        const msg = data.message ?? data
        if ((msg.source?.kind ?? 'user') === 'user' && msg.id) {
          let matched = false
          for (let i = s.messages.length - 1; i >= 0; i--) {
            const m = s.messages[i]
            if (m.kind !== 'user-local' && m.kind !== 'user') continue
            if (m.kind === 'user-local'
              && (m.pendingMessageId === msg.id || blockText(m.content) === blockText(msg.content))) {
              // keep the local echo (it carries inline image previews); the
              // durable event would only hold attachment references
              s.messages[i] = { ...m, kind: 'user', confirmed: true, time: event.time }
              matched = true
              break
            }
          }
          if (matched) break
        }
        s.messages.push({
          kind: 'user',
          role: 'user',
          content: msg.content ?? [],
          source: msg.source ?? { kind: 'user' },
          time: event.time,
        })
        if (s.title === '新对话' && (msg.source?.kind ?? 'user') === 'user') {
          const text = blockText(msg.content)
          if (text) s.title = truncate(text, 30)
        }
        break
      }
      case 'assistant/message': {
        s.messages.push({
          kind: 'assistant',
          role: 'assistant',
          content: data.message?.content ?? [],
          usage: data.usage ?? null,
          interrupted: data.interrupted === true,
          time: event.time,
        })
        addUsage(s.usage, data.usage)
        // the settled message supersedes its live stream preview
        s.livePreview = null
        break
      }
      case 'tool/call': {
        const item = {
          kind: 'tool',
          name: data.name,
          arguments: data.arguments,
          callId: data.callId,
          status: 'running',
          result: null,
          isError: false,
          time: event.time,
        }
        s.messages.push(item)
        s.toolByCallId.set(data.callId, item)
        break
      }
      case 'tool/result': {
        const block = data.message?.content?.[0]
        const item = block ? s.toolByCallId.get(block.toolCallId) : null
        if (item) {
          item.status = 'done'
          item.isError = block.isError === true
          item.result = block.content ?? []
          s.toolByCallId.delete(block.toolCallId)
        } else {
          s.messages.push({
            kind: 'tool',
            name: '(未知工具)',
            arguments: '',
            status: 'done',
            result: block?.content ?? [],
            isError: block?.isError === true,
            time: event.time,
          })
        }
        break
      }
      case 'turn/end': {
        const reason = data.reason
        // user-initiated interrupts surface as abort/cancel errors from the
        // LLM layer — not real failures; suppress them
        if (reason?.kind === 'error' && !this.userInterrupted) {
          const detail = reason.error?.message ?? JSON.stringify(reason.error ?? reason).slice(0, 200)
          s.messages.push({ kind: 'note-error', note: `生成失败：${detail}`, time: event.time })
        }
        this.userInterrupted = false
        break
      }
      case 'todo/write': {
        s.todos = data.todos ?? []
        break
      }
      default:
        break
    }
  }

  async prompt(text, images, options = {}) {
    // echo lands immediately — before any runtime startup — so the user always
    // sees their message the instant they hit send
    if (!this.activeId) this.newSession()
    const sessionId = this.activeId
    const s = this.ensureSession(sessionId)
    const wireText = options.plan ? PLAN_PREFIX + text : text
    // images persist as files under the attachment dir; the echo references
    // them by name (base64 would bloat every snapshot write), while the SDK
    // wire still carries base64
    const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
    const stored = []
    const wireBlocks = []
    for (const img of images ?? []) {
      const name = `${randomUUID()}.${EXT[img.mimeType] ?? 'png'}`
      try {
        mkdirSync(this.attachmentDir, { recursive: true })
        writeFileSync(resolve(this.attachmentDir, name), Buffer.from(img.data, 'base64'))
        stored.push({ type: 'image', mimeType: img.mimeType, path: name })
      } catch {
        stored.push({ type: 'image', mimeType: img.mimeType, data: img.data })
      }
      wireBlocks.push({ type: 'image', data: img.data, mimeType: img.mimeType })
    }
    const echoContent = [
      { type: 'text', text },
      ...stored,
    ]
    const echo = {
      kind: 'user-local',
      role: 'user',
      content: echoContent,
      source: { kind: 'user' },
      time: Date.now(),
      pendingMessageId: null,
    }
    s.messages.push(echo)
    s.updatedAt = Date.now()
    if (s.title === '新对话') s.title = truncate(text, 30)
    this.emitSnapshot()

    await this.ensureStarted()
    let res
    try {
      res = await this.request('session/prompt', {
        sessionId,
        contentBlocks: [
          ...(wireText ? [{ type: 'text', text: wireText }] : []),
          ...wireBlocks,
        ],
      })
    } catch (err) {
      // the patched server resumes persisted ids; if resume itself failed,
      // fall back to a fresh id so the conversation can continue at all
      if (!String(err.message ?? '').includes('already exists')) throw err
      const freshId = randomUUID()
      this.sessions.delete(sessionId)
      this.sessions.set(freshId, {
        ...s,
        id: freshId,
        toolByCallId: new Map(),
        messages: [
          ...s.messages,
          { kind: 'note', note: '无法恢复原会话，已在新会话中继续（模型不保留旧上下文）', time: Date.now() },
        ],
      })
      this.activeId = freshId
      this.emitSnapshot()
      res = await this.request('session/prompt', {
        sessionId: freshId,
        contentBlocks: [
          ...(wireText ? [{ type: 'text', text: wireText }] : []),
          ...wireBlocks,
        ],
      })
    }
    echo.pendingMessageId = res?.messageId ?? null
    return res
  }
}
