/**
 * 链感知上下文：核心契约（契约先行，实现前先定接口）。
 *
 * 5 链（因果/逻辑/操作/叙事/时间）都是多级深化的递归结构；演化由智能体
 * 打标签时动态声明驱动（模型是演化决策者，提取器忠实执行）。
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { TopicsResult } from './insight.ts'

/** 洞察引擎可配参数（P0 可配置化） */
export interface InsightConfig {
  /** 相似度阈值：Jaccard >= 此值视为重复（默认 0.15） */
  similarityThreshold?: number
  /** 连续未确认轮次上限：超过则过期淘汰（默认 3） */
  maxStaleRounds?: number
  /** 洞察项总数上限：超限按 evidence+severity 淘汰（默认 20） */
  maxInsights?: number
  /** 话题总数上限（默认 10） */
  maxTopics?: number
  /** 历史累积窗口（最近 N 轮 = 2N 条消息，默认 40） */
  historyWindow?: number
  /** 会话总数上限：超限淘汰最旧不活跃会话（默认 100） */
  maxSessions?: number
  /** 是否启用选择性分析器（P1，默认 false 兼容旧行为） */
  selectiveAnalysis?: boolean
  /** API Key 鉴权配置（P2 可选） */
  auth?: {
    enabled?: boolean
    keys?: string[]
    keyHashes?: string[]
    headerName?: string
    queryParam?: string
    skipPaths?: string[]
    devAutoKey?: boolean
  }
  /** 限流配置（P2 可选） */
  rateLimit?: {
    maxRequests?: number
    windowMs?: number
  }
}

/** 链图变更类型（P1 选择性分析器触发依据） */
export type ChainChangeType =
  | 'chain-added'           // 新增链
  | 'chain-removed'         // 移除链
  | 'chain-type-changed'    // 链类型变更（如 causal→logic）
  | 'confidence-shift'      // 置信度显著变化（≥0.3）
  | 'supersede-detected'    // 出现 supersede 回溯
  | 'terminal-filled'       // 终结角色被填充（solution/conclusion 等）
  | 'terminal-emptied'      // 终结角色被清空
  | 'divergence-detected'   // 同链出现多路径分歧
  | 'structure-changed'     // 父子关系/拓扑结构变化

/** 变更上下文（传给 analyze()，决定跑哪些分析器） */
export interface ChangeContext {
  /** 本轮检测到的变更类型集合 */
  changes: Set<ChainChangeType>
  /** 上一轮快照（用于对比） */
  prevSnapshot?: ChainSnapshot | null
  /** 当前快照 */
  currSnapshot?: ChainSnapshot | null
  /** 是否首轮（无历史可比） */
  isFirstRound: boolean
}

/** 分析器触发规则：声明关心的变更类型 */
export interface AnalyzerTrigger {
  analyzerName: string
  triggers: ChainChangeType[]
  /** 是否为必跑（如首轮、全量刷新） */
  alwaysRun?: boolean
}

// ---------------------------------------------------------------------------
// 链类型与角色
// ---------------------------------------------------------------------------

export type ChainKind = 'causal' | 'logic' | 'operation' | 'narrative' | 'temporal'

export const CHAIN_KINDS: readonly ChainKind[] = [
  'causal', 'logic', 'operation', 'narrative', 'temporal',
]

export type ChainRole =
  // causal
  | 'problem' | 'cause' | 'solution'
  // logic
  | 'premise' | 'reasoning' | 'conclusion'
  // operation
  | 'action' | 'step' | 'result'
  // narrative
  | 'beginning' | 'development' | 'twist' | 'ending'
  // temporal
  | 'past' | 'present' | 'future'

/** 链类型 → 表层角色（第一层默认形态；任何角色下都可深化） */
export const ROLE_BY_KIND: Record<ChainKind, readonly ChainRole[]> = {
  causal: ['problem', 'cause', 'solution'],
  logic: ['premise', 'reasoning', 'conclusion'],
  operation: ['action', 'step', 'result'],
  narrative: ['beginning', 'development', 'twist', 'ending'],
  temporal: ['past', 'present', 'future'],
}

// ---------------------------------------------------------------------------
// 锚点
// ---------------------------------------------------------------------------

/** 锚点类型 */
export type AnchorKind = 'start' | 'append' | 'fork' | 'revise' | 'end'

/** 解析后的锚点 */
export interface ChainAnchor {
  kind: ChainKind
  /** 锚点类型（基础/追加/分叉/修正/结束） */
  op: AnchorKind
  /** 链号（@1） */
  root: number
  /** 路径段（@1.2 → [1, 2]；基础锚为 [1]） */
  path: number[]
  /** 修正锚标记（@1^） */
  isRevise: boolean
  /** 锚点在原文中的位置 */
  index: number
  /** 原始文本（如 `[因果@1.1]`） */
  raw: string
}

// ---------------------------------------------------------------------------
// 链节点与链图
// ---------------------------------------------------------------------------

/** 链节点：图的最小单元 */
export interface ChainNode {
  /** 节点 id：`kind@1.2`（如 causal@1.2），路径即层级 */
  id: string
  kind: ChainKind
  role: ChainRole
  content: string
  /** 父节点 id（多级深化） */
  parent?: string
  /** 子节点 id（分叉） */
  children: string[]
  /** 修正的旧节点 id（演化） */
  revisionOf?: string
  /** 演化状态 */
  status: 'active' | 'superseded'
  /** 跨链引用（如 causal 节点指向 operation@2） */
  links?: string[]
  /** 置信度 0-1（推断性结论的把握度；锚点通道括注/快照通道声明） */
  confidence?: number
  /** 双路径分叉时该节点的路径归属（AI 路径 / 用户路径；diverged 并行记录） */
  divergence?: 'ai' | 'user'
  /** 合流节点继承的分叉路径（'ai'/'user' 或分叉节点 id；converged） */
  convergedFrom?: string[]
  /** 作废原因（revise/supersede 时声明；废链负向锚点的"尸检报告"，供对比论证） */
  supersededReason?: string
  timestamp: number
  sourceRefs: string[]
}

/** 链图：会话内演化结构 */
export interface ChainGraph {
  nodes: Map<string, ChainNode>
  /** 已收束根链 key（kind@root；end/supersede 均入列；导览层判断"不再变化"用） */
  endedRoots: Set<string>

  /** 追加/深化/分叉/修正——统一入口（模型驱动，忠实执行） */
  upsert(anchor: ChainAnchor, content: string, sourceRef: string): ChainNode
  /** 取某链类型的活跃根节点（回溯用） */
  activeRoots(kind: ChainKind): ChainNode[]
  /** 全部活跃节点（含子节点，按路径排序） */
  activeNodes(): ChainNode[]
  /** 生命周期：会话结束/删除 → 清空 */
  dispose(): void
  /** 节点上限裁剪（防演化失控；按链 kind@root 逐链生效） */
  prune(limit: number): void
  /**
   * 链级显式回溯：整链作废保留为负向锚点（superseded + 原因）。
   * 废链不删除（供对比论证引用），同时按 end 语义收束（此后不可再追加）。
   */
  supersedeRoot(kind: ChainKind, root: number, reason: string): void
}

// ---------------------------------------------------------------------------
// 末尾 JSON 快照（第二提取通道）
// ---------------------------------------------------------------------------

/**
 * 快照节点值：字符串（普通结论）或结构化对象（diverged/converged 路径形态）。
 *
 *   "原因": "需求失控（置信度78%）"                                  → 普通节点（含置信度）
 *   "原因": {"ai":"人力不足","user":"需求混乱"}                     → diverged 双路径并行
 *   "方案": {"value":"优先级裁剪","from":["ai","user"]}             → converged 合流继承
 */
export interface SnapshotNodeValue {
  /** 合流/推断结论正文（单值形态时与字符串等价） */
  value?: string
  /** AI 路径推论（diverged） */
  ai?: string
  /** 用户路径推论（diverged） */
  user?: string
  /** 合流继承的分叉路径（'ai'/'user'；converged） */
  from?: string[]
  /** 置信度 0-1（0-100 自动归一化） */
  confidence?: number
}

/** 显式回溯声明：作废旧根链（废链负向锚点） */
export interface SnapshotSupersede {
  /** 目标根链号（缺省 = 该 kind 最新活跃根） */
  root?: number
  /** 作废原因（必填：新证据/用户否定的一句话摘要） */
  reason: string
}

/**
 * 末尾 JSON 快照：模型在回复末尾用一行 JSON 输出的主链终态。
 *
 * 协议（设计方案与规划.md 终局共识）：
 *   {"chain":"因果链","nodes":{"问题":"","原因":"","方案":""}}
 *   未识别主链时输出 {"chain":"null"}。
 *
 * 解析容错：格式错/链名非法 → 整行丢弃（不影响主回复与行内锚点通道）。
 * 双通道融合：行内锚点是演化决策者（为主），快照只做终态补漏（不覆盖锚点内容）。
 */
export interface ChainSnapshot {
  chain: ChainKind
  /** 只保留：键能映射到该链合法角色、且值形态合法的条目 */
  nodes: Partial<Record<ChainRole, SnapshotNodeValue>>
  /** 显式回溯（6.4：废链保留为负向锚点） */
  supersede?: SnapshotSupersede
  /** 原始 JSON 行（溯源） */
  raw: string
}

// ---------------------------------------------------------------------------
// 脉络导览元数据层（6.5 P4，接 O.3 可观测）
// ---------------------------------------------------------------------------

/** 链角色在导览中的填充状态 */
export type GuideRoleState = 'filled' | 'empty' | 'diverged' | 'converged'

/** 导览中的单个角色格位 */
export interface ChainGuideRole {
  role: ChainRole
  /** 中文标签（问题/原因/方案…） */
  label: string
  state: GuideRoleState
  /** filled/converged 时的节点 id（回溯用） */
  nodeId?: string
  /** diverged 双路径内容（ai/user） */
  ai?: string
  user?: string
}

/** 导览中的单条链（根链粒度） */
export interface ChainGuideChain {
  kind: ChainKind
  root: number
  roles: ChainGuideRole[]
  /** 缺失角色（脉络缺口，推动闭环） */
  gaps: ChainRole[]
  /** 链上节点平均置信度（无置信度节点不计） */
  confidence?: number
  /** 收束（end） */
  ended: boolean
  /** 作废（负向锚点） */
  superseded: boolean
}

/**
 * 脉络导览：链图的元数据层投射（GPS 坐标）。
 *
 * 设计（设计方案与规划.md 三层记录法第一层）：
 *   headline：`[当前链:因果链|进度:问题✓→原因✓→方案✗|置信度:78%]`（0.3 秒扫读）
 *   track：`问题（共识）→ 原因（分岔:AI/你）→ 方案（缺）`（轨道图，含分叉/合流）
 */
export interface ChainGuide {
  /** 全部根链导览（含废链/收束链，按 kind+root 排序） */
  chains: ChainGuideChain[]
  /** 当前主链（最新活跃根；无活跃链时 undefined） */
  primary?: ChainGuideChain
  /** GPS 单行 */
  headline: string
  /** 轨道图单行 */
  track: string
}

// ---------------------------------------------------------------------------
// 临时存储
// ---------------------------------------------------------------------------

/** 会话内临时链索引（生命周期跟会话，删对话即删） */
export interface ChainIndex {
  graphs: Map<string, ChainGraph>

  /** 解析一条消息中的锚点 → 提取 → 入库 */
  ingest(sessionId: string, message: UserMessage): ChainAnchor[]
  graph(sessionId: string): ChainGraph | undefined
  /** 脉络导览（6.5 P4）：链图 → 元数据层投射（GPS/轨道图/缺口），供 O.3 可观测消费 */
  guide(sessionId: string): ChainGuide | undefined
  /** 生命周期：会话结束/删除 → 清空该会话链图 */
  dispose(sessionId: string): void
}

// ---------------------------------------------------------------------------
// 洞察模块（超然层：只观察、只建议、不干预 CoT）
// ---------------------------------------------------------------------------

/** 洞察项类型 */
export type InsightType =
  | 'cross-reaction'    // 链间化学反应检测
  | 'migration'         // 链迁移预测
  | 'confidence-trend'  // 置信度趋势预警
  | 'gap-aggregation'   // 脉络缺口聚合
  | 'divergence-watch'  // 分歧收敛预测

/** 严重程度 */
export type Severity = 'info' | 'warn' | 'critical'

/** 洞察关联引用（结构化，替代原先隐式 string[] 格式） */
export interface InsightReference {
  /** 去重用 scope key，分析器自行保证唯一性 */
  scopeKey: string
  /** 关联链类型（可选，用于回溯图节点内容） */
  chain?: ChainKind
  /** 关联链根号（可选，用于精确定位节点） */
  root?: number
  /** 关联角色（可选，用于区分同根不同角色的分歧/趋势） */
  role?: ChainRole
  /** 底层节点 id（可选，仅 divergence 双路径场景使用） */
  nodeIds?: string[]
}

/** 单条洞察（建议性质，非约束） */
export interface InsightItem {
  type: InsightType
  severity: Severity
  /** 一句话概括 */
  title: string
  /** 详细分析 */
  detail: string
  /** 关联引用（回溯用，结构化替代隐式 string[]） */
  references?: InsightReference[]
  /** 证据计数：同一信号被反复检测到时累加，值越高越值得关注（默认 1） */
  evidence: number
  /** 内部字段：上次被确认的轮次（用于过期淘汰，分析器无需设置） */
  lastSeenRound?: number
  timestamp: number
  /**
   * 可信度归因档案（P0 新增）：让洞察从"结果评价"升级为"归因诊断"。
   *
   * 设计意图：
   *   - 洞察本身千变万化，不预设内容模板
   *   - 但评估洞察的方法论稳定：节点证据 + 边证据 + 反证 + 综合评分
   *   - 此字段承载评估过程的结构化产物，是"有规可依"的载体
   *
   * 生成时机：由 attributeInsights() 在 ChainGraph 上推理生成，按需懒附加。
   * 生命周期：随 InsightItem 流转，不单独存储。
   */
  confidenceProfile?: ConfidenceProfile
}

/** 证据角色（节点证据的语义分类） */
export type EvidenceRole = 'primary' | 'supporting' | 'contradicting'

/** 归因边类型（ChainGraph 内置关系的归一化） */
export type AttributionEdgeKind =
  | 'parent-child'        // 父子演化（ChainNode.parent/children）
  | 'revision'            // 修正（ChainNode.revisionOf）
  | 'supersede'           // 作废（supersedeRoot 产生）
  | 'diverged-from'       // 分叉（divergence='ai'/'user' 共享根）
  | 'converged-into'      // 合流（convergedFrom 非空）
  | 'cross-chain-link'    // 跨链引用（ChainNode.links）

/** 节点级证据：归因方法论第一步 */
export interface NodeEvidence {
  /** 关联的 ChainNode.id */
  nodeId: string
  /** 该节点在归因中的角色 */
  role: EvidenceRole
  /** 权重 0-1（primary > supporting > contradicting） */
  weight: number
  /** 节点置信度（如有） */
  confidence?: number
}

/** 边级证据：归因方法论第二步 */
export interface EdgeEvidence {
  /** 边类型 */
  kind: AttributionEdgeKind
  /** 起点节点 id */
  fromNodeId: string
  /** 终点节点 id */
  toNodeId: string
  /** 强度 0-1（结构化边通常为 1.0，可被反证削弱） */
  strength: number
}

/** 反证：归因方法论第三步（识别反向证据） */
export interface ContradictingEvidence {
  /** 反证类型 */
  kind: 'superseded' | 'reverse-divergence' | 'confidence-decay' | 'no-support'
  /** 反证指向的节点/边 id */
  refId: string
  /** 反证强度 0-1 */
  strength: number
  /** 人类可读说明 */
  note?: string
}

/**
 * 可信度归因档案：洞察的"证据报告"。
 *
 * 核心定位：
 *   - 让洞察从"我看到了 X"升级为"我为什么这样判断，证据是什么，可信度多少"
 *   - 洞察内容千变万化 → 此档案不约束洞察内容
 *   - 评估方法稳定可复用 → 此档案的结构（节点+边+反证+评分）是稳定的
 *
 * 由 attributeInsights() 在 ChainGraph 上推理生成。
 */
export interface ConfidenceProfile {
  /** 节点级证据（第一步：收集支撑该洞察的 ChainNode） */
  nodeEvidence: NodeEvidence[]
  /** 边级证据（第二步：收集支撑该洞察的结构化关系） */
  edgeEvidence: EdgeEvidence[]
  /** 反证（第三步：识别反向证据；可为空） */
  contradictingEvidence: ContradictingEvidence[]
  /** 综合评分（第四步：归因可信度 0-1） */
  attributionScore: number
  /** 归因路径（人类可读） */
  rationale: string
}

/** 话题形态：延展型（往哪深挖）/ 收束型（该进入下一阶段了） */
export type TopicKind = 'extension' | 'convergence'

/** 推荐话题（用户侧，按需渲染） */
export interface RecommendationTopic {
  kind: TopicKind
  /** 用户可直接问的问题 */
  question: string
  /** 为什么建议问这个 */
  rationale: string
  relatedChain?: ChainKind
  timestamp: number
  /**
   * 话题的归因档案（P4-2 新增）。
   *
   * 设计意图：
   *   - 话题必须依据洞察产生（用户感受"AI 真的越来越懂我"）
   *   - 但洞察本身千变万化，话题的话术不应该按"洞察 type 套模板"
   *   - 此档案承载"这个话题为什么基于这条洞察"的归因证据
   *   - 让话题的 rationale 从"洞察 detail 的转述"升级为"归因档案的可读投影"
   *
   * 来源：generateTopics 在产出话题时，把对应洞察的 confidenceProfile 引用过来。
   */
  basedOn?: {
    /** 该话题依据的洞察标题（来自 store.insights.title） */
    insightTitle: string
    /** 该洞察的归因评分（0-1） */
    attributionScore: number
    /** 关键节点内容（用于让话题话术引用真实 ChainNode 内容） */
    keyNodeContents: string[]
    /** 关键边关系（用于让话题话术引用结构化关系） */
    keyEdgeKinds: AttributionEdgeKind[]
  }
}

/** 会话内洞察存储（生命周期跟会话，session/disposed 一并销毁） */
export interface InsightStore {
  /** 洞察项（保留最近 20 条，优先级淘汰） */
  insights: InsightItem[]
  /** 推荐话题（每轮重建，只保留最新一轮） */
  topics: RecommendationTopic[]
  /** 当前轮次计数（每次 analyze 递增） */
  round: number
}

/** 洞察引擎接口（超然层，只读 ChainGraph + ChainGuide，产出建议） */
export interface InsightEngine {
  /** 每轮回复后分析：更新建议池 + 话题候选池（P1 接受 ChangeContext 按需触发分析器） */
  analyze(
    sessionId: string,
    graph: ChainGraph,
    guide: ChainGuide,
    snapshot: ChainSnapshot | null | undefined,
    changeContext?: ChangeContext,
  ): void
  /** 获取当前会话的洞察项（供 get_insights tool 调取） */
  getInsights(sessionId: string, type?: InsightType): InsightItem[]
  /**
   * 归因分析：对当前会话已有洞察做可信度评估（P0 新增）。
   *
   * 行为契约：
   *   - 输入：会话 ChainGraph（从 stores 取出）+ InsightStore.insights
   *   - 输出：每条 InsightItem 附带 confidenceProfile（不修改原对象）
   *   - 纯函数语义：不修改 ChainGraph、不修改 InsightStore
   *   - 零新增存储：归因档案随返回值流转，不持久化
   *
   * 设计意图：洞察本身千变万化，但评估洞察的方法（节点证据 + 边证据 + 反证 + 综合评分）稳定可复用。
   */
  attributeInsights(sessionId: string): InsightItem[]
  /** 获取当前会话的推荐话题（供 UI / 会话结束便条渲染） */
  getTopics(sessionId: string): RecommendationTopic[]
  /** 获取最近活跃会话的推荐话题（供 Client RPC 调取） */
  getLatestTopics(): TopicsResult
  /** 精确判断会话 store 是否存在（用于 evicted 判断，避免空话题误判） */
  hasStore(sessionId: string): boolean
  /** 判断会话是否有话题（比 getTopics().length > 0 更语义化） */
  hasTopics(sessionId: string): boolean
  /** 订阅话题变更事件（P2：SSE 实时推送用） */
  on(event: 'topics-changed', handler: (payload: { sessionId: string; topics: RecommendationTopic[] }) => void): () => void
  /**
   * 标记 Client 已激活：之后 hook 不再在该会话追加便条，
   * 改由 Client UI 承担话题展示职责（更优通道）。
   * 会话级别生效——其他会话不受影响。
   */
  markClientActive(sessionId: string): void
  /** 查询 Client 是否激活（hook.ts 追加便条前检查） */
  isClientActive(sessionId: string): boolean
  /**
   * 接收 hook.ts 胶水转换后的 session 事件（过滤器/选择器入口）。
   *
   * hook.ts 在 session/event 回调里把 DSH event 转换为 SessionEventInput，
   * 调用本方法累积到 FilterSelector。分析器在 analyze 时通过 InsightNeed
   * 查询精炼后的历史（如 confidence-trend 查询 recent-snapshots 重建趋势）。
   */
  ingestEvent(sessionId: string, event: SessionEventInput): void
  /** 生命周期：会话结束/删除 → 清空洞察存储 */
  dispose(sessionId: string): void
}

// ---------------------------------------------------------------------------
// 过滤/选择层协议（洞察模块入口组件，规则由洞察需求驱动）
// ---------------------------------------------------------------------------
// 架构定位：
//   hook.ts（胶水层）→ SessionEventInput → FilterSelector.ingest
//   Analyzer → InsightNeed → FilterSelector.query → InsightHistoryItem[]
//
// 设计原则（CLAUDE.md §2.3）：
//   - 职责单一：FilterSelector 只做累积 + 查询，不感知 DSH 细节
//   - 类型明确：所有字段类型显式声明
//   - 演进兼容：InsightNeed 是 union，加新 need 类型不破坏现有调用
//   - 胶水轻薄：hook.ts 负责 DSH event → SessionEventInput 转换，不含业务规则
// ---------------------------------------------------------------------------

/**
 * hook.ts 胶水转换后的输入（FilterSelector 不感知 DSH 细节）。
 *
 * hook.ts 在 session/event 回调里把 DSH 原始 event 转换为本结构，
 * 包含洞察所需的全部信息（纯文本 + 解析后快照）。
 */
export interface SessionEventInput {
  /** 事件类型（如 'user/message' / 'assistant/message'） */
  type: string
  /** 消息内容（纯文本，已拼接 text 块） */
  text: string
  /** 消息角色 */
  role: 'user' | 'assistant'
  /** 时间戳（ms） */
  timestamp: number
  /** 解析后的快照（如该消息含 JSON 快照行则提取；hook.ts 负责 parse） */
  snapshot?: ChainSnapshot
}

/**
 * 精炼后的历史项（FilterSelector.query 输出）。
 * 分析器基于此结构进行分析，不感知 DSH session 细节。
 */
export interface InsightHistoryItem {
  /** 消息角色 */
  role: 'user' | 'assistant'
  /** 纯文本 content */
  text: string
  /** JSON 快照（如该消息含快照则保留） */
  snapshot?: ChainSnapshot
  /** 第几轮（按 assistant/message 计数） */
  round: number
  /** 时间戳（ms） */
  timestamp: number
}

/**
 * 洞察需求（分析器向 FilterSelector 查询时表达）。
 *
 * Discriminated union：按 type 字段路由不同查询语义。
 * 新增 need 类型只需加分支，不破坏现有分析器（演进兼容）。
 */
export type InsightNeed =
  /** 最近 N 个含快照的消息（confidence-trend 用，从快照重建置信度序列） */
  | { type: 'recent-snapshots'; limit: number }
  /** 引用过去的消息（含"之前/上文/第N轮"等关键词；cross-reaction 用） */
  | { type: 'reference-to-past'; keywords?: string[] }
  /** 某角色的最近 N 条消息（migration / divergence 用） */
  | { type: 'role-sequence'; role: 'user' | 'assistant'; limit: number }
  /** 含关键词的消息（gap-aggregation 用，按关键词定位缺口相关上下文） */
  | { type: 'by-keyword'; keyword: string; limit?: number }
  /** 全量（限窗口内；兜底查询） */
  | { type: 'all'; limit: number }

/**
 * 过滤/选择器接口（洞察模块入口组件）。
 *
 * 职责：
 *   - ingest：累积 hook.ts 胶水转换后的 SessionEventInput
 *   - query：按分析器表达的 InsightNeed 查询精炼后的历史
 *   - dispose：session/disposed 时清理该 session 的累积
 *
 * 不感知 DSH session 类型，可独立 mock 测试。
 * 内存级累积，窗口大小由实现决定（默认最近 20 轮）。
 */
export interface FilterSelector {
  /** hook.ts 调用：累积原始事件（已胶水转换） */
  ingest(sessionId: string, event: SessionEventInput): void
  /** 分析器调用：按需求查询精炼后的历史 */
  query(sessionId: string, need: InsightNeed): InsightHistoryItem[]
  /** 生命周期：session/disposed 时清理累积 */
  dispose(sessionId: string): void
}
