/**
 * ChainIndex：会话内临时链索引。
 *
 * 生命周期跟会话：session/disposed → dispose(sessionId) 清空该会话链图，
 * 删对话即删链，无残留（非 agent-memory 长期记忆）。
 *
 * 提取通道：仅末尾 JSON 快照（设计文档终局共识——锚点语法已下线，不再解析 [因果@1] 标签）。
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ChainAnchor, ChainGraph, ChainIndex } from './types.ts'
import { createChainGraph } from './graph.ts'
import { mergeSnapshotIntoGraph, parseSnapshot } from './snapshot.ts'
import { buildGuide } from './guide.ts'

/** 从消息提取文本块（text 块） */
function messageText(message: UserMessage): string {
  return message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
}

export function createChainIndex(options: { maxNodesPerChain?: number } = {}): ChainIndex {
  const graphs = new Map<string, ChainGraph>()
  const maxNodesPerChain = options.maxNodesPerChain ?? 20

  function graph(sessionId: string): ChainGraph | undefined {
    return graphs.get(sessionId)
  }

  function ingest(sessionId: string, message: UserMessage): ChainAnchor[] {
    const raw = messageText(message)
    if (!raw) return []

    // 单一提取通道：末尾 JSON 快照（锚点语法已下线，不再解析 [因果@1] 标签）
    const snapshot = parseSnapshot(raw)
    if (!snapshot) return []

    let g = graphs.get(sessionId)
    if (!g) {
      g = createChainGraph()
      graphs.set(sessionId, g)
    }
    const sourceRef = `assistant/message ${message.id}`

    const result = mergeSnapshotIntoGraph(g, snapshot, sourceRef)
    // 每链节点上限：ingest 后裁剪（防止单链演化失控）
    g.prune(maxNodesPerChain)
    return result
  }

  function guide(sessionId: string) {
    const g = graphs.get(sessionId)
    if (!g) return undefined
    return buildGuide(g)
  }

  function dispose(sessionId: string): void {
    const g = graphs.get(sessionId)
    if (g) g.dispose()
    graphs.delete(sessionId)
  }

  return { graphs, ingest, graph, guide, dispose }
}
