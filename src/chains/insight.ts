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
  filterSelector: FilterSelector,
  sessionId: string,
): InsightItem[] {
  const items: InsightItem[] = []
  const now = Date.now()

  // 查询最近 20 个含快照的消息
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

  for (const [key, seq] of confMap) {
    if (seq.length < 2) continue

    // 计算连续下降次数
    let decreasing = 0
    for (let i = seq.length - 1; i > 0; i--) {
      if (seq[i] < seq[i - 1]) decreasing++
      else break
    }

    const latest = seq[seq.length - 1]
    const chain = key.split(':')[0] as ChainKind
    const role = key.split(':')[1] as ChainRole

    if (decreasing >= 3 || (decreasing >= 2 && latest < 0.4)) {
      items.push({
        type: 'confidence-trend',
        severity: 'critical',
        title: `${chain}的${ROLE_LABEL_CN[role]}置信度骤降`,
        detail: `置信度连续 ${decreasing} 轮下降（最新 ${Math.round(latest * 100)}%），建议确认该结论是否仍成立。`,
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
      items.push({
        type: 'divergence-watch',
        severity: 'info',
        title: `${rootKey}的${ROLE_LABEL_CN[role]}分歧已收敛`,
        detail: `AI 与用户在${ROLE_LABEL_CN[role]}上的分歧已通过合流解决。`,
        references: [{ scopeKey: `${rootKey}:${role}`, chain: kindFromRoot, root: rootFromKey, role }],
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

  // ── ② Supersede 影响分析 ──
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

  // ── ③ 置信度对比 ──
  if (prevSnapshots.length > 0) {
    const prev = prevSnapshots[prevSnapshots.length - 1].snapshot
    if (prev) {
      for (const [role, value] of Object.entries(snapshot.nodes) as [ChainRole, SnapshotNodeValue | undefined][]) {
        if (value?.confidence === undefined) continue
        // 查找上一轮同角色置信度
        const prevValue = prev.nodes[role]
        const prevConfidence = prevValue?.confidence
        if (prevConfidence === undefined) continue

        const drop = prevConfidence - value.confidence
        if (drop >= 0.3) {
          items.push({
            type: 'confidence-trend',
            severity: 'warn',
            title: `${CHAIN_LABEL_CN[snapshot.chain] ?? snapshot.chain}的${ROLE_LABEL_CN[role]}置信度骤降`,
            detail: `置信度从 ${Math.round(prevConfidence * 100)}% 降至 ${Math.round(value.confidence * 100)}%（降幅 ${Math.round(drop * 100)}%）。建议确认该结论是否仍成立。`,
            references: [{ scopeKey: `${snapshot.chain}:${role}`, chain: snapshot.chain, role }],
            evidence: 1,
            timestamp: now,
          })
        }
      }
    }
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
  const crossReactions = insights.filter((i) => i.type === 'cross-reaction')
  for (const insight of crossReactions.slice(0, 2)) {
    // 尝试从洞察 detail 中提取已重叠的内容关键词
    const primaryContent = firstFilledContent(graph, guide)
    topics.push({
      kind: 'extension',
      question: primaryContent
        ? `刚才聊到"${primaryContent.content}"，但我注意到这件事可能不是孤立的现象——如果把时间线拉长来看，它会不会是一个更大趋势的一部分？`
        : '刚才聊到的这些，会不会是同一个更大问题的不同表现？',
      rationale: insight.detail,
      timestamp: now,
    })
  }

  // 2. 置信度下降 → 建议重新审视当前结论
  //    不是"置信度降了"，而是"我对这个结论开始不那么确定了，有没有遗漏的角度？"
  const confidenceWarnings = insights.filter(
    (i) => i.type === 'confidence-trend' && i.severity !== 'info',
  )
  for (const insight of confidenceWarnings.slice(0, 1)) {
    // 从洞察 references 回溯到具体内容
    let contentHint: string | undefined
    const ref = insight.references?.[0]
    if (ref && ref.chain && ref.role) {
      if (ref.root !== undefined) {
        contentHint = nodeContent(graph, ref.chain, ref.root, ref.role)
      } else {
        // 无 root 信息（confidence-trend 不追踪 root）→ 取该链最新根对应角色
        contentHint = chainRoleContent(graph, ref.chain, ref.role)
      }
    }
    topics.push({
      kind: 'extension',
      question: contentHint
        ? `关于"${contentHint}"，我现在的判断可能不够全面——有没有一些我们还没考虑到的因素，可能改变结论？`
        : '现在的判断可能有些盲区，要不要一起想想还有什么因素被忽略了？',
      rationale: insight.detail,
      timestamp: now,
    })
  }

  // 3. 分歧悬而未决 → 建议从更高视角寻找超越分歧的第三种理解
  //    不是"哪个对"，而是"两种看法背后有没有更深的共同原因？"
  const divergences = insights.filter(
    (i) => i.type === 'divergence-watch' && i.severity === 'warn',
  )
  for (const insight of divergences.slice(0, 1)) {
    topics.push({
      kind: 'extension',
      question: '刚才有两种不同的看法，与其二选一，不如想想它们背后是不是藏着同一个更深层的原因？',
      rationale: insight.detail,
      timestamp: now,
    })
  }

  // 4. 多链终结角色缺口 → 建议聚焦一个最有杠杆的点先突破
  //    不是"你有好几个问题没解决"，而是"我注意到你在多个方向同时探索，但也许先突破一个点会带动全局"
  const gapAggregation = insights.filter((i) => i.type === 'gap-aggregation')
  for (const insight of gapAggregation.slice(0, 1)) {
    // 找到主链的缺口，结合主链已有内容给出有杠杆感的建议
    if (primary && primary.gaps.length > 0) {
      const filledContent = firstFilledContent(graph, guide)
      const gapRole = primary.gaps[0]
      topics.push({
        kind: 'extension',
        question: filledContent
          ? `你现在同时在考虑好几个方向。如果只能先解决一个和"${filledContent.content}"相关的问题，你会选哪个？有时候一个点突破了他都会跟着松动。`
          : '你现在同时在考虑好几个方向，如果先聚焦其中一个突破，其他的会不会更容易解决？',
        rationale: insight.detail,
        relatedChain: primary.kind,
        timestamp: now,
      })
    }
  }

  // ── 收束型：从全局状态提炼"下一步该做什么" ──

  // 5. 主链完整且置信度稳定 → 建议进入执行或验证阶段
  //    不是"分析完了"，而是"思路已经清晰，现在最有价值的事情是验证它"
  if (primary && primary.gaps.length === 0 && !primary.ended && !primary.superseded) {
    const confidenceOk = primary.confidence === undefined || primary.confidence >= 0.6
    if (confidenceOk) {
      // 取主链的终结角色内容（方案/结论/结果等）作为锚点
      const terminalRole = primary.roles[primary.roles.length - 1]
      const terminalContent = primaryRoleContent(graph, guide, terminalRole.role)
      topics.push({
        kind: 'convergence',
        question: terminalContent
          ? `"${terminalContent}"这个方向看起来站得住。与其继续推演，不如先小范围试一下看看反馈——实践往往能暴露推演看不到的盲点。`
          : '思路已经比较完整了，与其继续分析，不如先迈出第一步看看实际反馈？',
        rationale: `${CHAIN_LABEL_CN[primary.kind]}所有角色已填充${primary.confidence !== undefined ? `，置信度 ${Math.round(primary.confidence * 100)}%` : ''}。`,
        relatedChain: primary.kind,
        timestamp: now,
      })
    }
  }

  // 6. 链已收束且有其他链活跃 → 建议用已收束的链结论去照亮其他链
  //    不是"接下来做什么"，而是"刚才理清的东西，可以用来重新审视另一个问题"
  const endedChains = guide.chains.filter((c) => c.ended && !c.superseded)
  const activeOtherChains = guide.chains.filter(
    (c) => !c.ended && !c.superseded && primary && c.kind !== primary.kind,
  )
  for (const chain of endedChains.slice(-1)) {
    if (activeOtherChains.length > 0) {
      const endedContent = chainRoleContent(graph, chain.kind,
        ROLE_BY_KIND_START[chain.kind] ?? chain.roles[0].role)
      const otherContent = chainRoleContent(graph, activeOtherChains[0].kind,
        ROLE_BY_KIND_START[activeOtherChains[0].kind] ?? activeOtherChains[0].roles[0].role)
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
// InsightEngine 实现
// ---------------------------------------------------------------------------

/** 会话总数上限（8.7 内存保护超限时淘汰最旧不活跃会话，默认值） */
const DEFAULT_MAX_SESSIONS = 100

/** 会话访问记录（LRU 淘汰用） */
class SessionAccessTracker {
  private readonly order: string[] = []

  access(sessionId: string): void {
    const idx = this.order.indexOf(sessionId)
    if (idx >= 0) this.order.splice(idx, 1)
    this.order.push(sessionId)
  }

  /** 返回最旧不活跃会话（超过上限时淘汰），或 undefined */
  evictIfOverLimit(limit: number): string | undefined {
    while (this.order.length > limit) {
      return this.order.shift()
    }
    return undefined
  }

  remove(sessionId: string): void {
    const idx = this.order.indexOf(sessionId)
    if (idx >= 0) this.order.splice(idx, 1)
  }

  get size(): number {
    return this.order.length
  }
}

/**
 * 创建过滤/选择器（洞察模块入口组件，规则由洞察需求驱动）。
 *
 * 内存级累积 SessionEventInput → InsightHistoryItem，按 InsightNeed 查询。
 * 窗口大小 HISTORY_WINDOW（最近 20 轮 = 40 条消息），FIFO 淘汰最旧项。
 * 会话数上限 MAX_SESSIONS（8.7），超限时淘汰最旧不活跃会话。
 * 重载归零（超然层无状态观察，符合设计）。
 *
 * 独立工厂函数，可单独 mock 测试 FilterSelector 而不依赖 InsightEngine。
 * P0 可配置化：接受 historyWindow 和 maxSessions 参数。
 */
export function createFilterSelector(
  historyWindow = DEFAULT_HISTORY_WINDOW,
  maxSessions = DEFAULT_MAX_SESSIONS,
): FilterSelector {
  /** sessionId → 累积的历史项 */
  const histories = new Map<string, InsightHistoryItem[]>()
  /** sessionId → 已累积的 assistant 消息数（用于 round 计数） */
  const rounds = new Map<string, number>()
  const access = new SessionAccessTracker()

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
      access.access(sessionId)

      // 会话数超限时淘汰最旧不活跃会话（8.7 内存保护）
      const evicted = access.evictIfOverLimit(maxSessions)
      if (evicted !== undefined) {
        histories.delete(evicted)
        rounds.delete(evicted)
      }
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
      access.remove(sessionId)
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
  /** 会话访问跟踪（8.7 内存保护） */
  const access = new SessionAccessTracker()

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
    listeners.get(event)?.forEach((h) => h(payload))
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
      let victimScore = Infinity
      for (let i = 0; i < store.insights.length; i++) {
        const score = store.insights[i].evidence * 10 + severityRank(store.insights[i].severity)
        if (score < victimScore) {
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
      access.access(sessionId)

      // 会话数超限时淘汰最旧不活跃会话（8.7 内存保护）
      const evicted = access.evictIfOverLimit(MAX_SESSIONS)
      if (evicted !== undefined) {
        const normEvicted = normalizeSessionId(evicted)
        stores.delete(normEvicted)
        clientActive.delete(normEvicted)
        filterSelector.dispose(normEvicted)
      }

      const normSessionId = normalizeSessionId(sessionId)
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
        ...(shouldRun(['confidence-shift', 'supersede-detected']) ? analyzeConfidenceTrend(filterSelector, sessionId) : []),
        ...(shouldRun(['terminal-filled', 'terminal-emptied', 'structure-changed']) ? analyzeGapAggregation(guide) : []),
        ...(shouldRun(['divergence-detected', 'structure-changed']) ? analyzeDivergence(graph) : []),
        ...(_snapshot && shouldRun(['supersede-detected', 'confidence-shift', 'chain-type-changed']) ? analyzeSnapshotTrend(_snapshot, filterSelector, sessionId) : []),
      ]

      log.info(`[insight] analyze @ ${sessionId.slice(0, 8)} round ${round}: 图 ${nodeCount} 节点 → ${allInsights.length} 洞察`)

      appendInsights(store, allInsights, round)

      // 话题生成依赖本轮洞察（每轮重建）
      const topics = generateTopics(graph, guide, allInsights)
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
      access.access(normId)
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
      access.remove(normId)
      const duration = Date.now() - startTime
      if (duration > 10 || hadStore) {
        log.info(`[诊断] insightEngine.dispose ${hadStore ? '清理' : '无存储'} ${duration}ms (session: ${normId}, insights: ${insightsCount}, topics: ${topicsCount}, clientActive: ${hadTopics})`)
      }
    },
  }
}

