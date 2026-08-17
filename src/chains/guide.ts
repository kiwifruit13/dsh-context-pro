/**
 * 脉络导览元数据层（6.5 P4，接 O.3 可观测）。
 *
 * 设计（设计方案与规划.md 三层嵌套记录法 · 第一层）：
 *   链图 → 元数据层投射（GPS 坐标），用户扫一眼 0.3 秒知道 AI 处于什么思考阶段；
 *   链猜错可第一时间发现并纠正。
 *
 *   headline：`[当前链:因果链|进度:问题✓→原因✓→方案✗|置信度:78%]`
 *   track：`问题（共识）→ 原因（分岔:AI/你）→ 方案（缺）`
 *          （轨道图：diverged 并行、converged 合流、缺口可见——"求同存异"视觉呈现）
 *
 * 消费方：prestep MEASURE 日志（O.3 可观测首版落点），未来可接仪表/注入导览行。
 */
import {
  CHAIN_KINDS,
  ROLE_BY_KIND,
  type ChainGraph,
  type ChainGuide,
  type ChainGuideChain,
  type ChainGuideRole,
  type ChainKind,
  type ChainRole,
} from './types.ts'

/** 链角色中文标签（导览投射用） */
const ROLE_LABEL: Record<string, string> = {
  problem: '问题', cause: '原因', solution: '解决方案',
  premise: '前提', reasoning: '推理', conclusion: '结论',
  action: '动作', step: '步骤', result: '结果',
  beginning: '开端', development: '发展', twist: '转折', ending: '结局',
  past: '过去', present: '现在', future: '未来',
}

/** 根链 key（kind@root，含修正后缀剥离） */
function rootKeyOf(id: string): string {
  return id.split('.')[0].replace(/′$/, '')
}

/** 单条根链 → 导览（按链角色顺序扫描填充状态） */
function buildChainGuide(
  graph: ChainGraph,
  kind: ChainKind,
  root: number,
): ChainGuideChain {
  const rootKey = `${kind}@${root}`
  const nodes = [...graph.nodes.values()]
    .filter((n) => n.kind === kind && rootKeyOf(n.id) === rootKey)

  const ended = graph.endedRoots.has(rootKey)
  const superseded = nodes.length > 0 && nodes.every((n) => n.status === 'superseded')

  const order = ROLE_BY_KIND[kind]
  const roles: ChainGuideRole[] = []
  const gaps: ChainRole[] = []

  for (const role of order) {
    const label = ROLE_LABEL[role] ?? role
    const hit = nodes.filter((n) => n.role === role && n.content)
    if (hit.length === 0) {
      roles.push({ role, label, state: 'empty' })
      if (!ended && !superseded) gaps.push(role) // 废链/收束链不报缺口（无闭环义务）
      continue
    }

    const divergedAi = hit.find((n) => n.divergence === 'ai')
    const divergedUser = hit.find((n) => n.divergence === 'user')
    if (divergedAi || divergedUser) {
      roles.push({
        role, label, state: 'diverged',
        ai: divergedAi?.content, user: divergedUser?.content,
      })
      continue
    }

    const converged = hit.find((n) => n.convergedFrom && n.convergedFrom.length > 0)
    if (converged) {
      roles.push({ role, label, state: 'converged', nodeId: converged.id })
      continue
    }

    roles.push({ role, label, state: 'filled', nodeId: hit[0].id })
  }

  // 链上置信度：有 confidence 的节点取平均（无则 undefined）
  const confidences = nodes.map((n) => n.confidence).filter((c): c is number => c !== undefined)
  const confidence = confidences.length > 0
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : undefined

  return { kind, root, roles, gaps, confidence, ended, superseded }
}

/** 链图 → 脉络导览（全部根链 + 当前主链 + 单行投射） */
export function buildGuide(graph: ChainGraph): ChainGuide {
  // 扫描全部根链（按 kind 声明序 + root 升序，输出稳定）
  const rootKeys = new Set<string>()
  for (const id of graph.nodes.keys()) rootKeys.add(rootKeyOf(id))

  const chains: ChainGuideChain[] = []
  for (const kind of CHAIN_KINDS) {
    const roots = [...rootKeys]
      .filter((k) => k.startsWith(`${kind}@`))
      .map((k) => Number(k.slice(kind.length + 1)))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b)
    for (const root of roots) chains.push(buildChainGuide(graph, kind, root))
  }

  // 当前主链：最新活跃根（按扫描序取最后一个非废非收束链）
  const primary = [...chains].reverse().find((c) => !c.ended && !c.superseded)

  return {
    chains,
    primary,
    headline: formatHeadline(primary),
    track: formatTrack(primary),
  }
}

/** GPS 单行：`[当前链:因果链|进度:问题✓→原因✓→方案✗|置信度:78%]` */
export function formatHeadline(chain: ChainGuideChain | undefined): string {
  if (!chain) return '[当前链:无]'
  const kindLabel = `${chain.kind}链`
  const progress = chain.roles
    .map((r) => `${r.label}${r.state === 'empty' ? '✗' : '✓'}`)
    .join('→')
  const parts = [`当前链:${kindLabel}`, `进度:${progress}`]
  if (chain.confidence !== undefined) parts.push(`置信度:${Math.round(chain.confidence * 100)}%`)
  if (chain.ended) parts.push('已收束')
  if (chain.superseded) parts.push('曾以为')
  return `[${parts.join(' | ')}]`
}

/** 轨道图单行：`问题（共识）→ 原因（分岔:AI/你）→ 方案（缺）` */
export function formatTrack(chain: ChainGuideChain | undefined): string {
  if (!chain) return ''
  return chain.roles
    .map((r) => {
      switch (r.state) {
        case 'empty': return `${r.label}（缺）`
        case 'diverged': return `${r.label}（分岔:AI/你）`
        case 'converged': return `${r.label}（合流）`
        default: return `${r.label}（共识）`
      }
    })
    .join(' → ')
}
