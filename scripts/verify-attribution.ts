/**
 * 归因分析验证脚本（P1 交付验证）
 *
 * 用法：npx tsx scripts/verify-attribution.ts
 *
 * 覆盖场景（按 todo.md 测试矩阵）：
 *   T1: 单节点证据 → attributionScore 高
 *   T2: 多节点 + 多边证据 → attributionScore 更高
 *   T3: 有反证（confidence=0） → attributionScore 降低
 *   T4: 全反证（无支撑证据） → attributionScore 接近 0
 *   T5: 空图 + 单条洞察 → no-support 反证
 *   T6: diverged 双路径 → 边证据包含 diverged-from
 *   T7: converged 合流 → 边证据包含 converged-into
 *   T8: cross-chain-link → 边证据包含 cross-chain-link
 */

import { createChainGraph } from '../src/chains/graph.ts'
import type { ChainGraph, ChainNode, InsightItem } from '../src/chains/types.ts'
import { attributeInsightsPure } from '../src/chains/insight.ts'

// 验证辅助函数
let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`✅ PASS: ${message}`)
    passed++
  } else {
    console.error(`❌ FAIL: ${message}`)
    failed++
  }
}

console.log('═══ 归因分析验证脚本（直接测 insight.ts 真实实现）═══\n')

// ─────────────────────────────────────────────
// T1: 单节点证据，无边，无反证 → 高分
// ─────────────────────────────────────────────
console.log('--- T1: 单节点证据 ---')
{
  const graph = createChainGraph()
  const node: ChainNode = {
    id: 'causal@1',
    kind: 'causal',
    root: 1,
    role: 'problem',
    content: '需求失控',
    children: [],
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.9,
  }
  graph.nodes.set(node.id, node)

  const insight: InsightItem = {
    type: 'cross-reaction',
    severity: 'info',
    title: '因果链问题已识别',
    detail: '需求失控',
    references: [{ scopeKey: 'causal:problem', chain: 'causal', root: 1, role: 'problem' }],
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(attributed.confidenceProfile !== undefined, 'T1: confidenceProfile 已生成')
  assert(attributed.confidenceProfile!.nodeEvidence.length === 1, 'T1: 节点证据数 = 1')
  assert(attributed.confidenceProfile!.edgeEvidence.length === 0, 'T1: 边证据数 = 0')
  assert(attributed.confidenceProfile!.contradictingEvidence.length === 0, 'T1: 反证数 = 0')
  assert(attributed.confidenceProfile!.attributionScore > 0.5, 'T1: attributionScore > 0.5')
}

// ─────────────────────────────────────────────
// T2: 多节点 + 多边证据 → 更高分
// ─────────────────────────────────────────────
console.log('\n--- T2: 多节点 + 多边 ---')
{
  const graph = createChainGraph()
  const parent: ChainNode = {
    id: 'causal@1',
    kind: 'causal',
    root: 1,
    role: 'problem',
    content: '需求失控',
    children: ['causal@1.1'],
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.9,
  }
  const child: ChainNode = {
    id: 'causal@1.1',
    kind: 'causal',
    root: 1,
    role: 'cause',
    content: '人力不足',
    children: [],
    parent: 'causal@1',
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.85,
  }
  graph.nodes.set(parent.id, parent)
  graph.nodes.set(child.id, child)

  const insight: InsightItem = {
    type: 'cross-reaction',
    severity: 'warn',
    title: '因果链结构完整',
    detail: '需求→原因',
    references: [{ scopeKey: 'causal:cause', chain: 'causal', root: 1, role: 'cause' }],
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(attributed.confidenceProfile!.nodeEvidence.length >= 1, 'T2: 至少 1 个节点证据')
  assert(attributed.confidenceProfile!.edgeEvidence.length >= 1, 'T2: 至少 1 条边证据（parent-child）')
  assert(attributed.confidenceProfile!.attributionScore > 0.6, 'T2: 多证据 → attributionScore > 0.6')
}

// ─────────────────────────────────────────────
// T3: 有反证（confidence=0） → 分数降低
// ─────────────────────────────────────────────
console.log('\n--- T3: confidence=0 反证 ---')
{
  const graph = createChainGraph()
  const node: ChainNode = {
    id: 'causal@1',
    kind: 'causal',
    root: 1,
    role: 'problem',
    content: '需求失控',
    children: [],
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0,
  }
  graph.nodes.set(node.id, node)

  const insight: InsightItem = {
    type: 'cross-reaction',
    severity: 'info',
    title: '因果链问题',
    detail: '需求失控',
    references: [{ scopeKey: 'causal:problem', chain: 'causal', root: 1, role: 'problem' }],
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(attributed.confidenceProfile!.contradictingEvidence.length >= 1, 'T3: 有反证')
  assert(
    attributed.confidenceProfile!.contradictingEvidence.some((c) => c.kind === 'confidence-decay'),
    'T3: 包含 confidence-decay 反证',
  )
}

// ─────────────────────────────────────────────
// T4: 全反证（无支撑证据） → 接近 0
// ─────────────────────────────────────────────
console.log('\n--- T4: 无支撑证据 ---')
{
  const graph = createChainGraph()
  const insight: InsightItem = {
    type: 'cross-reaction',
    severity: 'info',
    title: '因果链问题',
    detail: '需求失控',
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(attributed.confidenceProfile!.nodeEvidence.length === 0, 'T4: 节点证据 = 0')
  assert(attributed.confidenceProfile!.edgeEvidence.length === 0, 'T4: 边证据 = 0')
  assert(
    attributed.confidenceProfile!.contradictingEvidence.some((c) => c.kind === 'no-support'),
    'T4: 包含 no-support 反证',
  )
  assert(attributed.confidenceProfile!.attributionScore === 0, 'T4: attributionScore = 0')
}

// ─────────────────────────────────────────────
// T5: 空图 + 单条洞察 → no-support 反证
// ─────────────────────────────────────────────
console.log('\n--- T5: 空图 + 洞察（有 references 但找不到节点） ---')
{
  const graph = createChainGraph()
  assert(graph.nodes.size === 0, 'T5: ChainGraph 为空')

  const insight: InsightItem = {
    type: 'cross-reaction',
    severity: 'info',
    title: '洞察',
    detail: '描述',
    references: [{ scopeKey: 'causal:problem', chain: 'causal', root: 1, role: 'problem' }],
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(
    attributed.confidenceProfile!.contradictingEvidence.some((c) => c.kind === 'no-support'),
    'T5: 空图 → no-support 反证',
  )
}

// ─────────────────────────────────────────────
// T6: diverged 双路径 → 边证据包含 diverged-from
// ─────────────────────────────────────────────
console.log('\n--- T6: diverged 双路径 ---')
{
  const graph = createChainGraph()
  const aiNode: ChainNode = {
    id: 'causal@1.1',
    kind: 'causal',
    root: 1,
    role: 'cause',
    content: '人力不足',
    children: [],
    parent: 'causal@1',
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.7,
    divergence: 'ai',
  }
  const userNode: ChainNode = {
    id: 'causal@1.2',
    kind: 'causal',
    root: 1,
    role: 'cause',
    content: '需求混乱',
    children: [],
    parent: 'causal@1',
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.6,
    divergence: 'user',
  }
  graph.nodes.set(aiNode.id, aiNode)
  graph.nodes.set(userNode.id, userNode)

  const insight: InsightItem = {
    type: 'divergence-watch',
    severity: 'warn',
    title: '因果链原因分歧',
    detail: 'AI vs User',
    references: [
      { scopeKey: 'causal:cause', chain: 'causal', root: 1, role: 'cause', nodeIds: ['causal@1.1', 'causal@1.2'] },
    ],
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(attributed.confidenceProfile!.nodeEvidence.length === 2, 'T6: 双路径各贡献 1 个节点证据')
  assert(
    attributed.confidenceProfile!.edgeEvidence.some((e) => e.kind === 'diverged-from'),
    'T6: 边证据包含 diverged-from',
  )
}

// ─────────────────────────────────────────────
// T7: converged 合流 → 边证据包含 converged-into
// ─────────────────────────────────────────────
console.log('\n--- T7: converged 合流 ---')
{
  const graph = createChainGraph()
  const aiNode: ChainNode = {
    id: 'causal@1.1',
    kind: 'causal',
    root: 1,
    role: 'cause',
    content: '人力不足',
    children: ['causal@1.1.1'],
    parent: 'causal@1',
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    divergence: 'ai',
  }
  const userNode: ChainNode = {
    id: 'causal@1.2',
    kind: 'causal',
    root: 1,
    role: 'cause',
    content: '需求混乱',
    children: ['causal@1.1.1'],
    parent: 'causal@1',
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    divergence: 'user',
  }
  const converged: ChainNode = {
    id: 'causal@1.1.1',
    kind: 'causal',
    root: 1,
    role: 'solution',
    content: '优先级裁剪',
    children: [],
    parent: 'causal@1.1',
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.8,
    convergedFrom: ['causal@1.1', 'causal@1.2'],
  }
  graph.nodes.set(aiNode.id, aiNode)
  graph.nodes.set(userNode.id, userNode)
  graph.nodes.set(converged.id, converged)

  const insight: InsightItem = {
    type: 'divergence-watch',
    severity: 'info',
    title: '因果链合流',
    detail: 'AI+User → 优先级裁剪',
    references: [{ scopeKey: 'causal:solution', chain: 'causal', root: 1, role: 'solution' }],
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(
    attributed.confidenceProfile!.edgeEvidence.some((e) => e.kind === 'converged-into'),
    'T7: 边证据包含 converged-into',
  )
  assert(converged.convergedFrom?.length === 2, 'T7: 合流节点有 2 个 from')
}

// ─────────────────────────────────────────────
// T8: cross-chain-link → 边证据包含 cross-chain-link
// ─────────────────────────────────────────────
console.log('\n--- T8: cross-chain-link ---')
{
  const graph = createChainGraph()
  const node: ChainNode = {
    id: 'causal@1.1',
    kind: 'causal',
    root: 1,
    role: 'cause',
    content: '人力不足',
    children: [],
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.7,
    links: ['operation@2.1'],
  }
  graph.nodes.set(node.id, node)

  const insight: InsightItem = {
    type: 'cross-reaction',
    severity: 'info',
    title: '跨链引用',
    detail: '因果链引用操作链',
    references: [{ scopeKey: 'causal:cause', chain: 'causal', root: 1, role: 'cause' }],
    evidence: 1,
    timestamp: Date.now(),
  }

  const [attributed] = attributeInsightsPure([insight], graph)
  assert(
    attributed.confidenceProfile!.edgeEvidence.some((e) => e.kind === 'cross-chain-link'),
    'T8: 边证据包含 cross-chain-link',
  )
}

// ─────────────────────────────────────────────
// T9: 纯函数性验证（不修改输入）
// ─────────────────────────────────────────────
console.log('\n--- T9: 纯函数性 ---')
{
  const graph = createChainGraph()
  const node: ChainNode = {
    id: 'causal@1',
    kind: 'causal',
    root: 1,
    role: 'problem',
    content: '测试',
    children: [],
    status: 'active',
    timestamp: Date.now(),
    sourceRefs: [],
    confidence: 0.8,
  }
  graph.nodes.set(node.id, node)

  const insight: InsightItem = {
    type: 'cross-reaction',
    severity: 'info',
    title: '测试',
    detail: '测试',
    references: [{ scopeKey: 'causal:problem', chain: 'causal', root: 1, role: 'problem' }],
    evidence: 1,
    timestamp: Date.now(),
  }

  const originalSize = graph.nodes.size
  const result = attributeInsightsPure([insight], graph)
  result[0].confidenceProfile!.attributionScore = 999  // 试图修改返回值

  assert(graph.nodes.size === originalSize, 'T9: graph 未被修改')
  assert(insight.confidenceProfile === undefined, 'T9: 输入 insight 未被修改（无 confidenceProfile）')
}

console.log(`\n═══ 验证完成 ═══`)
console.log(`通过：${passed}，失败：${failed}`)
if (failed > 0) {
  process.exit(1)
}
