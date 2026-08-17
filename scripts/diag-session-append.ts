/**
 * 诊断脚本 2：验证嵌套数组进入 session 后，deriveMessages 产出的消息形态。
 * 模拟 agent-loop 的消费路径：把插件返回的每个元素 session.append('user/message', m)
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry, {} as never)
  await ctx.plugin(SessionStore, {} as never)
  const store = ctx.get('sessions') as { create: (id?: string, opts?: unknown) => Session } | undefined
  if (!store) {
    console.error('sessions 服务不可用——需要 dsh-session 装配')
    process.exit(1)
  }
  const session = store.create(`sess-${Date.now()}`)

  // 模拟 agent-loop turn()：for (const message of decision.messages) session.append('user/message', message, {surfaceOp:'append'})
  // 插件实际返回：[...messages, [injectedMessage]] —— 最后一个是嵌套数组
  const injectedArray = [{
    id: 'ctx-pro-1234',
    role: 'user',
    content: [{ type: 'text', text: '—— 来自 dsh-context-pro 的上下文整形注入 ——\n[片段1|chain:causal@1] ...' }],
    source: { kind: 'plugin', plugin: 'dsh-context-pro' },
  }]

  session.append('turn/start', { turn: 1 })
  try {
    session.append('user/message', { id: 'a' as never, role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    console.log('普通消息 append OK')
  } catch (e) { console.log('普通消息 append 失败:', e) }

  try {
    // 这正是 agent-loop 会做的事：把插件返回的最后一个元素（数组）当消息 append
    session.append('user/message', injectedArray as never, { surfaceOp: 'append' })
    console.log('嵌套数组 append 未抛错——静默写入 session！')
  } catch (e) {
    console.log('嵌套数组 append 抛错:', (e as Error).message)
  }

  // 再看 deriveMessages 产出什么
  try {
    const msgs = session.deriveMessages()
    console.log(`deriveMessages 产出 ${msgs.length} 条:`)
    for (const [i, m] of msgs.entries()) {
      const isArray = Array.isArray(m)
      console.log(`  [${i}] ${isArray ? 'ARRAY(畸形!)' : `role=${(m as { role?: string }).role}, content=${JSON.stringify((m as { content?: unknown }).content).slice(0, 80)}`}`)
      if (isArray) {
        console.log('  >>> LLM 请求 messages 中出现数组元素 → 模型 API 校验失败 / 无法生成应答')
      }
    }
  } catch (e) {
    console.log('deriveMessages 抛错:', (e as Error).message)
  }

  process.exit(0)
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })