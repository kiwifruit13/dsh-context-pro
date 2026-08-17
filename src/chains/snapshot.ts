/** 置信度括注正则：（置信度78%）/ (把握度 60%) /（可信度九成不认，只认数字百分比） */
const CONFIDENCE_RE = /[（(]\s*(?:置信度|把握度|可信度)\s*(\d{1,3})\s*%\s*[）)]/

/**
 * 从文本括注提取置信度（6.4 数据模型）：
 *   "需求失控（置信度78%）" → 0.78；无合规括注 → undefined。
 * 内容本身保留括注（信息无损），confidence 是结构化副本。
 */
export function confidenceOf(text: string): number | undefined {
  const m = text.match(CONFIDENCE_RE)
  if (!m) return undefined
  const n = Number(m[1])
  if (Number.isNaN(n) || n <= 0) return undefined
  return Math.min(n / 100, 1)
}

/**
 * 末尾 JSON 快照通道：第二提取通道（与行内锚点互补）。
 *
 * 设计终局（设计方案与规划.md）：
 *   - 协议只加一行指令：正文结束后换行，用一行 JSON 输出主链快照；
 *     未识别输出 {"chain":"null"}
 *   - 解析器极轻 + 容错丢弃：格式乱即整行丢弃，不影响主回复与锚点通道
 *   - 双通道交叉：锚点记录演化（决策者），快照补终态（便签纸）——
 *     锚点已有的角色快照不覆盖，锚点缺失的角色由快照补漏
 *
 * 6.4 P3 扩展（数据模型）：
 *   - confidence：推断性结论的把握度（对象显式声明或字符串括注提取）
 *   - diverged/converged：路径分歧并行记录（{"ai":..,"user":..}）与合流继承
 *     （{"value":..,"from":["ai","user"]}）
 *   - supersede：显式回溯通道——废旧主链保留为负向锚点（废因必填），
 *     nodes 作为新链重建（逻辑可继承：合流条目 from 指向分叉路径）
 */
import {
  CHAIN_KINDS,
  ROLE_BY_KIND,
  type ChainAnchor,
  type ChainGraph,
  type ChainKind,
  type ChainRole,
  type ChainSnapshot,
  type SnapshotNodeValue,
  type SnapshotSupersede,
} from './types.ts'

/** 快照 nodes 中文键 → ChainRole（与 ROLE_BY_KIND 表层角色一一对应） */
const ROLE_BY_KEY: Record<string, ChainRole> = {
  '问题': 'problem', '原因': 'cause', '方案': 'solution',
  '前提': 'premise', '推理': 'reasoning', '结论': 'conclusion',
  '动作': 'action', '步骤': 'step', '结果': 'result',
  '开端': 'beginning', '发展': 'development', '转折': 'twist', '结局': 'ending',
  '过去': 'past', '现在': 'present', '未来': 'future',
}

/** 链名标签 → ChainKind（容错：中文/中文带"链"后缀/英文 kind，大小写不敏感） */
function kindOfLabel(label: string): ChainKind | undefined {
  const s = label.trim().toLowerCase()
  if (s === 'null') return undefined
  const table: Record<string, ChainKind> = {
    '因果': 'causal', '因果链': 'causal',
    '逻辑': 'logic', '逻辑链': 'logic',
    '操作': 'operation', '操作链': 'operation',
    '叙事': 'narrative', '叙事链': 'narrative',
    '时间': 'temporal', '时间链': 'temporal',
  }
  const bare = s.endsWith('链') ? s.slice(0, -1) : s
  const hit = table[s] ?? table[bare]
  return hit ?? ((CHAIN_KINDS as readonly string[]).includes(s) ? (s as ChainKind) : undefined)
}

/** 归一化置信度：>1 视为百分数（78 → 0.78），钳制 (0,1] */
function normalizeConfidence(n: number): number | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(n > 1 ? n / 100 : n, 1)
}

/**
 * 解析文本末尾的 JSON 快照行。
 *
 * 只认**最后一个非空行**且形如 `{...}` 的行（协议约定快照在正文最末尾，
 * 正文中间出现的 JSON 不属于本通道）。
 *
 * @returns
 *   - undefined：无快照行 / 格式错误 / 链名非法（**整行丢弃**）
 *   - null：明确声明无主链（{"chain":"null"}）
 *   - ChainSnapshot：有效快照（nodes 只含合法角色且值形态合法的条目）
 */
export function parseSnapshot(text: string): ChainSnapshot | null | undefined {
  const lines = text.split('\n')
  let last = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t) { last = t; break }
  }
  if (!last.startsWith('{') || !last.endsWith('}')) return undefined

  let obj: unknown
  try {
    obj = JSON.parse(last)
  } catch {
    return undefined // 格式乱 → 丢弃
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined

  const chainRaw = (obj as { chain?: unknown }).chain
  if (typeof chainRaw !== 'string') return undefined
  if (chainRaw.trim().toLowerCase() === 'null') return null

  const chain = kindOfLabel(chainRaw)
  if (!chain) return undefined

  const legalRoles = new Set<string>(ROLE_BY_KIND[chain])
  const nodesRaw = (obj as { nodes?: unknown }).nodes
  const nodes: Partial<Record<ChainRole, SnapshotNodeValue>> = {}
  if (typeof nodesRaw === 'object' && nodesRaw !== null && !Array.isArray(nodesRaw)) {
    for (const [key, value] of Object.entries(nodesRaw as Record<string, unknown>)) {
      const role = ROLE_BY_KEY[key]
      // 容错：键不在角色表 / 键不属于该链角色 / 值形态非法 → 丢弃该条目
      if (!role || !legalRoles.has(role)) continue
      const nv = toNodeValue(value)
      if (nv) nodes[role] = nv
    }
  }

  // 显式回溯声明：reason 必填（缺 reason 整个 supersede 丢弃，防误作废）
  const supRaw = (obj as { supersede?: unknown }).supersede
  let supersede: SnapshotSupersede | undefined
  if (typeof supRaw === 'object' && supRaw !== null && !Array.isArray(supRaw)) {
    const so = supRaw as Record<string, unknown>
    const reason = typeof so.reason === 'string' ? so.reason.trim() : ''
    if (reason) {
      supersede = {
        reason,
        root: typeof so.root === 'number' && Number.isInteger(so.root) && so.root > 0
          ? so.root
          : undefined,
      }
    }
  }

  return { chain, nodes, supersede, raw: last }
}

/** 快照条目值 → SnapshotNodeValue（容错校验：字符串或 {value|ai|user} 对象） */
function toNodeValue(v: unknown): SnapshotNodeValue | undefined {
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return undefined
    // 字符串内括注置信度（"需求失控（置信度78%）"）也提取为结构化副本
    const confidence = confidenceOf(t)
    return confidence !== undefined ? { value: t, confidence } : { value: t }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined

  const o = v as Record<string, unknown>
  const out: SnapshotNodeValue = {}
  if (typeof o.value === 'string' && o.value.trim()) out.value = o.value.trim()
  if (typeof o.ai === 'string' && o.ai.trim()) out.ai = o.ai.trim()
  if (typeof o.user === 'string' && o.user.trim()) out.user = o.user.trim()
  if (Array.isArray(o.from)) {
    const froms = o.from.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    if (froms.length > 0) out.from = froms
  }
  if (typeof o.confidence === 'number') {
    const c = normalizeConfidence(o.confidence)
    if (c !== undefined) out.confidence = c
  }
  // 至少要有一个内容字段（value/ai/user），纯 from/confidence 的空壳丢弃
  if (out.value === undefined && out.ai === undefined && out.user === undefined) return undefined
  return out
}

/** 剥离末尾快照行（INJECT 前清理 / 锚点通道提取前清理，JSON 不回灌不混入节点内容） */
export function stripSnapshotLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t) continue // 跳过尾部空行
    if (t.startsWith('{') && t.endsWith('}')) lines.splice(i)
    break // 只处理最后一个非空行
  }
  return lines.join('\n').trimEnd()
}

/** 该 kind 下一个可用链号（扫描已有节点 id 的最大 root + 1） */
function nextRootOf(graph: ChainGraph, kind: ChainKind): number {
  let max = 0
  for (const id of graph.nodes.keys()) {
    if (!id.startsWith(`${kind}@`)) continue
    const root = Number(id.slice(kind.length + 1).split('.')[0].replace(/′$/, ''))
    if (!Number.isNaN(root) && root > max) max = root
  }
  return max + 1
}

/** 某根链下已有子节点的最大末段号（决定补漏节点的 path；含修正后缀 ′ 不影响取号） */
function nextSeqOf(graph: ChainGraph, kind: ChainKind, root: number): number {
  const prefix = `${kind}@${root}.`
  let max = 0
  for (const id of graph.nodes.keys()) {
    if (!id.startsWith(prefix)) continue
    const seg = Number(id.slice(prefix.length).split('.')[0].replace(/′$/, ''))
    if (!Number.isNaN(seg) && seg > max) max = seg
  }
  return max + 1
}

/** 快照条目（按链角色顺序入库） */
type SnapEntry = [ChainRole, SnapshotNodeValue]

/**
 * 双通道融合：把有效快照合并进链图（锚点为主、快照补漏）。
 *
 *   - supersede 声明 → 先执行链级回溯（废旧根链保留为负向锚点），nodes 走新链建图
 *   - 该 kind 无活跃根链（模型只写了快照没打锚点 / 刚 supersede）→ 整链建图
 *   - 已有活跃根链 → 只补缺失角色的节点；锚点已提取的角色**不覆盖**
 *     （锚点是演化决策者，快照是终态便签纸；分歧走 diverged 并行而非覆盖）
 *   - diverged 条目（ai/user）→ fork 节点对并行记录；converged（value+from）
 *     → 单节点 + convergedFrom 继承标记；confidence 附着到节点
 *   - 目标根链已 end/superseded（收束）→ 补漏丢弃（忠实"此后该链不再变化"）
 *
 * @returns 快照成功入库的模拟锚点（供日志计数；stub 不计）
 */
export function mergeSnapshotIntoGraph(
  graph: ChainGraph,
  snapshot: ChainSnapshot,
  sourceRef: string,
): ChainAnchor[] {
  const merged: ChainAnchor[] = []

  // 1) 显式回溯：废链保留为负向锚点（先作废，后续 nodes 自然走新链建图）
  if (snapshot.supersede) {
    const activeRoots = graph.activeRoots(snapshot.chain)
    const target = snapshot.supersede.root
      ?? (activeRoots.length > 0 ? Number(activeRoots[activeRoots.length - 1].id.split('@')[1]) : undefined)
    if (target !== undefined) {
      graph.supersedeRoot(snapshot.chain, target, snapshot.supersede.reason)
    }
  }

  const entries = Object.entries(snapshot.nodes) as SnapEntry[]
  if (entries.length === 0) return merged

  // 快照条目按链角色顺序保序入库（稳定可预测）
  const order = ROLE_BY_KIND[snapshot.chain]
  entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))

  // supersede 后重取活跃根（已作废的不算补漏目标）
  const roots = graph.activeRoots(snapshot.chain)
  let root: number
  let seq: number
  let toAdd: SnapEntry[]
  let buildNewChain: boolean

  if (roots.length === 0) {
    // 整链建图：首条目挂 start，其余挂 append/fork
    root = nextRootOf(graph, snapshot.chain)
    seq = 1
    toAdd = entries
    buildNewChain = true
  } else {
    // 补漏到最新根：锚点已有该角色（内容非空）→ 跳过（快照不覆盖锚点）
    root = Number(roots[roots.length - 1].id.split('@')[1])
    seq = nextSeqOf(graph, snapshot.chain, root)
    const rootKey = `${snapshot.chain}@${root}`
    const existing = new Set(
      graph.activeNodes()
        .filter((n) => n.kind === snapshot.chain && n.content)
        .filter((n) => n.id.split('.')[0].replace(/′$/, '') === rootKey)
        .map((n) => n.role),
    )
    toAdd = entries.filter(([role]) => !existing.has(role))
    if (toAdd.length === 0) return merged
    buildNewChain = false
  }

  let isFirst = true
  for (const [role, value] of toAdd) {
    const content = value.value ?? ''
    const confidence = value.confidence

    // diverged：ai/user 双路径并行记录（fork 节点对，互不覆盖）
    if (value.ai !== undefined || value.user !== undefined) {
      if (value.ai !== undefined) {
        upsertSnapshotNode(graph, merged, snapshot.chain, root,
          buildNewChain && isFirst ? 'start' : 'fork',
          buildNewChain && isFirst ? [root] : [root, seq++],
          role, value.ai, sourceRef,
          { divergence: 'ai', confidence })
      }
      if (value.user !== undefined) {
        upsertSnapshotNode(graph, merged, snapshot.chain, root, 'fork',
          [root, seq++], role, value.user, sourceRef,
          { divergence: 'user', confidence })
      }
      isFirst = false
      continue
    }

    // 普通 / converged：单节点（convergedFrom 继承标记 + confidence）
    upsertSnapshotNode(graph, merged, snapshot.chain, root,
      buildNewChain && isFirst ? 'start' : 'append',
      buildNewChain && isFirst ? [root] : [root, seq++],
      role, content, sourceRef,
      { convergedFrom: value.from, confidence })
    isFirst = false
  }

  return merged
}

/** 快照节点入库辅助：upsert + 显式归位 + 6.4 元数据附着（divergence/convergedFrom/confidence） */
function upsertSnapshotNode(
  graph: ChainGraph,
  merged: ChainAnchor[],
  kind: ChainKind,
  root: number,
  op: ChainAnchor['op'],
  path: number[],
  role: ChainRole,
  content: string,
  sourceRef: string,
  meta: { divergence?: 'ai' | 'user'; convergedFrom?: string[]; confidence?: number },
): void {
  const anchor: ChainAnchor = {
    kind,
    op,
    root,
    path,
    isRevise: false,
    index: -1,
    raw: '',
  }
  const node = graph.upsert(anchor, content, sourceRef)
  // upsert 按演化语义推角色；快照通道显式归位（同 extractToGraph 做法）
  node.role = role
  if (meta.divergence) node.divergence = meta.divergence
  if (meta.convergedFrom) node.convergedFrom = meta.convergedFrom
  if (meta.confidence !== undefined) node.confidence = meta.confidence
  // ended/superseded 链的 stub 不入图：不计入融合结果
  if (graph.nodes.has(node.id)) merged.push(anchor)
}
