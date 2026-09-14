import { useEffect, useRef, useState } from 'react'
import { MODEL_GROUPS, modelDisplayName } from '../models.js'
import { IconChevron, IconCheck, IconX } from './Icons.jsx'

function hostOf(url) {
  try { return new URL(url).host } catch { return url }
}

export default function ModelDropdown({ provider, model, activeCustom, running, runtimeStatus, customModels, onSwitch, onChanged, dropUp = false }) {
  const [open, setOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState({ label: '', baseURL: '', apiKey: '', model: '', maxTokens: '' })
  const [formError, setFormError] = useState('')
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const switchModel = (p, m) => {
    setOpen(false)
    setFormOpen(false)
    if (p === provider && m === model) return
    onSwitch(p, m)
  }

  const customs = Array.isArray(customModels) ? customModels : []
  const activeEntry = customs.find(m => m.provider === activeCustom)
  const disabled = running || runtimeStatus === 'starting'

  const submitForm = async () => {
    setFormError('')
    if (!form.baseURL.trim() || !form.model.trim()) {
      setFormError('baseURL 和模型 ID 必填')
      return
    }
    const res = await window.dsh.addCustomModel({
      label: form.label.trim(),
      baseURL: form.baseURL.trim(),
      apiKey: form.apiKey.trim(),
      model: form.model.trim(),
      maxTokens: form.maxTokens.trim() ? Number(form.maxTokens.trim()) : 0,
    })
    if (!res.ok) { setFormError(res.error); return }
    setForm({ label: '', baseURL: '', apiKey: '', model: '', maxTokens: '' })
    setFormOpen(false)
    onChanged?.()
    switchModel(res.item.provider, res.item.model)
  }

  const removeCustom = async (e, entry) => {
    e.stopPropagation()
    await window.dsh.removeCustomModel(entry.provider)
    onChanged?.()
  }

  return (
    <div className="model-dropdown" ref={rootRef}>
      <button
        className={`model-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen(!open)}
        disabled={runtimeStatus === 'starting'}
        title={activeEntry ? `${activeEntry.label} · ${hostOf(activeEntry.baseURL)}` : model}
      >
        <span className="model-trigger-dot" />
        <span className="model-trigger-name">
          {activeEntry ? activeEntry.label : modelDisplayName(provider, model)}
        </span>
        <IconChevron size={14} />
      </button>

      {open && (
        <div className={`model-menu ${dropUp ? 'up' : ''}`}>
          <div className="model-menu-scroll">
            {MODEL_GROUPS.map(group => (
              <div className="model-group" key={group.provider}>
                <div className="model-group-label">{group.label}</div>
                {group.models.map(m => {
                  const active = !activeCustom && group.provider === provider && m.id === model
                  return (
                    <button
                      key={m.id}
                      className={`model-item ${active ? 'active' : ''}`}
                      disabled={disabled}
                      onClick={() => switchModel(group.provider, m.id)}
                    >
                      <span className="model-item-main">
                        <span className="model-item-name">{m.name}</span>
                        <span className="model-item-desc">{m.desc}</span>
                      </span>
                      {active && <IconCheck size={15} />}
                    </button>
                  )
                })}
              </div>
            ))}

            <div className="model-group">
              <div className="model-group-label">自定义端点</div>
              {customs.map(entry => {
                const active = entry.provider === activeCustom
                return (
                  <div
                    key={entry.provider}
                    className={`model-item-row ${active ? 'active' : ''}`}
                    onClick={() => !disabled && switchModel(entry.provider, entry.model)}
                  >
                    <button className={`model-item ${active ? 'active' : ''}`} disabled={disabled}>
                      <span className="model-item-main">
                        <span className="model-item-name">{entry.label}</span>
                        <span className="model-item-desc">{hostOf(entry.baseURL)} · {entry.model}</span>
                      </span>
                      {active && <IconCheck size={15} />}
                    </button>
                    <button className="icon-btn danger model-item-del" title="删除" onClick={e => removeCustom(e, entry)}>
                      <IconX size={13} />
                    </button>
                  </div>
                )
              })}

              {formOpen ? (
                <div className="model-custom-form">
                  <input placeholder="显示名（可选，如 火山-DeepSeek）" value={form.label}
                    onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
                  <input placeholder="Base URL（https://.../v1）" value={form.baseURL}
                    onChange={e => setForm(f => ({ ...f, baseURL: e.target.value }))} />
                  <input placeholder="API Key（可选，留空用 .env）" type="password" value={form.apiKey}
                    onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} />
                  <input placeholder="模型 ID（如 deepseek-v4-flash）" value={form.model}
                    onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitForm() }} />
                  <input placeholder="最大输出 tokens（可选，如 131072；超上限端点会报错）" value={form.maxTokens}
                    onChange={e => setForm(f => ({ ...f, maxTokens: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitForm() }} />
                  {formError && <div className="model-form-error">{formError}</div>}
                  <div className="model-custom-actions">
                    <button className="btn ghost model-form-cancel" onClick={() => setFormOpen(false)}>取消</button>
                    <button className="model-custom-ok" onClick={submitForm}>添加并切换</button>
                  </div>
                </div>
              ) : (
                <button className="model-item" disabled={disabled} onClick={() => setFormOpen(true)}>
                  <span className="model-item-main">
                    <span className="model-item-name">+ 添加自定义模型</span>
                    <span className="model-item-desc">OpenAI 兼容端点（火山/百炼/OpenRouter/vLLM 等）</span>
                  </span>
                </button>
              )}
            </div>
          </div>
          <div className="model-menu-hint">
            {running
              ? '对话进行中，结束后才能切换模型'
              : '切换模型将重启运行时，已有对话的历史会保留'}
          </div>
        </div>
      )}
    </div>
  )
}
