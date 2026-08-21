/**
 * 统一 session ID 获取工具（8.3 架构优化）。
 *
 * 原则：Session 对象的 id（session.header.id 的 getter）是唯一真相源。
 * Agent 对象的 id 是构造时的投影，理论上相等，但实际运行时可能因
 * exec.agent 未定义/代理包装等原因出现偏差。
 *
 * 身份获取优先级（从高到低）：
 *   1. agent.session.id（推荐，与 session/event 同一来源）
 *   2. agent.id（888.md 保证相等，但可能因边缘路径不可用）
 *   3. 'unknown'（兜底，并记录诊断信息）
 */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 诊断上下文接口 */
interface SessionIdDiagnosticContext {
  source: 'event' | 'exec'
  hasAgent: boolean
  hasAgentSession: boolean
  agentId?: unknown
  agentSessionId?: unknown
  eventSessionId?: unknown
  stack?: string
}

/** 内部诊断记录器（避免循环依赖 logger） */
function recordDiagnostic(context: SessionIdDiagnosticContext): void {
  const ts = new Date().toISOString()
  const msg = `[context-pro] sessionId 诊断 ${ts}: ${JSON.stringify(context)}`
  // 使用 console.error 确保即使 logger 不可用也能看到
  console.error(msg)
}

/**
 * 从 session/event 回调的 Session 对象中提取 session ID 字符串。
 * @param session - session/event 回调的第一个参数
 * @returns session ID 字符串，不可用时返回 'unknown'
 */
export function sessionIdFromEvent(session: unknown): string {
  const id = (session as { id?: unknown }).id
  if (id === undefined) {
    recordDiagnostic({
      source: 'event',
      hasAgent: false,
      hasAgentSession: false,
      eventSessionId: undefined,
      stack: new Error().stack,
    })
    return 'unknown'
  }
  return String(id)
}

/**
 * 从 tool 执行上下文中提取 session ID 字符串。
 * 优先走 agent.session.id（与 session/event 同一来源），回退到 agent.id。
 * @param exec - tool execute 函数的第二个参数（ToolRunContext 的子集）
 * @returns session ID 字符串，不可用时返回 'unknown'
 */
export function sessionIdFromExec(exec: {
  agent?: { id?: unknown; session?: { id?: unknown } }
}): string {
  const hasAgent = exec.agent !== undefined
  const hasAgentSession = exec.agent?.session !== undefined
  const agentId = exec.agent?.id
  const agentSessionId = exec.agent?.session?.id

  const id = agentSessionId ?? agentId

  if (id === undefined) {
    recordDiagnostic({
      source: 'exec',
      hasAgent,
      hasAgentSession,
      agentId,
      agentSessionId,
      stack: new Error().stack,
    })
    return 'unknown'
  }

  // 运行时一致性检查：如果两个来源都存在但不相等，记录警告
  if (agentSessionId !== undefined && agentId !== undefined && agentSessionId !== agentId) {
    recordDiagnostic({
      source: 'exec',
      hasAgent: true,
      hasAgentSession: true,
      agentId,
      agentSessionId,
      stack: new Error().stack,
    })
  }

  return String(id)
}

/**
 * 安全的 SessionId 转换（用于 ctx.agents.get() 等 API）。
 * @param id - 字符串形式的 session ID
 * @returns SessionId 类型
 */
/**
 * Session ID 归一化：去除空白、统一小写、长度限制。
 * 确保存储/获取/比较使用同一格式，避免大小写不一致导致匹配失败。
 */
export function normalizeSessionId(id: string): string {
  return id.trim().toLowerCase().slice(0, 128)
}

export function toSessionId(id: string): SessionId {
  return id as SessionId
}