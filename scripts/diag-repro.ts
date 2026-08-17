/**
 * 诊断脚本：复现 "Cannot read properties of undefined (reading 'indexOf')"。
 * 模拟真实 dsh web 环境：装配 AgentRegistry + 插件 + 触发带 systemPrompt 的真实 pre-step，
 * 捕获完整异步堆栈。
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as ctxPro from '../src/index.ts'

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry, {} as never)
  await ctx.plugin(ctxPro as never, {
    topK: 3,
    maxTokens: 2000,
    inject: true,
    measure: true,
    chains: { enabled: true, injectProtocol: true, stripAnchors: true, maxNodesPerChain: 20 },
  } as never)
  console.log('插件已装配')

  // 真实消息（模拟 dsh web 会话里的消息，含 plugin 源、各种消息形状）
  const baseMessages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: '我们在开发上下文整形插件，遇到了 bug' }], source: { kind: 'user' } },
    { id: 'b', role: 'user', content: [{ type: 'text', text: '继续调试注入问题' }], source: { kind: 'user' } },
  ]

  try {
    const emitted = await ctx.waterfall(
      'agent/pre-step',
      {
        agent: {} as never,
        messages: baseMessages as never[],
        turn: 1,
        step: 0,
        signal: new AbortController().signal,
      } as never,
      () => Promise.resolve({ kind: 'enter', messages: baseMessages as never[] }),
    )
    const msgs = (emitted as { messages: unknown[] }).messages
    console.log('pre-step 完成, messages =', msgs.length)
    for (const m of msgs) {
      const o = m as { role?: unknown; content?: unknown; source?: unknown }
      console.log('  -', JSON.stringify(o).slice(0, 120))
    }
    process.exit(0)
  } catch (err) {
    console.error('!! pre-step 抛错:')
    console.error((err as Error).stack ?? String(err))
    process.exit(1)
  }
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })