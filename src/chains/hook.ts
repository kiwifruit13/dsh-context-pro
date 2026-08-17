/**
 * 链感知钩子：监听 session/event，从 assistant/message 提取链节点入库。
 *
 * session/event 是 post-commit emit（事后追加）：回调在日志 push 后运行，
 * 观察者失败被包含（不使提交失败）——适合做链提取这种附加处理。
 *
 * 提取后自动剥离末尾 JSON 快照行（用户不可见，只供系统内部提取）。
 */
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import type { ChainIndex } from './types.ts'
import { createChainIndex } from './index.ts'
import { stripSnapshotLine } from './snapshot.ts'

export function registerChainHook(
  ctx: Context,
  enabled = true,
  maxNodesPerChain?: number,
): ChainIndex {
  const index = createChainIndex(maxNodesPerChain !== undefined ? { maxNodesPerChain } : {})

  if (enabled) {
    ctx.on('session/event', (_session, event) => {
      // 只处理 assistant/message（模型输出可能带快照）
      if (event.type !== 'assistant/message') return
      const msg = event.data as { message?: { id?: string; content?: unknown[] } }
      const content = msg.message?.content ?? []
      const text = content
        .map((b) => (b as { type?: string; text?: string }).text ?? '')
        .join('')
      if (!text) return

      const sessionId = String((_session as { id?: unknown }).id ?? 'unknown')
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

      // 提取后剥离末尾 JSON 快照行（用户不可见）
      // 倒序遍历 content 块，找到最后一个 text 块，剥离其末尾 JSON 行
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i] as { type?: string; text?: string }
        if (block.type === 'text' && block.text) {
          const stripped = stripSnapshotLine(block.text)
          if (stripped !== block.text) {
            block.text = stripped
          }
          break
        }
      }
    })

    // 生命周期：会话结束/删除 → 清空该会话链图
    ctx.on('session/disposed', (session) => {
      const sessionId = String((session as { id?: unknown }).id ?? 'unknown')
      index.dispose(sessionId)
    })
  }

  return index
}