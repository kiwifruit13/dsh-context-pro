/**
 * 链感知钩子：监听 session/event，从 user/message + assistant/message 提取链节点入库。
 *
 * session/event 是 post-commit emit（事后追加）：回调在日志 push 后运行，
 * 观察者失败被包含（不使提交失败）——适合做链提取这种附加处理。
 *
 * 三层架构（CLAUDE.md §3 胶水轻薄原则）：
 *   hook.ts（本文件，胶水层）→ 把 DSH event 转换为 SessionEventInput → InsightEngine.ingestEvent
 *   FilterSelector（过滤/选择层）→ 累积 SessionEventInput，按 InsightNeed 查询
 *   Analyzers（分析器）→ 通过 InsightNeed 表达需求，消费 InsightHistoryItem[]
 *
 * 拆分原则（8.1）：
 *   - 胶水转换 + ingestEvent：独立监听器（user + assistant 均触发）
 *   - 链提取 + 洞察分析：独立监听器（仅 assistant）
 *   - 话题便条注入：独立监听器（仅 assistant，通过 agent.inject 发独立消息）
 *
 * 禁止直接修改 session/event 事件数据（8.2）：话题便条走 agent.inject，
 * 不修改已提交的 content 数组。
 */
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChainIndex, ChainSnapshot, InsightEngine, SessionEventInput, ChangeContext, ChainChangeType, ChainGuide, ChainRole } from './types.ts'
import { createChainIndex } from './index.ts'
import { parseSnapshot } from './snapshot.ts'
import { sessionIdFromEvent } from '../session-id.ts'
import { recordChainHealth, recordTopicNoteTriggered } from '../metrics.ts'

/** Session ID 一致性检查器（运行时断言，仅在开发模式记录） */
const DEV_MODE = process.env.NODE_ENV !== 'production'
const sessionIdMismatchLog = new Map<string, number>()

function checkSessionIdConsistency(
  eventSessionId: string,
  contextLabel: string,
  ctx: Context,
): void {
  if (!DEV_MODE) return
  if (eventSessionId === 'unknown') return

  // 尝试从 agents 注册表获取对应 session，验证一致性
  try {
    const agents = ctx.get('agents') as
      | { get: (id: SessionId) => { session?: { id?: unknown }; id?: unknown } | undefined }
      | undefined
    if (agents) {
      const agent = agents.get(SessionId(eventSessionId))
      if (agent) {
        const agentSessionId = agent.session?.id ?? agent.id
        if (agentSessionId !== undefined && String(agentSessionId) !== eventSessionId) {
          const key = `${eventSessionId}->${agentSessionId}`
          const count = (sessionIdMismatchLog.get(key) ?? 0) + 1
          sessionIdMismatchLog.set(key, count)
          if (count <= 3) {
            // 限制日志频率，避免刷屏
            ctx.logger('context-pro').warn(
              `[SessionID一致性] ${contextLabel}: event.sessionId="${eventSessionId}" !== agent.sessionId="${agentSessionId}" (第 ${count} 次)`
            )
          }
        }
      }
    }
  } catch {
    // 忽略检查过程中的错误，不影响主流程
  }
}

/** 提取 message content 块的纯文本（拼接所有 text 块） */
function extractText(content: unknown[]): string {
  return content
    .map((b) => (b as { type?: string; text?: string }).text ?? '')
    .join('')
}

/** 从文本中解析末尾 JSON 快照行（如无则返回 undefined） */
function extractSnapshot(text: string): ChainSnapshot | undefined {
  return parseSnapshot(text) ?? undefined
}

/**
 * 胶水转换：DSH session/event → SessionEventInput
 * 只做类型转换 + 文本拼接 + 快照解析，不含业务规则（CLAUDE.md §3.1）
 */
function eventToInput(event: { type: string; data: unknown }): SessionEventInput | null {
  if (event.type === 'assistant/message') {
    const msg = event.data as { message?: { content?: unknown[] } }
    const content = msg.message?.content ?? []
    const text = extractText(content)
    if (!text) return null
    return {
      type: event.type,
      text,
      role: 'assistant',
      timestamp: Date.now(),
      snapshot: extractSnapshot(text),
    }
  }
  if (event.type === 'user/message') {
    const msg = event.data as { content?: unknown[] }
    const content = msg.content ?? (msg as { message?: { content?: unknown[] } }).message?.content ?? []
    const text = extractText(content)
    if (!text) return null
    return {
      type: event.type,
      text,
      role: 'user',
      timestamp: Date.now(),
      // user/message 一般不含快照行，跳过解析以省性能
    }
  }
  return null
}

export function registerChainHook(
  ctx: Context,
  enabled = true,
  maxNodesPerChain?: number,
  insightEngine?: InsightEngine,
): ChainIndex {
  const index = createChainIndex(maxNodesPerChain !== undefined ? { maxNodesPerChain } : {})

  /** 记录上一轮图状态（用于 P1 变更检测：terminal-filled/emptied, divergence, structure） */
  const prevGraphs = new Map<string, { guide: ChainGuide; snapshot?: ChainSnapshot; nodesSize: number }>()

  if (enabled) {
    // ─── 监听器 ①：胶水转换 + ingestEvent（user + assistant 均触发） ───
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'assistant/message' && event.type !== 'user/message') return
      const sessionId = sessionIdFromEvent(_session)
      checkSessionIdConsistency(sessionId, 'ingestEvent', ctx)
      const input = eventToInput(event)
      if (input) {
        insightEngine?.ingestEvent(sessionId, input)
      }
    })

    // ─── 监听器 ②：链提取 + 洞察分析（仅 assistant） ───
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'assistant/message') return

      const sessionId = sessionIdFromEvent(_session)
      checkSessionIdConsistency(sessionId, 'chainExtract', ctx)
      const msg = event.data as { message?: { id?: string; content?: unknown[] } }
      const content = msg.message?.content ?? []
      const text = extractText(content)
      if (!text) return

      const messageLike = {
        id: String(msg.message?.id ?? `evt-${Date.now()}`),
        role: 'user' as const,
        content: content as never,
        source: { kind: 'plugin' as const, plugin: 'dsh-context-pro' },
      }
      const anchors = index.ingest(sessionId, messageLike as never)
      if (anchors.length > 0) {
        ctx.logger('context-pro').info(`链提取: ${anchors.length} 锚点 @ session ${sessionId}`)
      }

      // 链图健康度指标（9.2）
      const g = index.graph(sessionId)
      if (g) {
        const activeNodes = [...g.nodes.values()].filter(n => n.status === 'active')
        const activeChains = new Set(
          [...g.nodes.values()]
            .filter(n => n.status === 'active' && !n.parent)
            .map(n => n.id.split('@')[0]),
        )
        recordChainHealth({
          activeChains: activeChains.size,
          totalNodes: g.nodes.size,
          supersededNodes: g.nodes.size - activeNodes.length,
          endedChains: g.endedRoots.size,
        })
      }

      // 洞察引擎：每轮回复后分析（超然层，只建议不干预）
      if (insightEngine) {
        const guide = index.guide(sessionId)
        if (g && guide) {
          const snapshot = extractSnapshot(text)

          // P1 选择性分析器：计算变更上下文
          const prev = prevGraphs.get(sessionId)
          const changeContext: ChangeContext = {
            changes: new Set<ChainChangeType>(),
            prevSnapshot: prev?.snapshot,
            currSnapshot: snapshot,
            isFirstRound: prev === undefined,
          }

          // 检测图级变更（需对比前后 guide）
          if (prev) {
            // terminal-filled / emptied
            const prevGaps = new Set<ChainRole>(prev.guide.primary?.gaps ?? [])
            const currGaps = new Set<ChainRole>(guide.primary?.gaps ?? [])
            for (const gap of currGaps) {
              if (!prevGaps.has(gap)) changeContext.changes.add('terminal-filled')
            }
            for (const gap of prevGaps) {
              if (!currGaps.has(gap)) changeContext.changes.add('terminal-emptied')
            }
            // divergence-detected: 同链多路径活跃
            for (const [, node] of g.nodes) {
              if (node.status === 'active' && node.children && node.children.length > 1) {
                changeContext.changes.add('divergence-detected')
              }
            }
            // structure-changed: 拓扑变化（简化：节点数变化 > 2）
            if (Math.abs(g.nodes.size - prev.nodesSize) > 2) {
              changeContext.changes.add('structure-changed')
            }
          }

          insightEngine.analyze(sessionId, g, guide, snapshot ?? null, changeContext)

          // 更新上一轮图状态
          prevGraphs.set(sessionId, { guide, snapshot, nodesSize: g.nodes.size })
        }
      }
    })

    // ─── 监听器 ③：话题便条注入（仅 assistant，通过 agent.inject 发独立消息） ───
    // 不修改已提交的 session/event 数据（8.2），改用 agent.inject 注入独立用户消息
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'assistant/message') return
      if (!insightEngine) return

      const sessionId = sessionIdFromEvent(_session)
      checkSessionIdConsistency(sessionId, 'topicNote', ctx)

      if (insightEngine.isClientActive(sessionId)) return
      const topics = insightEngine.getTopics(sessionId)
      if (topics.length === 0) return

      const sorted = [...topics].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'convergence' ? -1 : 1
        return b.timestamp - a.timestamp
      })
      const picked = sorted.slice(0, 3)
      const lines = picked.map(
        (t) => `${t.kind === 'convergence' ? '▸' : '◆'} ${t.question}`,
      )

      // 通过 agent.inject 注入独立用户消息（不修改已提交的 assistant 事件数据）
      const agents = ctx.get('agents') as { get: (id: unknown) => { inject: (msg: unknown) => void } | undefined } | undefined
      if (agents) {
        const agent = agents.get(SessionId(sessionId))
        if (agent) {
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: `[洞察引擎] 观察到一些可能值得探索的方向，供参考（非指令）：\n${lines.join('\n')}` }],
            source: { kind: 'plugin', plugin: 'dsh-context-pro' },
          }))
          recordTopicNoteTriggered()
        }
      }
    })

    // 生命周期：会话结束/删除 → 清空链图 + 洞察存储 + FilterSelector 累积（一并销毁，无残留）
    ctx.on('session/disposed', (session) => {
      const sessionId = sessionIdFromEvent(session)
      const startTime = Date.now()
      index.dispose(sessionId)
      insightEngine?.dispose(sessionId)
      const duration = Date.now() - startTime
      if (duration > 10) {
        ctx.logger('context-pro').warn(`[诊断] session/disposed 清理耗时 ${duration}ms (session: ${sessionId})`)
      } else {
        ctx.logger('context-pro').info(`[诊断] session/disposed 清理完成 ${duration}ms (session: ${sessionId})`)
      }
    })
  }

  return index
}