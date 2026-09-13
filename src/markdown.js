const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function inline(text) {
  let out = ''
  let rest = escapeHtml(text)
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((?:https?:\/\/|\.\/|\/)[^)\s]+\))/
  while (rest.length) {
    const m = pattern.exec(rest)
    if (!m) { out += rest; break }
    out += rest.slice(0, m.index)
    const token = m[0]
    if (token.startsWith('`')) {
      out += `<code>${token.slice(1, -1)}</code>`
    } else if (token.startsWith('**')) {
      out += `<strong>${token.slice(2, -2)}</strong>`
    } else {
      const label = token.slice(1, token.indexOf(']'))
      const href = token.slice(token.indexOf('(') + 1, -1)
      out += `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
    }
    rest = rest.slice(m.index + token.length)
  }
  return out
}

export function renderMarkdown(src) {
  if (!src) return ''
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inCode = false
  let codeLang = ''
  let codeLines = []
  let listOpen = false

  const closeList = () => {
    if (listOpen) { out.push('</ul>'); listOpen = false }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre data-lang="${escapeHtml(codeLang)}"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        inCode = false
        codeLines = []
      } else {
        closeList()
        inCode = true
        codeLang = line.slice(3).trim()
      }
      continue
    }
    if (inCode) { codeLines.push(line); continue }
    if (/^\s*$/.test(line)) { closeList(); continue }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!listOpen) { out.push('<ul>'); listOpen = true }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  closeList()
  return out.join('')
}

export function firstText(content) {
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block?.type === 'text' && block.text) return block.text
  }
  return ''
}

export function reasoningText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'reasoning').map(b => b.text).join('\n').trim()
}

export function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}
