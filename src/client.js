/**
 * DSH-Context-Pro Client 插件：在输入区下方渲染可点击的话题卡片。
 *
 * 设计：
 *   - Host 侧通过 HTTP 端点暴露 /api/context-pro/topics / mark-active / fill-input
 *   - Client 注册到 conversation.input.dock slot（additive 位，不替换出厂 UI）
 *   - 使用浏览器 fetch() 直接调用 HTTP 端点，不依赖动态插件 RPC 桥接
 *   - 用户点击卡片 → fetch POST /api/context-pro/fill-input（降级显示可复制文本）
 *   - 定时轮询（每 5 秒）确保话题随分析轮次增量更新
 *
 * Builtin：ctx / React（createElement + hooks）/ styles / console
 * 无 window/document/setTimeout：定时器走 ctx.get('timer')，无则不延迟
 * 通信走 fetch（标准浏览器 API），无 host / host.call 依赖
 *
 * 生命周期跟 Client fiber：卸载时 slot 注销 + 样式清理（ctx.effect 自动托管）。
 */

// @ts-nocheck

/* eslint-disable */

/** 卡片样式（主题色用 DSH CSS 变量，降级用硬编码色值） */
const STYLES = `
.dsh-cp-topics {
  margin: 8px 0 12px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsh-bg-elevated, #f8f9fa);
  border: 1px solid var(--dsh-border-subtle, #e5e7eb);
  font-size: 13px;
}
.dsh-cp-topics-title {
  font-size: 12px;
  color: var(--dsh-text-secondary, #6b7280);
  margin-bottom: 8px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}
.dsh-cp-topics-refresh {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--dsh-text-tertiary, #9ca3af);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.dsh-cp-topics-refresh:hover {
  color: var(--dsh-text-primary, #1f2937);
  background: var(--dsh-bg-hover, rgba(0,0,0,0.05));
}
.dsh-cp-topic-card {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  margin: 4px 0;
  border-radius: 6px;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--dsh-text-primary, #1f2937);
  font-size: 13px;
  line-height: 1.5;
  transition: background 0.15s ease, filter 0.15s ease;
  border-left: 3px solid transparent;
}
.dsh-cp-topic-card.convergence {
  border-left-color: var(--dsh-brand, #3b82f6);
  background: var(--dsh-bg-info-subtle, #eff6ff);
}
.dsh-cp-topic-card.extension {
  border-left-color: var(--dsh-accent, #8b5cf6);
  background: var(--dsh-bg-accent-subtle, #f5f3ff);
}
.dsh-cp-topic-card:hover {
  filter: brightness(0.95);
}
.dsh-cp-topic-card-copied {
  background: var(--dsh-bg-success-subtle, #ecfdf5) !important;
  border-left-color: var(--dsh-success, #10b981) !important;
  color: var(--dsh-success, #10b981) !important;
}
.dsh-cp-topic-empty {
  color: var(--dsh-text-tertiary, #9ca3af);
  font-size: 12px;
  padding: 6px 0;
}
.dsh-cp-fallback {
  margin-top: 8px;
  padding: 8px;
  background: var(--dsh-bg-warning-subtle, #fffbeb);
  border: 1px solid var(--dsh-border-warning, #fde68a);
  border-radius: 4px;
  font-size: 12px;
  color: var(--dsh-text-primary, #1f2937);
}
.dsh-cp-fallback textarea {
  width: 100%;
  min-height: 60px;
  font-family: inherit;
  font-size: 12px;
  padding: 4px;
  margin-top: 4px;
  border: 1px solid var(--dsh-border-subtle, #e5e7eb);
  border-radius: 4px;
  background: var(--dsh-bg-primary, #ffffff);
  color: var(--dsh-text-primary, #1f2937);
  resize: vertical;
}
`

/**
 * 话题卡片组件（函数组件 + hooks）
 *
 * 状态：
 *   - topics: RecommendationTopic[]
 *   - status: 'loading' | 'ready' | 'error'
 *   - fallbackText: 当 fill-input 失败时显示的可复制文本
 *   - clientActive: 是否已标记 Client 激活（避免重复调用 markClientActive）
 *
 * 设计：
 *   - 挂载时加载一次 + 定时轮询（每 5 秒），确保话题随分析轮次更新
 *   - 首次成功加载后调用 markClientActive，关闭该会话的便条通道
 *   - sessionId 从 slot 标准 props 传入，确保会话级隔离
 */
function TopicsWidget(props) {
  const timer = props.timer
  // sessionId 来自 slot 标准 props（conversation.input.dock 提供）
  var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''

  // React hooks（DSH Builtin React 应该完整支持；不支持则降级为静态渲染）
  const ReactRef = typeof React !== 'undefined' ? React : null
  const useState = ReactRef && ReactRef.useState
  const useEffect = ReactRef && ReactRef.useEffect
  const useRef = ReactRef && ReactRef.useRef

  // 没有 hooks：降级为静态渲染（只显示一个提示）
  if (!useState || !useEffect) {
    return React.createElement('div', { className: 'dsh-cp-topics' },
      React.createElement('div', { className: 'dsh-cp-topics-title' }, '💡 你可能想问'),
      React.createElement('div', { className: 'dsh-cp-topic-empty' },
        '话题加载需要 React hooks 支持，当前环境不可用')
    )
  }

  const [topics, setTopics] = useState([])
  const [status, setStatus] = useState('loading')
  const [copiedIdx, setCopiedIdx] = useState(null)
  // 用 ref 追踪是否已标记 active，避免重复调用
  const activeMarked = useRef(false)

  // 异步加载话题
  async function loadTopics() {
    try {
      const url = sessionId
        ? '/api/context-pro/topics?sessionId=' + encodeURIComponent(sessionId)
        : '/api/context-pro/topics'
      var response = await fetch(url)
      var result = await response.json()
      var list = (result && result.topics) || []
      setTopics(list)
      setStatus('ready')
      setCopiedIdx(null)

      // Bug 3 修复：首次成功加载话题后标记 Client 激活
      // 不在 apply() 里调用，而是在话题数据真正可用之后
      if (sessionId && !activeMarked.current) {
        try {
          await fetch('/api/context-pro/mark-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId }),
          })
          activeMarked.current = true
          console.log('[context-pro/client] 已标记 Client 激活，会话', sessionId.slice(0, 8))
        } catch (markErr) {
          console.warn('[context-pro/client] mark-active 失败:', markErr)
        }
      }
    } catch (err) {
      setTopics([])
      setStatus('error')
    }
  }

  // Bug 2 修复：挂载时加载 + 定时轮询
  // 轮询间隔 5 秒，topic 随 analyze() 增量更新
  useEffect(function() {
    // 首次加载
    loadTopics()

    // 定时轮询：仅当 timer 可用时
    if (timer && typeof timer.interval === 'function') {
      var dispose = timer.interval(function() {
        loadTopics()
      }, 5000)
      return dispose  // 卸载时清理定时器
    } else if (timer && typeof timer.setTimeout === 'function') {
      // 降级：用递归 setTimeout 模拟 interval
      var dispose
      function poll() {
        loadTopics()
        dispose = timer.setTimeout(poll, 5000)
      }
      dispose = timer.setTimeout(poll, 5000)
      return function() {
        if (typeof dispose === 'function') dispose()
      }
    }
    // 无 timer 服务：不轮询，只靠手动刷新按钮
  }, [])

  // 点击卡片：复制话题到剪贴板（InputZone 只读，无法写回输入框；copy 是标准替代）
  function handleCardClick(idx, topic) {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(topic.question).then(function() {
        setCopiedIdx(idx)
        if (timer && typeof timer.setTimeout === 'function') {
          timer.setTimeout(function() { setCopiedIdx(null) }, 2000)
        }
      }).catch(function() {
        // 剪贴板 API 不可用（如非 HTTPS）→ 走 textarea fallback
        setFallbackText(topic.question)
      })
    } else {
      setFallbackText(topic.question)
    }
  }

  // 子元素
  const children = [
    React.createElement('div', { className: 'dsh-cp-topics-title', key: 'title' }, [
      '💡 你可能想问',
      React.createElement('button', {
        key: 'refresh',
        className: 'dsh-cp-topics-refresh',
        onClick: loadTopics,
        title: '刷新话题',
      }, '↻'),
    ]),
  ]

  if (status === 'loading') {
    children.push(
      React.createElement('div', { className: 'dsh-cp-topic-empty', key: 'loading' }, '加载中…')
    )
  } else if (status === 'error') {
    children.push(
      React.createElement('div', { className: 'dsh-cp-topic-empty', key: 'error' }, '话题加载失败')
    )
  } else if (topics.length === 0) {
    children.push(
      React.createElement('div', { className: 'dsh-cp-topic-empty', key: 'empty' }, '当前无话题建议')
    )
  } else {
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i]
      const isCopied = copiedIdx === i
      const cls = 'dsh-cp-topic-card ' + (t.kind || 'extension') + (isCopied ? ' dsh-cp-topic-card-copied' : '')
      children.push(React.createElement('button', {
        key: 'topic-' + i,
        className: cls,
        onClick: () => handleCardClick(i, t),
        title: t.rationale || '',
      }, isCopied ? '✓ ' + t.question : t.question))
    }
  }

  if (fallbackText) {
    children.push(
      React.createElement('div', { className: 'dsh-cp-fallback', key: 'fallback' }, [
        '剪贴板不可用，请手动复制：',
        React.createElement('textarea', {
          key: 'ta',
          defaultValue: fallbackText,
          readOnly: true,
        }),
      ])
    )
  }

  return React.createElement('div', { className: 'dsh-cp-topics' }, children)
}

/**
 * Client 插件入口
 * @param {Object} ctx - DSH Client Context（提供 get/effect）
 */
export function apply(ctx) {
  const slots = ctx.get('slots')
  const styles = ctx.get('styles')
  const timer = ctx.get('timer')

  if (!slots) {
    console.warn('[context-pro/client] slots 服务不可用，Client UI 未注册')
    return
  }

  // 注入样式（随 fiber 卸载清理）
  if (styles) {
    try {
      const disposeStyles = styles.insert(STYLES)
      if (disposeStyles) ctx.effect(() => disposeStyles)
    } catch (err) {
      console.warn('[context-pro/client] 样式注入失败：', err)
    }
  }

  // 注册到 conversation.input.dock（list 位，additive，不替换出厂 UI）
  // slot 标准 props 包含 sessionId，透传给 TopicsWidget
  // 通信走 HTTP（fetch /api/context-pro/*），不再依赖 host.call RPC
  try {
    const disposeSlot = slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'context-pro-topics', order: 100 },
      (props) => React.createElement(TopicsWidget, {
        timer: timer,
        sessionId: props.sessionId,
      })
    ))
    if (disposeSlot) ctx.effect(() => disposeSlot)
    console.log('[context-pro/client] 话题卡片已注册到 conversation.input.dock')
  } catch (err) {
    console.error('[context-pro/client] slot 注册失败：', err)
  }
}
