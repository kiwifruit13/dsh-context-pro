/**
 * DSH-Context-Pro Client 插件：Chip 话题推荐（贴近 ship 设计）
 *
 * 设计：
 *   - 仅在有推荐话题时渲染（≤3 条），无话题零 DOM
 *   - 横向胶囊按钮，点击即发送消息（host.call conversation.send）
 *   - 相关性评分：严重度/证据/时效/链活跃/类型多样 → Top-3
 *   - SSE 实时推送（/topics/stream），话题变化即时更新
 *   - 生命周期跟 Client fiber：slot 注销 + 样式清理（ctx.effect 自动托管）
 */

// @ts-nocheck

/* eslint-disable */

const STYLES = `
.dsh-cp-chip-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 12px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsh-bg-elevated, #f8f9fa);
  border: 1px solid var(--dsh-border-subtle, #e5e7eb);
}
.dsh-cp-chip {
  border: 1px solid var(--dsh-border-subtle, #d0d7de);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  background: var(--dsh-bg-primary, #fff);
  color: var(--dsh-text-primary, #333);
  cursor: pointer;
  transition: background .15s, border-color .15s, transform .1s;
  white-space: nowrap;
}
.dsh-cp-chip:hover {
  background: var(--dsh-bg-info-subtle, #f0f6ff);
  border-color: var(--dsh-brand, #4f8ff7);
  transform: translateY(-1px);
}
.dsh-cp-chip:active {
  transform: scale(0.98);
}
.dsh-cp-chip.kind-convergence {
  border-color: var(--dsh-brand, #3b82f6);
  background: var(--dsh-bg-info-subtle, #eff6ff);
}
.dsh-cp-chip.kind-extension {
  border-color: var(--dsh-accent, #8b5cf6);
  background: var(--dsh-bg-accent-subtle, #f5f3ff);
}
.dsh-cp-chip-group:empty {
  display: none;
}
`

/**
 * 相关性评分器
 */
function scoreTopics(topics, activeChains = []) {
  const now = Date.now()
  const activeChainSet = new Set(activeChains)

  const severityWeight = { critical: 1.0, high: 0.7, medium: 0.4, low: 0.1 }

  return topics.map(t => {
    // 1) 严重度
    const sevScore = severityWeight[t.severity] ?? 0.1

    // 2) 证据强度
    const evScore = Math.min((t.evidence ?? 0) / 10, 1.0)

    // 3) 时效性（12 小时半衰期）
    const ageHours = (now - (t.timestamp ?? now)) / 3_600_000
    const timeScore = Math.exp(-ageHours / 12)

    // 4) 链活跃度
    const chainScore = activeChainSet.has(t.chain) ? 1.0 : 0.3

    // 基础分
    let score = 0.35 * sevScore + 0.25 * evScore + 0.20 * timeScore + 0.15 * chainScore

    // 5) 类型多样性惩罚（稍后按 kind 分组处理）
    t._baseScore = score
    t._kind = t.kind || 'extension'
    return t
  })
}

/**
 * 选 Top-3 并做类型多样化
 */
function selectTopChips(topics, max = 3) {
  if (!topics.length) return []

  // 先按基础分降序
  const sorted = [...topics].sort((a, b) => b._baseScore - a._baseScore)

  const selected = []
  const kindCount = {}

  for (const t of sorted) {
    if (selected.length >= max) break
    const k = t._kind
    const penalty = (kindCount[k] ?? 0) * 0.15
    const finalScore = t._baseScore - penalty

    // 只有分数为正才选
    if (finalScore > 0) {
      selected.push({ ...t, _finalScore: finalScore })
      kindCount[k] = (kindCount[k] ?? 0) + 1
    }
  }

  return selected
}

/**
 * Chip 组件（React createElement 版）
 */
function ChipGroup(props) {
  const ReactRef = typeof React !== 'undefined' ? React : null
  const useState = ReactRef && ReactRef.useState
  const useEffect = ReactRef && ReactRef.useEffect
  const useRef = ReactRef && ReactRef.useRef

  if (!useState || !useEffect) {
    return React.createElement('div', { className: 'dsh-cp-chip-group' })
  }

  const [chips, setChips] = useState([])
  const [status, setStatus] = useState('loading')
  const hostRef = useRef(props.host)
  hostRef.current = props.host

  // 发送消息（优先 host.call，降级 fetch，再降级 clipboard）
  async function sendMessage(text) {
    const host = hostRef.current
    if (host && typeof host.call === 'function') {
      try {
        await host.call('conversation.send', { text })
        return
      } catch (e) {
        console.warn('[context-pro] host.call 失败，降级 fetch:', e)
      }
    }
    // 降级：直接 POST 到会话消息端点（需鉴权，通常失败）
    try {
      await fetch('/api/conversation/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
      return
    } catch (_) { /* ignore */ }
    // 最后降级：复制到剪贴板
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    }
  }

  // 加载话题
  async function loadTopics() {
    try {
      const sessionId = props.sessionId || ''
      const url = sessionId
        ? '/api/context-pro/topics?sessionId=' + encodeURIComponent(sessionId)
        : '/api/context-pro/topics'
      const resp = await fetch(url)
      const data = await resp.json()
      const rawTopics = (data && data.topics) || []

      // 评分 + 选 Top-3
      const activeChains = Array.isArray(data.activeChains) ? data.activeChains : []
      const scored = scoreTopics(rawTopics, activeChains)
      const top = selectTopChips(scored, 3)

      setChips(top)
      setStatus(top.length ? 'ready' : 'empty')
    } catch (err) {
      setChips([])
      setStatus('error')
    }
  }

  // 挂载 + SSE 订阅
  useEffect(() => {
    loadTopics()

    // SSE 实时推送
    const sessionId = props.sessionId
    if (sessionId) {
      let es
      try {
        es = new EventSource('/api/context-pro/topics/stream?sessionId=' + encodeURIComponent(sessionId))
        es.onmessage = e => {
          try {
            const msg = JSON.parse(e.data)
            if (msg.type === 'update' && Array.isArray(msg.topics)) {
              const activeChains = Array.isArray(msg.activeChains) ? msg.activeChains : []
              const scored = scoreTopics(msg.topics, activeChains)
              const top = selectTopChips(scored, 3)
              setChips(top)
              setStatus(top.length ? 'ready' : 'empty')
            } else if (msg.type === 'snapshot') {
              const activeChains = Array.isArray(msg.activeChains) ? msg.activeChains : []
              const scored = scoreTopics(msg.topics, activeChains)
              const top = selectTopChips(scored, 3)
              setChips(top)
              setStatus(top.length ? 'ready' : 'empty')
            }
          } catch (_) {}
        }
        es.onerror = () => { if (es) es.close() }
      } catch (_) {}

      return () => { if (es) es.close() }
    }
  }, [])

  // 渲染
  if (status !== 'ready' || chips.length === 0) {
    return React.createElement('div', { className: 'dsh-cp-chip-group' })
  }

  return React.createElement('div', { className: 'dsh-cp-chip-group' },
    chips.map(t =>
      React.createElement('button', {
        key: t.question,
        className: 'dsh-cp-chip kind-' + (t.kind || 'extension'),
        onClick: () => sendMessage(t.question),
        title: t.rationale || '',
      }, t.question)
    )
  )
}

/**
 * Client 插件入口
 */
export function apply(ctx) {
  const slots = ctx.get('slots')
  const styles = ctx.get('styles')
  const host = ctx.get('host')  // DSH Client 内置 host 对象（提供 call 方法）

  if (!slots) {
    console.warn('[context-pro/client] slots 服务不可用，Chip UI 未注册')
    return
  }

  // 注入样式
  if (styles) {
    try {
      const disposeStyles = styles.insert(STYLES)
      if (disposeStyles) ctx.effect(() => disposeStyles)
    } catch (err) {
      console.warn('[context-pro/client] 样式注入失败:', err)
    }
  }

  // 注册到 conversation.input.dock（additive list 位）
  try {
    const disposeSlot = slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'context-pro-chips', order: 90 },
      (props) => React.createElement(ChipGroup, {
        host: host,
        sessionId: props.sessionId,
      })
    ))
    if (disposeSlot) ctx.effect(() => disposeSlot)
    console.log('[context-pro/client] Chip 话题已注册到 conversation.input.dock')
  } catch (err) {
    console.error('[context-pro/client] slot 注册失败:', err)
  }
}