/**
 * 洞察引擎（超然层）：只观察、只建议、不干预 CoT。
 *
 * 定位：会话内的"旁观者笔记"——每轮回复后接收 ChainGraph 全局状态 +
 * 过滤后 session 历史，从五个维度分析认知趋势，产出建议项 + 推荐话题。
 *
 *   - 对模型：通过 get_insights tool 按需调取（参考性质，非约束）
 *   - 对用户：推荐话题候选池，按需渲染（会话结束便条 / UI 按钮）
 *
 * 生命周期跟会话：session/disposed → 连同 ChainGraph 一并销毁，无残留。
 * 内存级累积，插件重载归零（超然层无状态观察，符合设计）。
 */
import {
  type ChainGraph,
  type ChainGuide,
  type ChainKind,
  type ChainNode,
  type ChainRole,
  type ChainSnapshot,
  type ChangeContext,
  type ChainChangeType,
  type FilterSelector,
  type InsightConfig,
  type InsightEngine,
  type InsightHistoryItem,
  type InsightItem,
  type InsightNeed,
  type InsightReference,
  type InsightStore,
  type RecommendationTopic,
  type Severity,
  type SnapshotNodeValue,
  type ConfidenceProfile,
  type NodeEvidence,
  type EdgeEvidence,
  type ContradictingEvidence,
} from './types.ts'

/** getLatestTopics 返回结果（① 显式返回元数据，消除"空=无/空=已淘汰"歧义） */
export interface TopicsResult {
  topics: RecommendationTopic[]
  lastSessionId: string | null
  evicted: boolean
}

// ---------------------------------------------------------------------------
// 常量（默认值，可被 InsightConfig 覆盖）
// ---------------------------------------------------------------------------

/** 历史累积窗口大小（最近 N 轮 = 2N 条消息：N assistant + N user） */
const DEFAULT_HISTORY_WINDOW = 40

/** "引用过去"的默认关键词（reference-to-past need 用） */
const DEFAULT_PAST_KEYWORDS = ['之前', '上文', '此前', '刚才', '前面', '第']

/** 链角色中文标签（话题生成用） */
const ROLE_LABEL_CN: Record<ChainRole, string> = {
  problem: '问题', cause: '原因', solution: '解决方案',
  premise: '前提', reasoning: '推理', conclusion: '结论',
  action: '动作', step: '步骤', result: '结果',
  beginning: '开端', development: '发展', twist: '转折', ending: '结局',
  past: '过去', present: '现在', future: '未来',
}

/** 链名中文标签 */
const CHAIN_LABEL_CN: Record<ChainKind, string> = {
  causal: '因果链', logic: '逻辑链', operation: '操作链',
  narrative: '叙事链', temporal: '时间链',
}

/** 终结角色（缺口聚合用） */
const TERMINAL_ROLES: Set<ChainRole> = new Set([
  'solution', 'conclusion', 'result', 'ending', 'future',
])

/** 四大链间化学反应配对（映射融合进阶.md） */
interface ReactionPair {
  chainA: ChainKind; roleA: ChainRole
  chainB: ChainKind; roleB: ChainRole
  name: string
  desc: string
}

const REACTION_PAIRS: ReactionPair[] = [
  { chainA: 'causal', roleA: 'cause', chainB: 'temporal', roleB: 'past',
    name: '深层归因动力学', desc: '因果链归因与时间链过去重叠，可能形成"病灶演化时间轴"' },
  { chainA: 'logic', roleA: 'premise', chainB: 'operation', roleB: 'step',
    name: '抗脆弱执行手册', desc: '逻辑链前提与操作链步骤重叠，可能形成"决策树型执行清单"' },
  { chainA: 'narrative', roleA: 'twist', chainB: 'causal', roleB: 'cause',
    name: '沉浸式深度诊断', desc: '叙事链转折与因果链归因重叠，可能形成"故事化根因分析"' },
  { chainA: 'temporal', roleA: 'future', chainB: 'narrative', roleB: 'ending',
    name: '变革蓝图', desc: '时间链未来与叙事链结局重叠，可能形成"史诗感转型路线图"' },
]

/** 每种链的起始角色（用于话题生成时取上下文锚点） */
const ROLE_BY_KIND_START: Record<ChainKind, ChainRole> = {
  causal: 'problem',
  logic: 'premise',
  operation: 'action',
  narrative: 'beginning',
  temporal: 'past',
}

/** 洞察项 / 话题上限（默认值，可被 InsightConfig 覆盖） */
const DEFAULT_MAX_INSIGHTS = 20
const DEFAULT_MAX_TOPICS = 10
/** 连续 N 轮未被重新确认 → 移除（过期淘汰，默认值） */
const DEFAULT_MAX_STALE_ROUNDS = 3
/** Jaccard 相似度阈值（>= 此值视为内容重叠；0-1 归一化比率，默认值） */
const DEFAULT_SIMILARITY_THRESHOLD = 0.15

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 根键：`causal@1.2` → `causal@1`（修正后缀 ′ 不影响） */
function rootKeyOf(id: string): string {
  return id.split('.')[0].replace(/′$/, '')
}

/** 字符 n-gram 提取（默认 bigram）：对中文天然友好，不依赖分词，微小差异不影响相似度 */
function extractNGrams(text: string, n = 2): Set<string> {
  if (!text || text.length < n) return new Set()
  const grams = new Set<string>()
  for (let i = 0; i <= text.length - n; i++) {
    grams.add(text.slice(i, i + n))
  }
  return grams
}

/** Jaccard 相似度：|A ∩ B| / |A ∪ B|，归一化到 0-1，不受文本长度影响 */
function jaccardSimilarity(a: string, b: string): number {
  const ka = extractNGrams(a)
  const kb = extractNGrams(b)
  if (ka.size === 0 || kb.size === 0) return 0
  let intersection = 0
  for (const k of ka) {
    if (kb.has(k)) intersection++
  }
  const union = ka.size + kb.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** 从链图中取某 kind+root+role 的活跃节点内容 */
function nodeContent(graph: ChainGraph, kind: ChainKind, root: number, role: ChainRole): string | undefined {
  const rootKey = `${kind}@${root}`
  for (const node of graph.nodes.values()) {
    if (node.kind !== kind) continue
    if (rootKeyOf(node.id) !== rootKey) continue
    if (node.status !== 'active' || !node.content) continue
    if (node.role === role) return node.content
  }
  return undefined
}

/** 取某 kind 的所有活跃根链号 */
function activeRootsOf(graph: ChainGraph, kind: ChainKind): number[] {
  const roots = new Set<number>()
  for (const node of graph.nodes.values()) {
    if (node.kind !== kind || node.parent || node.status !== 'active') continue
    const r = Number(rootKeyOf(node.id).split('@')[1])
    if (!Number.isNaN(r)) roots.add(r)
  }
  return [...roots].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// 变更检测器（P1 选择性分析器：对比前后快照/图，产出 ChangeContext）
// ---------------------------------------------------------------------------

/** 检测链图与快照变更，产出 ChangeContext（P1） */
function detectChanges(
  prevSnapshot: ChainSnapshot | null | undefined,
  currSnapshot: ChainSnapshot | null | undefined,
  isFirstRound: boolean,
): ChangeContext {
  const changes = new Set<ChainChangeType>()

  if (isFirstRound) {
    return { changes, prevSnapshot, currSnapshot, isFirstRound: true }
  }

  if (!prevSnapshot && currSnapshot) {
    changes.add('chain-added')
  } else if (prevSnapshot && !currSnapshot) {
    changes.add('chain-removed')
  } else if (prevSnapshot && currSnapshot) {
    // 链类型变更
    if (prevSnapshot.chain !== currSnapshot.chain) {
      changes.add('chain-type-changed')
    }
    // 置信度显著变化
    for (const [role, currVal] of Object.entries(currSnapshot.nodes) as [ChainRole, SnapshotNodeValue | undefined][]) {
      const prevVal = prevSnapshot.nodes[role]
      if (currVal?.confidence !== undefined && prevVal?.confidence !== undefined) {
        const diff = currVal.confidence - prevVal.confidence
        if (Math.abs(diff) >= 0.3) {
          changes.add('confidence-shift')
        }
      }
    }
    // Supersede 检测
    if (currSnapshot.supersede && !prevSnapshot.supersede) {
      changes.add('supersede-detected')
    }
  }

  return { changes, prevSnapshot, currSnapshot, isFirstRound: false }
}

// ---------------------------------------------------------------------------
// 分析器 ①：链间化学反应检测
// ---------------------------------------------------------------------------

function analyzeCrossReaction(graph: ChainGraph): InsightItem[] {
  const items: InsightItem[] = []
  const now = Date.now()

  for (const pair of REACTION_PAIRS) {
    const rootsA = activeRootsOf(graph, pair.chainA)
    const rootsB = activeRootsOf(graph, pair.chainB)
    if (rootsA.length === 0 || rootsB.length === 0) continue

    // 取最新根链的对应角色内容
    const contentA = nodeContent(graph, pair.chainA, rootsA[rootsA.length - 1], pair.roleA)
    const contentB = nodeContent(graph, pair.chainB, rootsB[rootsB.length - 1], pair.roleB)
    if (!contentA || !contentB) continue

    const similarity = jaccardSimilarity(contentA, contentB)
    if (similarity >= DEFAULT_SIMILARITY_THRESHOLD) {
      items.push({
        type: 'cross-reaction',
        severity: 'info',
        title: `${pair.name}苗头`,
        detail: `${CHAIN_LABEL_CN[pair.chainA]}的${ROLE_LABEL_CN[pair.roleA]}与${CHAIN_LABEL_CN[pair.chainB]}的${ROLE_LABEL_CN[pair.roleB]}内容相似度 ${Math.round(similarity * 100)}%。${pair.desc}。`,
        evidence: 1,
        timestamp: now,
      })
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// 分析器 ②：链迁移预测
// ---------------------------------------------------------------------------

function analyzeMigration(graph: ChainGraph, guide: ChainGuide): InsightItem[] {
  const items: InsightItem[] = []
  const now = Date.now()
  const primary = guide.primary
  if (!primary) return items

  // 主链进度：已填充角色数 / 总角色数
  const filled = primary.roles.filter((r) => r.state !== 'empty').length
  const total = primary.roles.length
  const progress = filled / total

  // 检查是否有其他链已有节点（迁移苗头）
  const otherKinds = guide.chains.filter(
    (c) => c.kind !== primary.kind && !c.superseded && !c.ended,
  )

  // 进度 >= 2/3 且缺口在末尾角色 → 即将收束
  if (progress >= 2 / 3 && primary.gaps.length > 0) {
    const lastRole = primary.roles[primary.roles.length - 1]
    if (lastRole.state === 'empty') {
      items.push({
        type: 'migration',
        severity: 'info',
        title: `${CHAIN_LABEL_CN[primary.kind]}即将收束`,
        detail: `主链进度 ${filled}/${total}，末尾角色${ROLE_LABEL_CN[lastRole.role]}仍缺。收束后可能转向其他链。`,
        evidence: 1,
        timestamp: now,
      })
    }
  }

  // 存在其他活跃链 → 迁移可能性
  if (otherKinds.length > 0 && progress >= 1 / 3) {
    const names = otherKinds.map((c) => CHAIN_LABEL_CN[c.kind]).join('、')
    items.push({
      type: 'migration',
      severity: 'info',
      title: '链迁移可能',
      detail: `主链${CHAIN_LABEL_CN[primary.kind]}推进中，同时${names}已有节点。用户可能即将切换关注点。`,
      evidence: 1,
      timestamp: now,
    })
  }

  return items
}

// ---------------------------------------------------------------------------
// 分析器 ③：置信度趋势预警（从 FilterSelector 历史快照重建置信度序列）
// ---------------------------------------------------------------------------

function analyzeConfidenceTrend(
  snapshot: ChainSnapshot | null,
  filterSelector: FilterSelector,
  sessionId: string,
): InsightItem[] {
  const items: InsightItem[] = []
  const now = Date.now()

  // 查询最近 20 个含快照的消息（含当前轮次）
  const history = filterSelector.query(sessionId, { type: 'recent-snapshots', limit: 20 })
  if (history.length < 2) return items

  // 按 (chain, role) 分组，从快照重建置信度序列
  const confMap = new Map<string, number[]>()
  for (const item of history) {
    if (!item.snapshot) continue
    const { chain, nodes } = item.snapshot
    for (const [role, value] of Object.entries(nodes) as [ChainRole, SnapshotNodeValue | undefined][]) {
      if (value?.confidence === undefined) continue
      if (value.confidence < 0 || value.confidence > 1) continue
      const key = `${chain}:${role}`
      const seq = confMap.get(key) ?? []
      seq.push(value.confidence)
      confMap.set(key, seq)
    }
  }

  // 当前快照置信度（供单轮骤降检测用）
  const currConfMap = new Map<string, number>()
  if (snapshot) {
    for (const [role, value] of Object.entries(snapshot.nodes) as [ChainRole, SnapshotNodeValue | undefined][]) {
      if (value?.confidence === undefined) continue
      currConfMap.set(`${snapshot.chain}:${role}`, value.confidence)
    }
  }

  for (const [key, seq] of confMap) {
    if (seq.length < 2) continue

    const latest = seq[seq.length - 1]
    const chain = key.split(':')[0] as ChainKind
    const role = key.split(':')[1] as ChainRole

    // 连续下降检测
    let decreasing = 0
    for (let i = seq.length - 1; i > 0; i--) {
      if (seq[i] < seq[i - 1]) decreasing++
      else break
    }

    // 合并：连续下降 或 单轮骤降（≥0.3）
    const singleDrop = currConfMap.has(key) ? (seq.length >= 2 ? seq[seq.length - 2] - latest : 0) : 0
    const isSharpDrop = singleDrop >= 0.3

    if (decreasing >= 3 || (decreasing >= 2 && latest < 0.4) || isSharpDrop) {
      const severity: Severity = decreasing >= 3 || (decreasing >= 2 && latest < 0.4) ? 'critical' : 'warn'
      const reason = isSharpDrop && decreasing < 2
        ? `置信度从 ${Math.round(singleDrop * 100 + latest * 100)}% 降至 ${Math.round(latest * 100)}%（单轮降幅 ${Math.round(singleDrop * 100)}%）`
        : `置信度连续 ${decreasing} 轮下降（最新 ${Math.round(latest * 100)}%）`
      items.push({
        type: 'confidence-trend',
        severity,
        title: `${chain}的${ROLE_LABEL_CN[role]}置信度${isSharpDrop ? '骤降' : '下降'}`,
        detail: `${reason}。建议确认该结论是否仍成立。`,
        references: [{ scopeKey: `${chain}:${role}`, chain, role }],
        evidence: 1,
        timestamp: now,
      })
    } else if (decreasing >= 2) {
      items.push({
        type: 'confidence-trend',
        severity: 'warn',
        title: `${chain}的${ROLE_LABEL_CN[role]}置信度下降`,
        detail: `置信度连续 ${decreasing} 轮下降（最新 ${Math.round(latest * 100)}%），趋势需关注。`,
        references: [{ scopeKey: `${chain}:${role}`, chain, role }],
        evidence: 1,
        timestamp: now,
      })
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// 分析器 ④：脉络缺口聚合
// ---------------------------------------------------------------------------

function analyzeGapAggregation(guide: ChainGuide): InsightItem[] {
  const items: InsightItem[] = []
  const now = Date.now()

  // 收集所有活跃链的终结角色缺口
  const terminalGaps: { kind: ChainKind; role: ChainRole }[] = []
  for (const chain of guide.chains) {
    if (chain.ended || chain.superseded) continue
    for (const role of chain.gaps) {
      if (TERMINAL_ROLES.has(role)) {
        terminalGaps.push({ kind: chain.kind, role })
      }
    }
  }

  // 2 条以上链同时缺终结角色 → 认知盲区
  if (terminalGaps.length >= 2) {
    const names = terminalGaps
      .map((g) => `${CHAIN_LABEL_CN[g.kind]}的${ROLE_LABEL_CN[g.role]}`)
      .join('、')
    items.push({
      type: 'gap-aggregation',
      severity: 'warn',
      title: '多链终结角色缺口',
      detail: `${names}均未填充。用户可能在多个维度寻求结论但尚未收敛，认知盲区较大。`,
      evidence: 1,
      timestamp: now,
    })
  }

  return items
}

// ---------------------------------------------------------------------------
// 分析器 ⑤：分歧收敛预测
// ---------------------------------------------------------------------------

function analyzeDivergence(graph: ChainGraph): InsightItem[] {
  const items: InsightItem[] = []
  const now = Date.now()

  // 扫描所有活跃节点中的 diverged 节点
  const divergedPairs = new Map<string, { ai?: ChainNode; user?: ChainNode }>()
  for (const node of graph.activeNodes()) {
    if (!node.divergence) continue
    const key = `${rootKeyOf(node.id)}:${node.role}`
    const pair = divergedPairs.get(key) ?? {}
    if (node.divergence === 'ai') pair.ai = node
    if (node.divergence === 'user') pair.user = node
    divergedPairs.set(key, pair)
  }

  // 检查是否有对应的 converged 节点（分歧已收敛）
  for (const [key, pair] of divergedPairs) {
    if (!pair.ai && !pair.user) continue
    const rootKey = key.split(':')[0]
    const role = key.split(':')[1] as ChainRole

    // 查找该 rootKey+role 下是否有 converged 节点
    const converged = [...graph.nodes.values()].some(
      (n) => rootKeyOf(n.id) === rootKey &&
        n.role === role &&
        n.status === 'active' &&
        n.convergedFrom && n.convergedFrom.length > 0,
    )

    if (converged) {
      const kindFromRoot = rootKey.split('@')[0] as ChainKind
      const rootFromKey = Number(rootKey.split('@')[1])
      // 收敛场景也带 nodeIds，确保归因 Path A 始终可用（P1-3 防御加固）
      const convNode = [...graph.nodes.values()].find(
        (n) => rootKeyOf(n.id) === rootKey &&
          n.role === role &&
          n.status === 'active' &&
          n.convergedFrom && n.convergedFrom.length > 0,
      )
      items.push({
        type: 'divergence-watch',
        severity: 'info',
        title: `${rootKey}的${ROLE_LABEL_CN[role]}分歧已收敛`,
        detail: `AI 与用户在${ROLE_LABEL_CN[role]}上的分歧已通过合流解决。`,
        references: [{ scopeKey: `${rootKey}:${role}`, chain: kindFromRoot, root: rootFromKey, role,
          nodeIds: convNode ? [convNode.id] : [] }],
        evidence: 1,
        timestamp: now,
      })
    } else if (pair.ai && pair.user) {
      // 双路径分歧尚未收敛
      const kindFromRoot = rootKey.split('@')[0] as ChainKind
      const rootFromKey = Number(rootKey.split('@')[1])
      items.push({
        type: 'divergence-watch',
        severity: 'warn',
        title: `${rootKey}的${ROLE_LABEL_CN[role]}分歧悬而未决`,
        detail: `AI 推论"${pair.ai.content}"与用户路径"${pair.user.content}"分歧尚未收敛。建议在后续轮次中寻求合流或确认哪条路径成立。`,
        references: [{ scopeKey: `${rootKey}:${role}`, chain: kindFromRoot, root: rootFromKey, role, nodeIds: [pair.ai.id, pair.user.id] }],
        evidence: 1,
        timestamp: now,
      })
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// 分析器 ⑥：快照实时趋势分析（基于当前快照 + 历史趋势）
// ---------------------------------------------------------------------------

/**
 * 基于当前轮次快照与 FilterSelector 历史趋势的实时分析。
 *
 * 能力：
 *   - 链迁移检测：当前快照链与历史快照链不同时，标记认知焦点转移
 *   - Supersede 影响分析：当前快照含 supersede 时，分析认知转折
 *   - 置信度对比：当前快照置信度与历史趋势对比，标记骤降或骤升
 */
function analyzeSnapshotTrend(
  snapshot: ChainSnapshot,
  filterSelector: FilterSelector,
  sessionId: string,
): InsightItem[] {
  const items: InsightItem[] = []
  const now = Date.now()

  // 查询最近 3 个历史快照（不含当前轮次）
  const history = filterSelector.query(sessionId, { type: 'recent-snapshots', limit: 3 })
  // 去掉当前轮次快照（最后一个条目就是当前轮次的）
  const prevSnapshots = history.length >= 2 ? history.slice(0, -1) : []

  // ── ① 链迁移检测 ──
  if (prevSnapshots.length > 0) {
    const prev = prevSnapshots[prevSnapshots.length - 1].snapshot
    if (prev && prev.chain !== snapshot.chain) {
      items.push({
        type: 'migration',
        severity: 'info',
        title: `认知焦点从${CHAIN_LABEL_CN[prev.chain] ?? prev.chain}转向${CHAIN_LABEL_CN[snapshot.chain] ?? snapshot.chain}`,
        detail: `上一轮快照为${prev.chain}，本轮快照为${snapshot.chain}。用户可能切换了关注维度。`,
        references: [{ scopeKey: `migration:${prev.chain}->${snapshot.chain}` }],
        evidence: 1,
        timestamp: now,
      })
    }
  }

  // ── ③ Supersede 影响分析 ──
  if (snapshot.supersede) {
    const reason = snapshot.supersede.reason
    items.push({
      type: 'divergence-watch',
      severity: 'info',
      title: `${CHAIN_LABEL_CN[snapshot.chain] ?? snapshot.chain}认知转折`,
      detail: `用户通过显式回溯推翻了先前的结论：${reason}。这可能意味着新证据出现或认知框架重构。`,
      references: [{ scopeKey: `supersede:${snapshot.chain}@${Date.now()}` }],
      evidence: 1,
      timestamp: now,
    })
  }

  return items
}

// ---------------------------------------------------------------------------
// 推荐话题生成器
//
// 定位：基于洞察的高维推荐，不是追问。
// 追问是"你还没说XX"（补缺，链内视角）；
// 推荐是"我看懂了全局之后，发现你可以往这个方向想"（升维，超然视角）。
//
// 话题必须从实际的洞察结果和链图内容中提炼，带着具体的上下文信息，
// 让用户感受到"AI 理解了我们的对话之后，发现了一个值得探索的新方向"。
// ---------------------------------------------------------------------------

/** 取主链某个角色的内容 */
function primaryRoleContent(graph: ChainGraph, guide: ChainGuide, role: ChainRole): string | undefined {
  const primary = guide.primary
  if (!primary) return undefined
  return nodeContent(graph, primary.kind, primary.root, role)
}

/** 取主链第一个已填充角色的内容（用于话题的上下文锚点） */
function firstFilledContent(graph: ChainGraph, guide: ChainGuide): { role: ChainRole; content: string } | undefined {
  const primary = guide.primary
  if (!primary) return undefined
  for (const r of primary.roles) {
    if (r.state === 'empty') continue
    const content = nodeContent(graph, primary.kind, primary.root, r.role)
    if (content) return { role: r.role, content }
  }
  return undefined
}

/** 取某条链某个角色的内容 */
function chainRoleContent(graph: ChainGraph, kind: ChainKind, role: ChainRole): string | undefined {
  const roots = activeRootsOf(graph, kind)
  if (roots.length === 0) return undefined
  return nodeContent(graph, kind, roots[roots.length - 1], role)
}

/**
 * 从归因后的洞察中提取"用于话题话术的具体内容"。
 *
 * 设计意图（按用户决策）：
 *   - 话题必须依据洞察产生（让用户觉得"AI 真的越来越懂我"）
 *   - 但洞察本身千变万化，不应该按"洞察 type 套固定话术"
 *   - 此函数从 confidenceProfile.nodeEvidence 提取 ChainNode 内容，
 *     让话术引用真实 ChainGraph 内容，而非通用模板
 */
function extractKeyContents(
  insight: InsightItem,
  graph: ChainGraph,
  limit = 3,
): string[] {
  const contents: string[] = []
  const seen = new Set<string>()

  for (const ne of insight.confidenceProfile?.nodeEvidence ?? []) {
    if (ne.role === 'contradicting') continue
    const node = graph.nodes.get(ne.nodeId)
    if (!node?.content) continue
    if (seen.has(node.content)) continue
    seen.add(node.content)
    contents.push(node.content)
    if (contents.length >= limit) break
  }

  return contents
}

/** 从归因档案提取关键边类型（用于 rationale） */
function extractKeyEdgeKinds(insight: InsightItem): string[] {
  const kinds = new Set<string>()
  for (const e of insight.confidenceProfile?.edgeEvidence ?? []) {
    kinds.add(e.kind)
  }
  return [...kinds]
}

/**
 * 从归因档案构造 basedOn 字段（话题的依据档案）
 */
function buildBasedOn(
  insight: InsightItem,
  keyContents: string[],
  keyEdges: string[],
): NonNullable<RecommendationTopic['basedOn']> {
  return {
    insightTitle: insight.title,
    attributionScore: insight.confidenceProfile?.attributionScore ?? 0,
    keyNodeContents: keyContents,
    keyEdgeKinds: keyEdges as NonNullable<RecommendationTopic['basedOn']>['keyEdgeKinds'],
  }
}

function generateTopics(
  graph: ChainGraph,
  guide: ChainGuide,
  insights: InsightItem[],
): RecommendationTopic[] {
  const topics: RecommendationTopic[] = []
  const now = Date.now()
  const primary = guide.primary

  // ── 延展型：从洞察中提炼可探索的方向 ──

  // 1. 化学反应苗头 → 建议沿着交叉点深挖
  //    不是"这两条链有没有联系"，而是"我看到了联系，它意味着什么"
  //    P4-3：话术从归因档案的 nodeEvidence 动态生成，不再是固定模板
  const crossReactions = insights.filter((i) => i.type === 'cross-reaction')
  for (const insight of crossReactions.slice(0, 2)) {
    const keyContents = extractKeyContents(insight, graph, 2)
    const keyEdges = extractKeyEdgeKinds(insight)
    const hasCrossChainLink = keyEdges.includes('cross-chain-link')
    topics.push({
      kind: 'extension',
      question: keyContents.length >= 2
        ? `你提到了"${keyContents[0]}"和"${keyContents[1]}"，我注意到它们之间似乎有联系${hasCrossChainLink ? '（跨链引用已建立）' : ''}——这件事是不是某个更大趋势的一部分？`
        : keyContents.length === 1
          ? `你之前提到"${keyContents[0]}"，我注意到这件事可能不是孤立的——它会不会是一个更大模式的一部分？`
          : '刚才聊到的这些，会不会是同一个更大问题的不同表现？',
      rationale: insight.confidenceProfile?.rationale ?? insight.detail,
      basedOn: buildBasedOn(insight, keyContents, keyEdges),
      timestamp: now,
    })
  }

  // 2. 置信度下降 → 建议重新审视当前结论
  //    不是"置信度降了"，而是"我对这个结论开始不那么确定了"
  //    P4-3：话术直接引用置信度下降的那个具体内容
  const confidenceWarnings = insights.filter(
    (i) => i.type === 'confidence-trend' && i.severity !== 'info',
  )
  for (const insight of confidenceWarnings.slice(0, 1)) {
    const keyContents = extractKeyContents(insight, graph, 1)
    const keyEdges = extractKeyEdgeKinds(insight)
    const score = insight.confidenceProfile?.attributionScore ?? 0
    topics.push({
      kind: 'extension',
      question: keyContents.length > 0
        ? `关于"${keyContents[0]}"，我注意到这条判断的可信度在下降${score > 0 ? `（归因评分 ${score.toFixed(2)}）` : ''}——有没有一些我们还没考虑到的角度，可能改变结论？`
        : '现在的判断可能有些盲区，要不要一起想想还有什么因素被忽略了？',
      rationale: insight.confidenceProfile?.rationale ?? insight.detail,
      basedOn: buildBasedOn(insight, keyContents, keyEdges),
      timestamp: now,
    })
  }

  // 3. 分歧悬而未决 → 建议从更高视角寻找超越分歧的第三种理解
  //    P4-3：话术引用双路径的具体内容（让用户感受到"AI 真的懂我们的分歧"）
  const divergences = insights.filter(
    (i) => i.type === 'divergence-watch' && i.severity === 'warn',
  )
  for (const insight of divergences.slice(0, 1)) {
    const keyContents = extractKeyContents(insight, graph, 2)
    const keyEdges = extractKeyEdgeKinds(insight)
    topics.push({
      kind: 'extension',
      question: keyContents.length >= 2
        ? `你认为"${keyContents[1]}"，但我觉得"${keyContents[0]}"。与其二选一，不如想想这两种看法背后是不是藏着同一个更深层的原因？`
        : '刚才有两种不同的看法，与其二选一，不如想想它们背后是不是藏着同一个更深层的原因？',
      rationale: insight.confidenceProfile?.rationale ?? insight.detail,
      basedOn: buildBasedOn(insight, keyContents, keyEdges),
      timestamp: now,
    })
  }

  // 4. 多链终结角色缺口 → 建议聚焦一个最有杠杆的点先突破
  //    P4-3：话术引用已填充内容 + 主链缺口的具体角色
  const gapAggregation = insights.filter((i) => i.type === 'gap-aggregation')
  for (const insight of gapAggregation.slice(0, 1)) {
    if (primary && primary.gaps.length > 0) {
      const filledContent = firstFilledContent(graph, guide)
      const keyContents = extractKeyContents(insight, graph, 1)
      const keyEdges = extractKeyEdgeKinds(insight)
      const gapRole = primary.gaps[0]
      const gapRoleLabel = ROLE_LABEL_CN[gapRole] ?? gapRole
      topics.push({
        kind: 'extension',
        question: filledContent
          ? `你现在同时在考虑好几个方向。主链${CHAIN_LABEL_CN[primary.kind]}还差"${gapRoleLabel}"。如果只能先突破一个和"${filledContent.content}"相关的问题，你会选哪个？有时候一个点突破了他都会跟着松动。`
          : '你现在同时在考虑好几个方向，如果先聚焦其中一个突破，其他的会不会更容易解决？',
        rationale: insight.confidenceProfile?.rationale ?? insight.detail,
        basedOn: buildBasedOn(insight, keyContents, keyEdges),
        relatedChain: primary.kind,
        timestamp: now,
      })
    }
  }

  // ── 收束型：从全局状态提炼"下一步该做什么" ──

  // 5. 主链完整且置信度稳定 → 建议进入执行或验证阶段
  //    P4-3：话术引用终结角色的具体内容
  if (primary && primary.gaps.length === 0 && !primary.ended && !primary.superseded) {
    const confidenceOk = primary.confidence === undefined || primary.confidence >= 0.6
    if (confidenceOk) {
      const terminalRole = primary.roles[primary.roles.length - 1]
      const terminalContent = primaryRoleContent(graph, guide, terminalRole.role)
      // 主链完整不是"洞察"而是"guide 状态"——这种话题不挂洞察，直接基于 guide
      topics.push({
        kind: 'convergence',
        question: terminalContent
          ? `"${terminalContent}"这个方向看起来站得住${primary.confidence !== undefined ? `（置信度 ${Math.round(primary.confidence * 100)}%）` : ''}。与其继续推演，不如先小范围试一下看看反馈——实践往往能暴露推演看不到的盲点。`
          : '思路已经比较完整了，与其继续分析，不如先迈出第一步看看实际反馈？',
        rationale: `${CHAIN_LABEL_CN[primary.kind]}所有角色已填充${primary.confidence !== undefined ? `，置信度 ${Math.round(primary.confidence * 100)}%` : ''}。`,
        relatedChain: primary.kind,
        timestamp: now,
      })
    }
  }

  // 6. 链已收束且有其他链活跃 → 建议用已收束的链结论去照亮其他链
  //    P4-3：话术引用已收束链和活跃链的具体内容
  const endedChains = guide.chains.filter((c) => c.ended && !c.superseded)
  const activeOtherChains = guide.chains.filter(
    (c) => !c.ended && !c.superseded && primary && c.kind !== primary.kind,
  )
  if (endedChains.length > 0) {
    const chain = endedChains[endedChains.length - 1]
    if (activeOtherChains.length > 0) {
      const endedContent = chainRoleContent(graph, chain.kind,
        ROLE_BY_KIND_START[chain.kind] ?? chain.roles[0].role)
      const otherContent = chainRoleContent(graph, activeOtherChains[0].kind,
        ROLE_BY_KIND_START[activeOtherChains[0].kind] ?? activeOtherChains[0].roles[0].role)
      // 链已收束是 guide 状态——不挂洞察
      topics.push({
        kind: 'convergence',
        question: endedContent && otherContent
          ? `刚才理清了"${endedContent}"，这个结论能不能反过来照一下"${otherContent}"？有时候一个领域的答案正好是另一个领域的钥匙。`
          : '刚才理清的结论，能不能用在正在讨论的另一个问题上？',
        rationale: `${CHAIN_LABEL_CN[chain.kind]}已收束，${activeOtherChains.map((c) => CHAIN_LABEL_CN[c.kind]).join('、')}仍在推进中。`,
        relatedChain: chain.kind,
        timestamp: now,
      })
    } else {
      topics.push({
        kind: 'convergence',
        question: '这个问题算是想透了。有没有其他一直在困扰你的事？换个角度说不定比从零开始容易。',
        rationale: `${CHAIN_LABEL_CN[chain.kind]}已收束，无其他活跃链。`,
        relatedChain: chain.kind,
        timestamp: now,
      })
    }
  }

  return topics
}

// ---------------------------------------------------------------------------
// 池管理辅助函数
// ---------------------------------------------------------------------------

/** 严重程度数值化（排序/淘汰用：info=0, warn=1, critical=2） */
function severityRank(s: Severity): number {
  return s === 'critical' ? 2 : s === 'warn' ? 1 : 0
}

/**
 * 去重作用域 key：
 *   - 有状态类型（divergence-watch / confidence-trend）：按 type + references[0].scopeKey 去重，
 *     scopeKey 本身含 role 信息，同 root 不同角色的分歧/趋势不合并
 *   - 模式类型（cross-reaction / migration / gap-aggregation）：按 type + title 去重
 */
function scopeKeyOf(item: InsightItem): string {
  const ref = item.references?.[0]
  if ((item.type === 'divergence-watch' || item.type === 'confidence-trend') && ref?.scopeKey) {
    return `${item.type}:${ref.scopeKey}`
  }
  return `${item.type}:${item.title}`
}

/** 严重程度升级：evidence >= 2 时 info→warn, warn→critical */
function upgradeSeverity(severity: Severity, evidence: number): Severity {
  if (evidence >= 3) return 'critical'
  if (evidence >= 2) {
    if (severity === 'info') return 'warn'
    if (severity === 'warn') return 'critical'
  }
  return severity
}

// ---------------------------------------------------------------------------
// 归因分析（attributeInsights）：让洞察从"结果评价"升级为"归因诊断"
//
// 设计意图（按用户决策）：
//   - 洞察本身千变万化，不预设内容模板
//   - 但评估洞察的方法论稳定：节点证据 + 边证据 + 反证 + 综合评分
//   - 此模块在 ChainGraph 上做归因推理，让每条洞察附带 ConfidenceProfile
//
// 关键约束：
//   - 纯函数：不修改 ChainGraph、不修改 InsightItem 输入
//   - 零新增存储：归因档案随返回值流转，不持久化
//   - 不干预 CoT：归因档案是"档案"，不参与推理
// ---------------------------------------------------------------------------

/** 证据权重配置（节点证据的 role → 权重） */
const NODE_WEIGHT: Record<'primary' | 'supporting' | 'contradicting', number> = {
  primary: 1.0,
  supporting: 0.6,
  contradicting: 0.4,
}

/**
 * 从 scopeKey 解析结构化字段（P1-5 容错）。
 * 支持的格式：
 *   - `${chain}:${role}`         → { chain, role }
 *   - `${chain}@${root}:${role}` → { chain, root, role }
 * 不支持（返回空对象）：
 *   - `${chain}->...`           → 迁移类 scopeKey，无 role
 *   - 其他未知格式
 */
function parseScopeKey(key: string): {
  chain?: ChainKind; root?: number; role?: ChainRole
} {
  // 匹配 `causal@1:cause` 或 `causal:cause`
  const match = key.match(/^(causal|logic|operation|narrative|temporal)(?:@(\d+))?:(.+)$/)
  if (!match) return {}
  const [, kindStr, rootStr, roleStr] = match
  const chain = kindStr as ChainKind
  const root = rootStr ? Number(rootStr) : undefined
  // 校验 role 是否在合法集合内
  const allRoles: ChainRole[] = [
    'problem', 'cause', 'solution',
    'premise', 'reasoning', 'conclusion',
    'action', 'step', 'result',
    'beginning', 'development', 'twist', 'ending',
    'past', 'present', 'future',
  ]
  if (!allRoles.includes(roleStr as ChainRole)) return {}
  return { chain, root, role: roleStr as ChainRole }
}

/**
 * 步骤 ①：提取节点证据
 *
 * 来源：
 *   - InsightReference.nodeIds（如有）→ 直接定位
 *   - InsightReference.scopeKey（如 `${chain}:${role}`）→ 模糊匹配活跃节点
 *   - 兜底：按 InsightType 选最相关的节点
 */
function extractNodeEvidence(
  insight: InsightItem,
  graph: ChainGraph,
): NodeEvidence[] {
  const evidences: NodeEvidence[] = []
  const seen = new Set<string>()

  const push = (node: ChainNode, role: 'primary' | 'supporting' | 'contradicting') => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    evidences.push({
      nodeId: node.id,
      role,
      weight: NODE_WEIGHT[role],
      confidence: node.confidence,
    })
  }

  // 路径 A：通过 nodeIds 精确匹配（divergence 双路径场景）
  for (const ref of insight.references ?? []) {
    for (const nodeId of ref.nodeIds ?? []) {
      const node = graph.nodes.get(nodeId)
      if (node) push(node, 'primary')
    }
  }

  // 路径 B：通过 scopeKey 模糊匹配（按 chain:role 找最新活跃节点）
  for (const ref of insight.references ?? []) {
    // 优先使用结构化字段，缺失时尝试从 scopeKey 解析（P1-5 容错）
    let chain = ref.chain
    let role = ref.role
    if (!chain || !role && ref.scopeKey) {
      const parsed = parseScopeKey(ref.scopeKey)
      if (parsed.chain && parsed.role) {
        chain = parsed.chain
        role = parsed.role
      }
    }
    if (!ref.scopeKey || !chain || !role) continue
    const matchingNodes: ChainNode[] = []
    for (const node of graph.nodes.values()) {
      if (node.kind !== ref.chain) continue
      if (node.role !== ref.role) continue
      if (node.status !== 'active') continue
      if (ref.root !== undefined) {
        const rootKey = node.id.split('.')[0].replace(/′$/, '')
        if (Number(rootKey.split('@')[1]) !== ref.root) continue
      }
      matchingNodes.push(node)
    }
    // 取最新一个作为 primary，其他作为 supporting
    if (matchingNodes.length > 0) {
      const sorted = [...matchingNodes].sort((a, b) => b.timestamp - a.timestamp)
      push(sorted[0], 'primary')
      for (let i = 1; i < Math.min(sorted.length, 3); i++) {
        push(sorted[i], 'supporting')
      }
    }
  }

  return evidences
}

/**
 * 步骤 ②：提取边证据
 *
 * 来源：扫描节点证据集合中每个节点的 ChainGraph 内置关系
 *   - parent/children → parent-child
 *   - revisionOf → revision
 *   - superseded 状态 → supersede（作废边）
 *   - divergence='ai'/'user' 配对 → diverged-from
 *   - convergedFrom 非空 → converged-into
 *   - links 字段 → cross-chain-link
 */
function extractEdgeEvidence(
  nodeEvidences: NodeEvidence[],
  graph: ChainGraph,
): EdgeEvidence[] {
  const edges: EdgeEvidence[] = []
  const seenEdge = new Set<string>()

  const push = (e: Omit<EdgeEvidence, 'strength'>, strength = 1.0) => {
    const key = `${e.kind}:${e.fromNodeId}->${e.toNodeId}`
    if (seenEdge.has(key)) return
    seenEdge.add(key)
    edges.push({ ...e, strength })
  }

  for (const ne of nodeEvidences) {
    const node = graph.nodes.get(ne.nodeId)
    if (!node) continue

    // parent-child
    if (node.parent) push({ kind: 'parent-child', fromNodeId: node.parent, toNodeId: node.id })
    for (const childId of node.children) {
      push({ kind: 'parent-child', fromNodeId: node.id, toNodeId: childId })
    }

    // revision
    if (node.revisionOf) push({ kind: 'revision', fromNodeId: node.revisionOf, toNodeId: node.id })

    // supersede（节点本身被 superseded，但有 supersedeRoot 关系）
    if (node.status === 'superseded') {
      push({ kind: 'supersede', fromNodeId: node.id, toNodeId: `${node.id}′` }, 0.8)
    }

    // cross-chain-link
    for (const linkId of node.links ?? []) {
      push({ kind: 'cross-chain-link', fromNodeId: node.id, toNodeId: linkId })
    }

    // diverged-from：扫描是否有同 rootKey+role 的对偶 divergence 节点
    if (node.divergence) {
      const rootKey = node.id.split('.')[0].replace(/′$/, '')
      for (const other of graph.nodes.values()) {
        if (other.id === node.id) continue
        if (other.divergence === undefined) continue
        if (other.divergence === node.divergence) continue
        const otherRootKey = other.id.split('.')[0].replace(/′$/, '')
        if (otherRootKey !== rootKey) continue
        if (other.role !== node.role) continue
        // 找到对偶节点，建一条共享根的边（用一个虚拟根 id）
        push({
          kind: 'diverged-from',
          fromNodeId: rootKey,
          toNodeId: node.id,
        })
        break  // 只取第一个对偶
      }
    }

    // converged-into：节点是合流点
    if (node.convergedFrom && node.convergedFrom.length > 0) {
      for (const from of node.convergedFrom) {
        push({
          kind: 'converged-into',
          fromNodeId: from,
          toNodeId: node.id,
        })
      }
    }
  }

  return edges
}

/**
 * 步骤 ③：识别反证
 *
 * 识别四种反证类型：
 *   - superseded：节点证据中的某个节点被 superseded
 *   - reverse-divergence：节点证据中有 diverged 双路径未合流
 *   - confidence-decay：节点 confidence 已被标低或缺失
 *   - no-support：完全没有支撑证据（节点证据为空）
 */
function findContradictions(
  insight: InsightItem,
  nodeEvidences: NodeEvidence[],
  edgeEvidences: EdgeEvidence[],
): ContradictingEvidence[] {
  const contradictions: ContradictingEvidence[] = []

  // 类型 A：superseded — 存在 supersede 关系边，说明被引用的节点已被新节点作废，
  // 该洞察的部分支撑失效，构成反向证据。
  const supersedeEdges = edgeEvidences.filter((e) => e.kind === 'supersede')
  for (const e of supersedeEdges) {
    contradictions.push({
      kind: 'superseded',
      refId: e.toNodeId,
      strength: e.strength * 0.9,
      note: `节点 ${e.toNodeId} 已被节点 ${e.fromNodeId} 作废(supersede)，相关结论可能失效`,
    })
  }
  // 引用中包含的节点若被 supersede 边指向，说明该节点已被作废
  const supersededNodeIds = new Set(
    edgeEvidences.filter((e) => e.kind === 'supersede').map((e) => e.toNodeId)
  )
  for (const ref of insight.references ?? []) {
    for (const nid of ref.nodeIds ?? []) {
      if (supersededNodeIds.has(nid)) {
        contradictions.push({
          kind: 'superseded',
          refId: nid,
          strength: 0.8,
          note: `引用节点 ${nid} 已被标记 superseded`,
        })
      }
    }
  }

  // 类型 B：reverse-divergence — 存在 diverged-from 边但缺少对应的 converged-into 边，
  // 说明出现过双路径分叉却未合流，洞察依赖的脉络存在未收敛风险。
  const divergedFrom = edgeEvidences.filter((e) => e.kind === 'diverged-from')
  const convergedInto = edgeEvidences.filter((e) => e.kind === 'converged-into')
  for (const e of divergedFrom) {
    const hasConverged = convergedInto.some(
      (c) => c.fromNodeId === e.fromNodeId || c.toNodeId === e.toNodeId,
    )
    if (!hasConverged) {
      contradictions.push({
        kind: 'reverse-divergence',
        refId: e.fromNodeId,
        strength: e.strength * 0.8,
        note: `节点 ${e.fromNodeId} 分叉出双路径(${e.toNodeId})但未合流，脉络未收敛`,
      })
    }
  }

  // 类型 C：confidence 缺失或为 0
  for (const ne of nodeEvidences) {
    if (ne.confidence === 0) {
      contradictions.push({
        kind: 'confidence-decay',
        refId: ne.nodeId,
        strength: 0.7,
        note: '节点 confidence 为 0，结论可能不成立',
      })
    } else if (ne.confidence === undefined) {
      contradictions.push({
        kind: 'confidence-decay',
        refId: ne.nodeId,
        strength: 0.3,
        note: '节点未声明 confidence，证据强度不明',
      })
    }
  }

  // 类型 D：完全无支撑
  if (nodeEvidences.length === 0 && edgeEvidences.length === 0) {
    contradictions.push({
      kind: 'no-support',
      refId: insight.title,
      strength: 1.0,
      note: '在 ChainGraph 中找不到任何支撑此洞察的节点或边',
    })
  }

  return contradictions
}

/**
 * 步骤 ④：综合评分
 *
 * 评分公式（按 AGENTS.md §1"简单第一"原则，保持可解释）：
 *   base = Σ(nodeEvidence.weight × (confidence ?? 0.5)) / Σ(nodeEvidence.weight)
 *   edgeBoost = min(edgeEvidences.length × 0.1, 0.3)  // 边证据加成（上限 0.3）
 *   contradictionPenalty = Σ(contradiction.strength) × 0.2  // 反证惩罚
 *   final = clamp(base + edgeBoost - contradictionPenalty, 0, 1)
 *
 * 设计意图：
 *   - 节点证据是基础（决定 base）
 *   - 边证据是加成（结构化关系越多越可信）
 *   - 反证是惩罚（强度越大扣分越多）
 *   - 整体保持 0-1 区间，可解释
 */
function computeScore(
  nodeEvidences: NodeEvidence[],
  edgeEvidences: EdgeEvidence[],
  contradictions: ContradictingEvidence[],
): { score: number; rationale: string } {
  // base：节点证据加权平均
  let base: number
  if (nodeEvidences.length === 0) {
    base = 0
  } else {
    let weightedSum = 0
    let weightSum = 0
    for (const ne of nodeEvidences) {
      const conf = ne.confidence ?? 0.5
      // contradicting 角色不参与正向评分
      if (ne.role === 'contradicting') continue
      weightedSum += ne.weight * conf
      weightSum += ne.weight
    }
    base = weightSum > 0 ? weightedSum / weightSum : 0
  }

  // edgeBoost：边证据加成（结构化关系越多越加分）
  const edgeBoost = Math.min(edgeEvidences.length * 0.1, 0.3)

  // contradictionPenalty：反证惩罚
  const contradictionPenalty = contradictions.reduce((sum, c) => sum + c.strength, 0) * 0.2

  const final = Math.max(0, Math.min(1, base + edgeBoost - contradictionPenalty))

  // rationale：人类可读的归因路径
  const parts: string[] = []
  parts.push(`节点证据 ${nodeEvidences.length} 条（base=${base.toFixed(2)}）`)
  if (edgeEvidences.length > 0) {
    parts.push(`边证据 ${edgeEvidences.length} 条（+${edgeBoost.toFixed(2)}）`)
  }
  if (contradictions.length > 0) {
    parts.push(`反证 ${contradictions.length} 条（-${contradictionPenalty.toFixed(2)}）`)
  }
  parts.push(`综合可信度 ${final.toFixed(2)}`)

  return { score: final, rationale: parts.join('；') }
}

/**
 * 归因分析主入口：纯函数，输出带 ConfidenceProfile 的 InsightItem[]。
 *
 * 行为契约：
 *   - 不修改输入 insight
 *   - 不修改 graph
 *   - 返回新对象数组（每条 insight 带新生成的 confidenceProfile）
 *   - 时间复杂度 O(N + E)，N = 节点证据数，E = 边证据数
 *
 * 导出：用于测试（verify-attribution.ts 直接验证行为契约）
 */
export function attributeInsightsPure(
  insights: InsightItem[],
  graph: ChainGraph,
): InsightItem[] {
  return insights.map((insight) => {
    const nodeEvidences = extractNodeEvidence(insight, graph)
    const edgeEvidences = extractEdgeEvidence(nodeEvidences, graph)
    const contradictions = findContradictions(insight, nodeEvidences, edgeEvidences)
    const { score, rationale } = computeScore(nodeEvidences, edgeEvidences, contradictions)

    const confidenceProfile: ConfidenceProfile = {
      nodeEvidence: nodeEvidences,
      edgeEvidence: edgeEvidences,
      contradictingEvidence: contradictions,
      attributionScore: score,
      rationale,
    }

    return { ...insight, confidenceProfile }
  })
}

// ---------------------------------------------------------------------------
// InsightEngine 实现
// ---------------------------------------------------------------------------

/** 会话总数上限（8.7 内存保护超限时淘汰最旧不活跃会话，默认值） */
const DEFAULT_MAX_SESSIONS = 100

/**
 * 创建过滤/选择器（洞察模块入口组件，规则由洞察需求驱动）。
 *
 * 内存级累积 SessionEventInput → InsightHistoryItem，按 InsightNeed 查询。
 * 窗口大小 HISTORY_WINDOW（最近 20 轮 = 40 条消息），FIFO 淘汰最旧项。
 * 会话数上限由 InsightEngine 统一淘汰，本组件不再自行淘汰（P1-1 架构加固）。
 * 重载归零（超然层无状态观察，符合设计）。
 *
 * 独立工厂函数，可单独 mock 测试 FilterSelector 而不依赖 InsightEngine。
 * P0 可配置化：接受 historyWindow 参数。
 */
export function createFilterSelector(
  historyWindow = DEFAULT_HISTORY_WINDOW,
  _maxSessions?: number, // 已由 InsightEngine 统一淘汰，本参数保留为兼容
): FilterSelector {
  /** sessionId → 累积的历史项 */
  const histories = new Map<string, InsightHistoryItem[]>()
  /** sessionId → 已累积的 assistant 消息数（用于 round 计数） */
  const rounds = new Map<string, number>()

  function getHistory(sessionId: string): InsightHistoryItem[] {
    let h = histories.get(sessionId)
    if (!h) {
      h = []
      histories.set(sessionId, h)
    }
    return h
  }

  function getRound(sessionId: string): number {
    return rounds.get(sessionId) ?? 0
  }

  return {
    ingest(sessionId, event) {
      const history = getHistory(sessionId)
      // assistant 消息递增 round；user 消息沿用当前 round（与最近一条 assistant 同轮）
      let round = getRound(sessionId)
      if (event.role === 'assistant') {
        round += 1
        rounds.set(sessionId, round)
      }

      const item: InsightHistoryItem = {
        role: event.role,
        text: event.text,
        snapshot: event.snapshot,
        round,
        timestamp: event.timestamp,
      }
      history.push(item)

      // 窗口淘汰（FIFO 最旧项）
      if (history.length > historyWindow) {
        history.splice(0, history.length - historyWindow)
      }
    },

    query(sessionId, need) {
      const history = histories.get(sessionId) ?? []
      switch (need.type) {
        case 'recent-snapshots':
          return history.filter((h) => h.snapshot !== undefined).slice(-need.limit)
        case 'reference-to-past': {
          const kws = need.keywords ?? DEFAULT_PAST_KEYWORDS
          const filtered = history.filter((h) => kws.some((kw) => h.text.includes(kw)))
          return filtered.slice(0, 10)
        }
        case 'role-sequence':
          return history.filter((h) => h.role === need.role).slice(-need.limit)
        case 'by-keyword': {
          const limit = need.limit ?? 20
          return history.filter((h) => h.text.includes(need.keyword)).slice(-limit)
        }
        case 'all':
          return history.slice(-need.limit)
      }
    },

    dispose(sessionId) {
      histories.delete(sessionId)
      rounds.delete(sessionId)
    },
  }
}

/** 创建会话内洞察引擎（可注入日志器、配置；P0 可配置化） */
export function createInsightEngine(
  logger?: { info: (msg: string) => void },
  config?: InsightConfig,
): InsightEngine {
  // 解析配置（默认值回退）
  const HISTORY_WINDOW = config?.historyWindow ?? DEFAULT_HISTORY_WINDOW
  const MAX_INSIGHTS = config?.maxInsights ?? DEFAULT_MAX_INSIGHTS
  const MAX_TOPICS = config?.maxTopics ?? DEFAULT_MAX_TOPICS
  const MAX_STALE_ROUNDS = config?.maxStaleRounds ?? DEFAULT_MAX_STALE_ROUNDS
  const SIMILARITY_THRESHOLD = config?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const MAX_SESSIONS = config?.maxSessions ?? DEFAULT_MAX_SESSIONS
  const selectiveAnalysis = config?.selectiveAnalysis ?? false

  /** Session ID 标准化：去除空白、统一大小写、长度限制，确保存储/获取键一致 */
  function normalizeSessionId(id: string): string {
    return id.trim().toLowerCase().slice(0, 128)
  }

  const stores = new Map<string, InsightStore>()
  const log = logger ?? { info: () => {} }
  let lastSessionId = ''
  /** Client 激活标志：按 sessionId 记录，一个会话激活不影响其他会话 */
  const clientActive = new Map<string, boolean>()
  /** 过滤/选择器：洞察模块入口组件，累积 session 事件供分析器按需查询 */
  const filterSelector = createFilterSelector(HISTORY_WINDOW, MAX_SESSIONS)

  /** 简易事件总线（P2：SSE 实时推送用，替代轮询） */
  type EventMap = {
    'topics-changed': { sessionId: string; topics: RecommendationTopic[] }
  }
  const listeners = new Map<keyof EventMap, Set<(payload: any) => void>>()
  function on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): () => void {
    const set = listeners.get(event) ?? new Set()
    set.add(handler)
    listeners.set(event, set)
    return () => { set.delete(handler) }
  }
  function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const handlers = listeners.get(event)
    if (!handlers) return
    for (const h of [...handlers]) {
      try { h(payload) }
      catch (err) {
        handlers.delete(h)
        log.info(`[insight] topics-changed handler 崩溃（已自动移除）: ${String(err).slice(0, 80)}`)
      }
    }
  }

  function getStore(sessionId: string): InsightStore {
    const normId = normalizeSessionId(sessionId)
    let s = stores.get(normId)
    if (!s) {
      s = { insights: [], topics: [], round: 0 }
      stores.set(normId, s)
    }
    return s
  }

  /**
   * 洞察池合并 + 过期淘汰 + 优先级淘汰
   *
   * 三层处理：
   *   1. 合并：同 scopeKey 的新洞察进来时
   *      - title 相同 → 证据合并（evidence++, 升级 severity, 刷新 lastSeenRound）
   *      - title 不同 → 状态变更，替换旧洞察（如"悬而未决"→"已收敛"）
   *   2. 过期淘汰：连续 MAX_STALE_ROUNDS 轮未被重新确认 → 移除
   *   3. 优先级淘汰：超过 MAX_INSIGHTS 时，按 evidence ASC + severity ASC 淘汰最低
   */
  function appendInsights(store: InsightStore, newItems: InsightItem[], round: number): void {
    // 先执行过期淘汰 + 优先级淘汰，再建 scopeMap（避免淘汰后索引漂移）
    store.insights = store.insights.filter(
      (i) => round - (i.lastSeenRound ?? 0) < MAX_STALE_ROUNDS,
    )
    while (store.insights.length > MAX_INSIGHTS) {
      let victimIdx = 0
      let victimScore = -Infinity
      for (let i = 0; i < store.insights.length; i++) {
        // 高 severity + 高 evidence → 低 score → 保留；高 score → 淘汰
        const score = (3 - severityRank(store.insights[i].severity)) * 10 - store.insights[i].evidence
        if (score > victimScore) {
          victimScore = score
          victimIdx = i
        }
      }
      store.insights.splice(victimIdx, 1)
    }

    // 建 scopeMap（基于淘汰后的干净数组）
    const scopeMap = new Map<string, number>()
    for (let i = 0; i < store.insights.length; i++) {
      scopeMap.set(scopeKeyOf(store.insights[i]), i)
    }

    for (const item of newItems) {
      const key = scopeKeyOf(item)
      const idx = scopeMap.get(key)

      if (idx !== undefined) {
        const existing = store.insights[idx]

        if (existing.title === item.title) {
          // 同一信号重复检测 → 证据合并
          existing.evidence += 1
          existing.timestamp = item.timestamp
          existing.detail = item.detail
          existing.severity = upgradeSeverity(existing.severity, existing.evidence)
          existing.lastSeenRound = round
          if (item.references) {
            const seen = new Set(existing.references?.map((r) => r.scopeKey) ?? [])
            const refs = existing.references ?? []
            for (const ref of item.references) {
              if (!seen.has(ref.scopeKey)) {
                refs.push(ref)
                seen.add(ref.scopeKey)
              }
            }
            existing.references = refs
          }
        } else {
          // 状态变更（如"悬而未决"→"已收敛"）→ 替换，evidence 重置为 1
          existing.title = item.title
          existing.detail = item.detail
          existing.severity = item.severity
          existing.evidence = 1
          existing.timestamp = item.timestamp
          existing.references = item.references
          existing.lastSeenRound = round
        }
        continue
      }

      // 新洞察
      item.lastSeenRound = round
      store.insights.push(item)
      scopeMap.set(key, store.insights.length - 1)
    }

    // 过期淘汰与优先级淘汰已移至函数开头（淘汰后建 scopeMap，避免索引漂移）
  }

  /** 话题池：每轮重建（话题反映当前状态，不积累历史） */
  function rebuildTopics(store: InsightStore, newTopics: RecommendationTopic[]): void {
    store.topics = newTopics.slice(0, MAX_TOPICS)
    emit('topics-changed', { sessionId: lastSessionId, topics: [...store.topics] })
  }

  return {
    analyze(sessionId, graph, guide, _snapshot, changeContext) {
      // 当前轮次快照已通过 ingestEvent 进入 FilterSelector。
      // _snapshot 参数用于"当前快照+历史趋势"实时分析（分析器 ⑥）。
      const normSessionId = normalizeSessionId(sessionId)

      // 会话数超限时淘汰最旧不活跃会话（8.7 内存保护，基于 stores 自身 round 而非独立 LRU）
      while (stores.size > MAX_SESSIONS) {
        let victimId: string | undefined
        let minRound = Infinity
        for (const [sid, store] of stores) {
          if (store.round < minRound) {
            minRound = store.round
            victimId = sid
          }
        }
        if (victimId !== undefined) {
          stores.delete(victimId)
          clientActive.delete(victimId)
          filterSelector.dispose(victimId)
        } else {
          break
        }
      }

      const store = getStore(normSessionId)
      lastSessionId = normSessionId
      store.round += 1
      const round = store.round
      const nodeCount = graph.nodes.size

      // P1 选择性分析器：若启用且有 changeContext，按需触发
      let runAll = !selectiveAnalysis || !changeContext
      const changes = changeContext?.changes ?? new Set<ChainChangeType>()
      const isFirst = changeContext?.isFirstRound ?? (round === 1)

      // 确定本轮运行哪些分析器
      const shouldRun = (triggers: ChainChangeType[]): boolean => {
        if (runAll || isFirst) return true
        return triggers.some((t) => changes.has(t))
      }

      // 6 个分析器按需跑（纯函数，互不依赖）
      const allInsights: InsightItem[] = [
        ...(shouldRun(['chain-added', 'chain-removed', 'chain-type-changed', 'structure-changed']) ? analyzeCrossReaction(graph) : []),
        ...(shouldRun(['chain-added', 'chain-removed', 'chain-type-changed', 'structure-changed']) ? analyzeMigration(graph, guide) : []),
        ...(shouldRun(['confidence-shift', 'supersede-detected']) ? analyzeConfidenceTrend(_snapshot ?? null, filterSelector, sessionId) : []),
        ...(shouldRun(['terminal-filled', 'terminal-emptied', 'structure-changed']) ? analyzeGapAggregation(guide) : []),
        ...(shouldRun(['divergence-detected', 'structure-changed']) ? analyzeDivergence(graph) : []),
        ...(_snapshot && shouldRun(['supersede-detected', 'confidence-shift', 'chain-type-changed']) ? analyzeSnapshotTrend(_snapshot, filterSelector, sessionId) : []),
      ]

      log.info(`[insight] analyze @ ${sessionId.slice(0, 8)} round ${round}: 图 ${nodeCount} 节点 → ${allInsights.length} 洞察`)

      // 先归因本轮新洞察，再入库
      const attributedFresh = attributeInsightsPure(allInsights, graph)
      appendInsights(store, attributedFresh, round)

      // 保持 store.insights 整体归因（getInsights 需要返回带 profile 的）
      store.insights = attributeInsightsPure(store.insights, graph)

      // P4-3：话题生成依赖归因后的本轮洞察（每轮重建）
      const thisRoundInsights = store.insights.filter(
        (i) => i.lastSeenRound === round,
      )
      const topics = generateTopics(graph, guide, thisRoundInsights)
      log.info(`[insight] 话题: ${topics.length} 条`)
      rebuildTopics(store, topics)
    },

    getInsights(sessionId, type) {
      const store = stores.get(normalizeSessionId(sessionId))
      if (!store) return []
      const filtered = type
        ? store.insights.filter((i) => i.type === type)
        : [...store.insights]
      // 按 severity DESC + evidence DESC 排序
      return filtered.sort((a, b) => {
        const sv = severityRank(b.severity) - severityRank(a.severity)
        return sv !== 0 ? sv : b.evidence - a.evidence
      })
    },

    /**
     * 归因分析：对当前会话已有洞察做可信度评估。
     *
     * 实现说明：归因需要访问 ChainGraph，但 InsightEngine 不持有 graph（graph 由
     * ChainIndex 管理并通过 analyze() 传入）。归因计算在 analyze() 末尾统一执行，
     * 归因结果直接附加到 store.insights 中（覆盖原值）。
     *
     * 本方法返回已附加 confidenceProfile 的洞察列表（懒查询）。
     */
    getAttributedInsights(sessionId) {
      const store = stores.get(normalizeSessionId(sessionId))
      if (!store) return []
      return store.insights.map((i) => ({ ...i }))
    },

    getTopics(sessionId) {
      const store = stores.get(normalizeSessionId(sessionId))
      if (!store) return []
      return [...store.topics]
    },

    getLatestTopics(): TopicsResult {
      // 注意：如果最后一个活跃会话被 LRU 淘汰，返回 { topics: [], evicted: true }。
      // evicted=true 时调用方可提示"会话已过期，建议刷新"
      if (!lastSessionId) return { topics: [], lastSessionId: null, evicted: false }
      const store = stores.get(normalizeSessionId(lastSessionId))
      if (!store) return { topics: [], lastSessionId, evicted: true }
      return { topics: [...store.topics], lastSessionId, evicted: false }
    },

    hasStore(sessionId: string): boolean {
      return stores.has(normalizeSessionId(sessionId))
    },

    hasTopics(sessionId: string): boolean {
      const store = stores.get(normalizeSessionId(sessionId))
      return store !== undefined && store.topics.length > 0
    },

    on(event: 'topics-changed', handler: (payload: { sessionId: string; topics: RecommendationTopic[] }) => void): () => void {
      return on(event, handler)
    },

    markClientActive(sessionId: string) {
      const normId = normalizeSessionId(sessionId)
      if (!clientActive.get(normId)) {
        clientActive.set(normId, true)
        log.info(`[insight] Client 已激活（session ${normId}），后续话题由 Client UI 承担展示`)
      }
    },

    isClientActive(sessionId) {
      return clientActive.get(normalizeSessionId(sessionId)) === true
    },

    ingestEvent(sessionId, event) {
      const normId = normalizeSessionId(sessionId)
      filterSelector.ingest(normId, event)
    },

    dispose(sessionId) {
      const normId = normalizeSessionId(sessionId)
      const startTime = Date.now()
      const hadStore = stores.has(normId)
      const hadTopics = clientActive.has(normId)
      const insightsCount = stores.get(normId)?.insights.length ?? 0
      const topicsCount = stores.get(normId)?.topics.length ?? 0
      stores.delete(normId)
      filterSelector.dispose(normId)
      clientActive.delete(normId)
      const duration = Date.now() - startTime
      if (duration > 10 || hadStore) {
        log.info(`[诊断] insightEngine.dispose ${hadStore ? '清理' : '无存储'} ${duration}ms (session: ${normId}, insights: ${insightsCount}, topics: ${topicsCount}, clientActive: ${hadTopics})`)
      }
    },
  }
}

