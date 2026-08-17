/**
 * agent/pre-step 拦截器：链协议模式下零干预。
 *
 * 设计文档终局共识——CoT 放权，系统只做两件事：
 *   1. 在 System Prompt 中注入五链图鉴（prompt.ts）
 *   2. 在模型回复末尾解析 JSON 快照（hook.ts）
 * prestep 零干预，不 SELECT、不 REFACTOR、不 INJECT、不 MEASURE。
 *
 * 监听器仅做防御性兜底：next() 返回 undefined 时补默认 decision。
 */
import type { Context } from '@deepseek-ai/cordis'
// 副作用导入：触发 dsh-agent 的 Events 声明合并（agent/pre-step 等进入 keyof Events）
import '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'

export function registerPreStepHook(ctx: Context): void {
  ctx.on('agent/pre-step', async (
    payload: { messages: UserMessage[] },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    // 防御性兜底：next() 返回 undefined 时补默认 decision
    if (!decision) {
      ctx.logger('context-pro').warn('agent/pre-step next() returned undefined, using default')
      return { kind: 'enter', messages: payload.messages }
    }
    return decision
  })
}
