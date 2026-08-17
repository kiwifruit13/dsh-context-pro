/**
 * 链感知上下文：核心契约（契约先行，实现前先定接口）。
 *
 * 5 链（因果/逻辑/操作/叙事/时间）都是多级深化的递归结构；演化由智能体
 * 打标签时动态声明驱动（模型是演化决策者，提取器忠实执行）。
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'

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
