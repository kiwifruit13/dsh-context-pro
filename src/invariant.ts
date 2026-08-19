/**
 * DSH-Context-Pro 不变式伴生插件。
 * 向 @deepseek-ai/dsh-invariants 注册运行时不变式检查。
 * @module @kiwifruit/dsh-context-pro/invariant
 */
import type { Context, Service } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@kiwifruit/dsh-context-pro'

/** Cordis companion plugin name. */
export const name = 'context-pro-invariant'
/** 需要先于伴生插件加载的服务。 */
export const inject = ['invariants']

/** InvariantRegistry 服务接口（避免直接依赖 dsh-invariants 包） */
interface InvariantRegistry extends Service {
  register(packageName: string, installer: InvariantInstaller): () => void
}

/** 不变式安装器类型 */
type InvariantInstaller = (
  ctx: Context,
  fail: (message: string) => never
) => void | Promise<void>

/**
 * 不变式检查器集合。
 * @param ctx - 子上下文（可访问 agents 等服务）
 * @param fail - 报告违规的函数，抛出 InvariantError
 */
const install: InvariantInstaller = (ctx, fail) => {
  // 1. sessionId 一致性不变式：session/event 的 _session.id 与 exec.agent.session.id 必须一致
  ctx.on('session/event', (_session: unknown, event: { type: string }) => {
    if (event.type !== 'assistant/message' && event.type !== 'user/message') return
    const eventSessionId = String((_session as { id?: unknown }).id ?? '')
    if (!eventSessionId || eventSessionId === 'unknown') return

    // 尝试从 agents 注册表获取对应 agent，验证 sessionId 一致性
    const agents = ctx.get('agents') as
      | { get: (id: string) => { session?: { id?: unknown }; id?: unknown } | undefined }
      | undefined
    if (!agents) return

    const agent = agents.get(eventSessionId)
    if (!agent) return

    const agentSessionId = String(agent.session?.id ?? agent.id ?? '')
    if (agentSessionId && agentSessionId !== eventSessionId) {
      fail(
        `sessionId 不一致: session/event._session.id="${eventSessionId}" !== agent.session.id="${agentSessionId}"`
      )
    }
  })

  // 2. insightEngine 存储键标准化不变式：所有存储键必须是归一化后的小写无空白字符串
  ctx.on('session/disposed', (session: unknown) => {
    const sessionId = String((session as { id?: unknown }).id ?? '')
    if (!sessionId || sessionId === 'unknown') return

    // 验证 sessionId 格式：小写、无空白、长度 <= 128
    const normalized = sessionId.trim().toLowerCase().slice(0, 128)
    if (sessionId !== normalized) {
      fail(
        `insightEngine 存储键未标准化: 原始="${sessionId}" 标准化后="${normalized}"`
      )
    }
  })

  // 3. 洞察引擎内存保护不变式：单会话洞察/话题数不得超过配置上限
  // 通过定期检查 stores Map 实现（依赖 insightEngine 暴露的检查方法）
  // 注意：insightEngine 是内部对象，这里仅作演示，实际需通过服务暴露检查接口
}

/** 扩展 Context 类型以包含 invariants 服务 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    invariants?: InvariantRegistry
  }
}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants?.register(PACKAGE_NAME, install) ?? (() => {}))

export default { name, inject, apply }