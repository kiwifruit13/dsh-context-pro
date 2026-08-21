/**
 * DSH-Context-Pro 插件入口。
 *
 * 定位：DSH Agent 的链感知系统 + 洞察引擎（超然层）。
 * 能力：链感知上下文（5 链图鉴 + JSON 快照提取）+ 洞察引擎（超然层，只建议不干预）。
 *
 * Client UI 通信走 HTTP（webServer.register），不依赖动态插件——持久化，重启不丢失。
 */
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Config, type Config as ConfigSchema } from './config.ts'
import { registerPreStepHook } from './prestep.ts'
import { registerChainHook } from './chains/hook.ts'
import { registerChainProtocol } from './chains/prompt.ts'
import { registerProjectSkills } from './skills.ts'
import { createInsightEngine } from './chains/insight.ts'
import type { InsightEngine, InsightType, InsightConfig, RecommendationTopic } from './chains/types.ts'
import { registerOpenAPIEndpoint } from './openapi.ts'
import { createAuthMiddleware, withAuth } from './auth.ts'
import { sessionIdFromExec, normalizeSessionId } from './session-id.ts'
import { getAllMetrics, recordInsightToolCall } from './metrics.ts'
// 伴生不变式插件（自动注册到 dsh-invariants）
import './invariant.ts'

export const name = 'context-pro'
/** The agent registry that owns pre-step processing（服务名 camelCase，非 cordis.yml 条目 id） */
export const inject = ['agents']

const DEV_MODE = process.env.NODE_ENV !== 'production'

export function apply(ctx: Context, config: ConfigSchema = {}): void {
  const logger = ctx.logger('context-pro')
  const chains = config.chains
  const chainsEnabled = chains?.enabled ?? false
  const injectProtocol = chains?.injectProtocol ?? false
  // 洞察引擎：依赖 chains.enabled，关闭链感知时强制关闭洞察
  const insightEnabled = chainsEnabled && (chains?.insight?.enabled ?? false)

  logger.info(
    `启动: chains=${chainsEnabled}, protocol=${injectProtocol}, insight=${insightEnabled}`,
  )

  // 打标协议提示词段（chains.injectProtocol 时注入；disposer 挂 effect 随 fiber 回卷）
  if (chainsEnabled && injectProtocol) {
    const dispose = registerChainProtocol(ctx)
    if (dispose) {
      ctx.effect(() => dispose)
      logger.info('打标协议提示词段已注入')
    } else {
      logger.warn('systemPrompt 服务不可用，打标协议未注入')
    }
  }

  // 注册项目技能（AGENTS.md + CLAUDE.md + Architectural-Thinking.md + Integrated-Catalysis.md，可选依赖，静默跳过）
  registerProjectSkills(ctx, logger).then((ok) => {
    if (ok) logger.info('项目技能已注册（agent-principles + api-contract-guide + architectural-thinking + integrated-catalysis + chain-fusion-advanced + insight-engine + hook-tool-data-flow）')
  })

  // 洞察引擎（超然层：只观察、只建议、不干预 CoT）
  let insightEngine: InsightEngine | undefined
  if (insightEnabled) {
    const insightConfig: InsightConfig = chains?.insight ?? {}
    insightEngine = createInsightEngine(ctx.logger('context-pro'), insightConfig)
    registerInsightTool(ctx, insightEngine)
    // HTTP 端点：Client UI 通过 webServer 直接通信，不再依赖动态插件
    registerInsightHTTP(ctx, insightEngine, logger, {
      auth: insightConfig.auth,
      rateLimit: insightConfig.rateLimit,
    })
    logger.info('洞察引擎已启动（超然层）')
  }

  // 链感知钩子（会话内临时链索引；enabled 时监听 session/event；每链节点上限透传）
  const chainIndex = registerChainHook(ctx, chainsEnabled, chains?.maxNodesPerChain, insightEngine)

  // 注册 pre-step 拦截器（链协议模式零干预，仅防御性兜底；副作用随 fiber 自动回卷）
  registerPreStepHook(ctx)
}

// ---------------------------------------------------------------------------
// get_insights 工具注册（模型按需调取洞察建议，参考性质非约束）
// ---------------------------------------------------------------------------

/** 注册 get_insights tool（可选依赖 ctx.tools；缺失静默跳过） */
function registerInsightTool(ctx: Context, engine: InsightEngine): void {
  const tools = ctx.get('tools') as
    | { register: (def: ToolDefinition) => () => void }
    | undefined
  if (!tools) {
    ctx.logger('context-pro').warn('ctx.tools 不可用，get_insights 工具未注册')
    return
  }

  const dispose = tools.register({
    name: 'get_insights',
    description:
      '获取当前会话的认知洞察建议（链间化学反应/迁移预测/置信度趋势/缺口聚合/分歧收敛）。' +
      '每条洞察附带 confidenceProfile（节点证据 + 边证据 + 反证 + 综合评分 attributionScore）——' +
      '帮助你判断"这条洞察为什么这样判断、可信度多少"。' +
      '参考性质，非约束——你可以采纳也可以忽略。' +
      '当对话累积了 3 轮以上、或用户问题涉及多维度分析时调用，能提升回答的深度和全局性。' +
      '建议在回复末尾对洞察做简要回应（不强制），让用户感知到 AI 的主动思考。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            '筛选洞察类型（可选）：cross-reaction / migration / confidence-trend / gap-aggregation / divergence-watch。不传则返回全部。',
        },
        minScore: {
          type: 'number',
          description:
            '按 attributionScore 过滤（如 0.7 = 只看高可信度洞察）。范围 0-1，不传则不过滤。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          insights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                severity: { type: 'string' },
                title: { type: 'string' },
                detail: { type: 'string' },
                references: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      scopeKey: { type: 'string' },
                      chain: { type: 'string' },
                      root: { type: 'number' },
                      role: { type: 'string' },
                      nodeIds: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
                evidence: { type: 'number' },
                timestamp: { type: 'number' },
                confidenceProfile: {
                  type: 'object',
                  properties: {
                    attributionScore: { type: 'number' },
                    rationale: { type: 'string' },
                    nodeEvidenceCount: { type: 'number' },
                    edgeEvidenceCount: { type: 'number' },
                    contradictingCount: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { insights?: Array<{ title: string; detail: string; severity: string; evidence?: number; confidenceProfile?: { attributionScore: number; rationale: string } }> }
        const parts: { type: 'text'; text: string }[] = []
        if (v.insights && v.insights.length > 0) {
          parts.push({
            type: 'text',
            text: `## 认知洞察（带归因档案，建议，非约束）\n${v.insights
              .map((i) => {
                const score = i.confidenceProfile?.attributionScore
                const rationale = i.confidenceProfile?.rationale
                return (
                  `- [${i.severity}] ${i.title}：${i.detail}${i.evidence ? `（证据 ${i.evidence}）` : ''}` +
                  (typeof score === 'number'
                    ? `\n  - 归因：${rationale ?? ''}（attributionScore=${score.toFixed(2)}）`
                    : '')
                )
              })
              .join('\n')}`,
          })
        }
        if (parts.length === 0) {
          parts.push({ type: 'text', text: '当前无洞察建议。' })
        }
        return parts
      },
    },
    async execute(args: { type?: string; minScore?: number }, exec: ToolRunContext) {
      const sessionId = sessionIdFromExec(exec)
      // 开发模式下：验证 tool 上下文的 sessionId 与 engine 存储键一致
      if (DEV_MODE && sessionId !== 'unknown') {
        const hasStore = engine.hasStore(sessionId)
        if (!hasStore) {
          ctx.logger('context-pro').warn(
            `[SessionID一致性] get_insights: tool.sessionId="${sessionId}" 在 engine 中无存储（可能 agent/session 引用不一致）`
          )
        }
      }
      const typeFilter = (args.type ?? undefined) as InsightType | undefined
      let insights = engine.getInsights(sessionId, typeFilter)
      if (typeof args.minScore === 'number') {
        insights = insights.filter(
          (i) => (i.confidenceProfile?.attributionScore ?? 0) >= args.minScore!,
        )
      }
      recordInsightToolCall(insights.length > 0)
      return { insights }
    },
  } satisfies ToolDefinition)

  ctx.effect(() => dispose)
}

// ---------------------------------------------------------------------------
// HTTP 端点注册（Client UI 通信：持久化，不依赖动态插件）
// ---------------------------------------------------------------------------

/** 读取请求体（Buffer 拼接） */
function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => reject(err))
  })
}

/** 写入 JSON 响应 */
function jsonResponse(
  res: import('http').ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** 注册 Client UI 通信用的 HTTP 端点（可选依赖 webServer；缺失静默跳过） */
function registerInsightHTTP(
  ctx: Context,
  engine: InsightEngine,
  logger: ReturnType<typeof ctx.logger>,
  insightConfig: { auth?: { enabled?: boolean; keys?: string[]; keyHashes?: string[]; headerName?: string; queryParam?: string; skipPaths?: string[] }; rateLimit?: { maxRequests?: number; windowMs?: number } } = {},
): void {
  const webServer = ctx.get('webServer') as
    | { register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void | Promise<void> }) => () => void }
    | undefined
  if (!webServer) {
    logger.warn('webServer 不可用，Client UI HTTP 端点未注册')
    return
  }

  // 鉴权 + 限流中间件
  const authMiddleware = createAuthMiddleware(
    { enabled: false, ...insightConfig.auth },
    { maxRequests: 100, windowMs: 60_000, ...insightConfig.rateLimit },
  )
  const wrap = (handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void | Promise<void>) =>
    withAuth(handler, authMiddleware)

  // GET /api/context-pro/topics?sessionId=xxx → 返回指定会话的推荐话题
  const disposeTopics = webServer.register({
    kind: 'exact',
    path: '/api/context-pro/topics',
    handler: wrap((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!sessionId || sessionId.length < 4 || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        jsonResponse(res, 400, { ok: false, error: '无效 sessionId（必须是非空字母数字字符串）' })
        return
      }
      const topics = engine.getTopics(sessionId)
      jsonResponse(res, 200, { topics })
    }),
  })
  ctx.effect(() => disposeTopics)

  // GET /api/context-pro/stats → 返回全量可观测性指标（阶段 9）
  const disposeStats = webServer.register({
    kind: 'exact',
    path: '/api/context-pro/stats',
    handler: wrap((_req, res) => {
      jsonResponse(res, 200, getAllMetrics())
    }),
  })
  ctx.effect(() => disposeStats)

  // POST /api/context-pro/mark-active → 标记某会话的 Client 已激活
  const disposeMarkActive = webServer.register({
    kind: 'exact',
    path: '/api/context-pro/mark-active',
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') {
        jsonResponse(res, 405, { ok: false, error: 'Method Not Allowed' })
        return
      }
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as Record<string, unknown>
        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        if (!sessionId || sessionId.length < 4 || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
          jsonResponse(res, 400, { ok: false, error: 'body.sessionId 必须是有效的会话 ID（非空字母数字字符串）' })
          return
        }
        engine.markClientActive(sessionId)
        logger.info(`[HTTP] Client 已激活: session ${sessionId.slice(0, 8)}`)
        jsonResponse(res, 200, { ok: true })
      } catch (err) {
        logger.warn('[HTTP] mark-active 解析失败:', err)
        jsonResponse(res, 400, { ok: false, error: '请求体必须是合法 JSON' })
      }
    }),
  })
  ctx.effect(() => disposeMarkActive)

  logger.info('HTTP 端点已注册（/api/context-pro/topics / mark-active）')

  // SSE 实时推送话题：GET /api/context-pro/topics/stream?sessionId=xxx
  // 仅当 P1 选择性分析器产出新话题时推送（避免空推送）
  const disposeStream = webServer.register({
    kind: 'exact',
    path: '/api/context-pro/topics/stream',
    handler(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const connSessionId = normalizeSessionId(url.searchParams.get('sessionId') ?? '')
      if (!connSessionId || connSessionId.length < 4 || !/^[a-z0-9_-]+$/.test(connSessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '无效 sessionId' }))
        return
      }

      // SSE 响应头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
      })
      res.write('\n') // 预热连接

      const send = (data: unknown) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      // 首次发送当前快照——返回连接会话的快照，而非 lastSessionId
      send({ type: 'snapshot', topics: engine.getTopics(connSessionId), lastSessionId: connSessionId, evicted: !engine.hasStore(connSessionId) })

      // P2：事件总线订阅（替代轮询）——仅该 session 变更时推送
      const unsubscribe = engine.on('topics-changed', ({ sessionId, topics }) => {
        if (sessionId === connSessionId) { // 仅推送当前连接关注的 session
          send({ type: 'update', topics, lastSessionId: sessionId, evicted: false })
        }
      })

      // 连接关闭清理
      req.on('close', () => {
        unsubscribe()
      })
    },
  })
  ctx.effect(() => disposeStream)

  // 批量查询话题：POST /api/context-pro/topics/batch { sessionIds: string[] }
  // 受 maxTopics 限制，返回 { sessionId, topics: TopicsResult }[]
  const disposeBatch = webServer.register({
    kind: 'exact',
    path: '/api/context-pro/topics/batch',
    async handler(req, res) {
      if (req.method !== 'POST') {
        jsonResponse(res, 405, { ok: false, error: 'Method Not Allowed' })
        return
      }
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as Record<string, unknown>
        const sessionIds = Array.isArray(parsed.sessionIds) ? parsed.sessionIds : []
        if (sessionIds.length === 0 || sessionIds.length > 50) {
          jsonResponse(res, 400, { ok: false, error: 'sessionIds 必须为 1-50 项数组' })
          return
        }
        // P3：字段投影（可选 fields=title,severity,question 裁剪响应体积）
        const fieldsParam = typeof parsed.fields === 'string' ? parsed.fields : ''
        const allowedFields = new Set(['sessionId', 'topics', 'lastSessionId', 'evicted', 'hasTopics'])
        const projectFields = fieldsParam
          .split(',')
          .map((f) => f.trim())
          .filter((f) => allowedFields.has(f))
        const includeAll = projectFields.length === 0

        const validIds = sessionIds.filter(
          (id): id is string => typeof id === 'string' && id.length >= 4 && /^[a-zA-Z0-9_-]+$/.test(id)
        )
        const results = validIds.map((id) => {
          const topics = engine.getTopics(id)
          const full = {
            sessionId: id,
            topics,
            lastSessionId: id,
            evicted: !engine.hasStore(id),
            hasTopics: engine.hasTopics(id),
          }
          return includeAll ? full : Object.fromEntries(Object.entries(full).filter(([k]) => projectFields.includes(k)))
        })
        jsonResponse(res, 200, { results })
      } catch (err) {
        logger.warn('[HTTP] batch 解析失败:', err)
        jsonResponse(res, 400, { ok: false, error: '请求体必须是合法 JSON' })
      }
    },
  })
  ctx.effect(() => disposeBatch)

  logger.info('HTTP 端点已注册（/api/context-pro/topics / topics/stream / topics/batch / mark-active）')

  // OpenAPI 3.1 规范文档（开发环境建议开启）
  registerOpenAPIEndpoint(ctx, logger)
}
