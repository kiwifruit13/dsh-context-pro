/**
 * DSH-Context-Pro e2e 验证（真实 Context + 模拟 pre-step 分发）。
 *
 * 链协议模式（终局共识）：prestep 零干预——
 *   1. ctx.plugin 装配插件（fiber 启动）
 *   2. agent/pre-step 监听器已注册
 *   3. 模拟 waterfall 分发 → 消息不被修改（无 plugin 注入块）
 *   4. 消息扁平无嵌套（bug #23 回归断言）
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as ctxPro from '../src/index.ts'

async function main(): Promise<void> {
  // 1. 装配插件（链协议模式：chains.enabled + injectProtocol）
  const ctx = new Context()
  await ctx.plugin(AgentRegistry, {} as never)
  await ctx.plugin(ctxPro as never, {
    chains: { enabled: true, injectProtocol: true, maxNodesPerChain: 20 },
  } as never)
  console.log('1 插件已装配 (ctx.plugin, 链协议模式)')

  // 2. 检查插件导出（name/inject/apply）
  console.log('2 插件 name =', (ctxPro as never as { name?: string }).name, '| inject =', JSON.stringify((ctxPro as never as { inject?: string[] }).inject))

  // 3. 真实激活断言：模拟 pre-step 分发——链协议模式下 prestep 零干预，
  //    返回的 messages 必须与输入完全一致（无 plugin 注入块）
  const baseMessages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: '我们在开发上下文整形插件' }], source: { kind: 'user' } },
    { id: 'b', role: 'user', content: [{ type: 'text', text: '继续开发上下文整形插件' }], source: { kind: 'user' } },
  ]
  const emitted = await ctx.waterfall('agent/pre-step', {
    agent: {},
    messages: baseMessages,
    turn: 1,
    step: 0,
    signal: new AbortController().signal,
  } as never, () => Promise.resolve({ kind: 'enter', messages: baseMessages as never[] }))

  // bug #23 回归断言：返回的 messages 必须是扁平 UserMessage[]
  const emittedMessages = (emitted as { messages: unknown[] }).messages as unknown[]
  const nested = emittedMessages.filter((m) => Array.isArray(m))
  if (nested.length > 0) {
    console.error(`FAIL: pre-step 返回的 messages 含 ${nested.length} 个嵌套数组元素`)
    process.exit(1)
  }
  const malformed = emittedMessages.filter((m) => {
    const o = m as { role?: unknown; content?: unknown } | null
    return typeof o !== 'object' || o === null || o.role !== 'user' || !Array.isArray(o.content)
  })
  if (malformed.length > 0) {
    console.error(`FAIL: pre-step 返回 ${malformed.length} 个非消息对象元素`)
    process.exit(1)
  }

  // 链协议模式零干预断言：不应有 plugin 来源的注入块
  const pluginInjected = (emittedMessages as Array<{ source?: { kind?: string; plugin?: string } }>)
    .some((m) => m.source?.kind === 'plugin' && m.source?.plugin === 'dsh-context-pro')
  console.log('3 pre-step 分发完成 | 决策消息数 =', emittedMessages.length,
    '| 嵌套数组 =', nested.length, '| 插件注入 =', pluginInjected)
  if (pluginInjected) {
    console.error('FAIL: 链协议模式不应注入 plugin 消息（prestep 零干预）')
    process.exit(1)
  }

  // 消息数不变（零干预 = 不增不减）
  if (emittedMessages.length !== baseMessages.length) {
    console.error(`FAIL: 消息数变化 ${baseMessages.length} → ${emittedMessages.length}（零干预应不变）`)
    process.exit(1)
  }

  console.log('=== DSH-Context-Pro e2e PASS ===')
  process.exit(0)
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })
