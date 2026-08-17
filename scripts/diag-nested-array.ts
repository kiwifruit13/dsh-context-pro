/**
 * 诊断脚本：验证 prestep 返回的 messages 是否存在嵌套数组（疑似"无法应答"根因）。
 * 模拟 agent-loop turn() 的消费路径：for (const m of decision.messages) session.append('user/message', m)
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
    weights: { relevance: 0.7, recency: 0.15, source: 0.15 },
    inject: true,
    measure: true,
  } as never)

  const baseMessages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: '我们开发上下文整形插件' }], source: { kind: 'user' } },
    { id: 'b', role: 'user', content: [{ type: 'text', text: '继续开发' }], source: { kind: 'user' } },
  ]
  const emitted = await ctx.waterfall(
    'agent/pre-step',
    { agent: {}, messages: baseMessages, turn: 1, step: 0, signal: new AbortController().signal } as never,
    () => Promise.resolve({ kind: 'enter', messages: baseMessages as never[] }),
  )

  const msgs = (emitted as { messages: unknown[] }).messages
  console.log(`plugin 返回 messages.length = ${msgs.length}`)
  let nestedCount = 0
  for (const [i, m] of msgs.entries()) {
    const isArray = Array.isArray(m)
    if (isArray) nestedCount++
    const label = isArray
      ? `ARRAY(len=${(m as unknown[]).length}) — 嵌套!`
      : `${(m as { role?: string }).role} id=${String((m as { id?: unknown }).id)}`
    console.log(`  [${i}] ${label}`)
  }
  console.log(`嵌套数组元素数 = ${nestedCount}  ${nestedCount > 0 ? '>>> 确认：prestep 返回了嵌套数组' : '>>> 无嵌套'}`)

  // 模拟 agent-loop：对每个元素 session.append('user/message', m)
  console.log('\n--- 模拟 agent-loop 逐条 append ---')
  for (const [i, m] of msgs.entries()) {
    if (Array.isArray(m)) {
      console.log(`  [${i}] 是一个数组：agent-loop 会把它整个当作一条 user/message 追加进 session！`)
    } else {
      console.log(`  [${i}] 对象消息，正常`)
    }
  }

  process.exit(0)
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })