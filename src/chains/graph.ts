/**
 * ChainGraph：会话内演化链图实现。
 *
 * 核心语义：链不是静态模板，是随对话演化的动态图。upsert 忠实执行模型打标
 * 声明的演化指令（深化/分叉/修正），不做推断。
 *
 *   start  [链@1]    → 新建根节点
 *   append [链@1.1]  → 深化（子节点，角色推进）
 *   fork   [链@1.2]  → 分叉（另一子节点，同角色）
 *   revise [链@1^]   → 修正（旧节点 superseded，新节点 revisionOf 指向旧）
 *   end    [/链@1]   → 链结构完成（后续该链锚点被忽略）
 */
import {
  ROLE_BY_KIND,
  type ChainAnchor,
  type ChainGraph,
  type ChainKind,
  type ChainNode,
  type ChainRole,
  type SnapshotProgress,
} from './types.ts'

/** 角色推进：同一父下的深化，角色沿表层角色顺序推进（cause→solution 等） */
function advanceRole(kind: ChainKind, parentRole: ChainRole): ChainRole {
  const roles = ROLE_BY_KIND[kind]
  const idx = roles.indexOf(parentRole)
  if (idx < 0 || idx >= roles.length - 1) return parentRole
  return roles[idx + 1]
}

/** 节点 id：kind@路径 */
function nodeId(kind: ChainKind, path: number[]): string {
  return `${kind}@${path.join('.')}`
}

export function createChainGraph(): ChainGraph {
  const nodes = new Map<string, ChainNode>()
  /** kind@root → 已收束（end）标记 */
  const ended = new Set<string>()
  let latestSummary: string | undefined
  let latestProgress: SnapshotProgress | undefined

  function upsert(anchor: ChainAnchor, content: string, sourceRef: string): ChainNode {
    const { kind, root } = anchor
    const rootKey = `${kind}@${root}`
    // end 之后该链不可再改
    if (ended.has(rootKey)) {
      // 容忍：忽略后续锚点，返回空节点占位（调用方应跳过）
      const stub: ChainNode = {
        id: nodeId(kind, anchor.path),
        kind,
        role: ROLE_BY_KIND[kind][0],
        content: '',
        children: [],
        status: 'active',
        timestamp: Date.now(),
        sourceRefs: [],
      }
      return stub
    }

    const id = nodeId(kind, anchor.path)

    if (anchor.op === 'end') {
      ended.add(rootKey)
      const existing = nodes.get(id)
      // end 只标记收束：不改已有节点状态（superseded 保持 superseded）
      if (existing) return existing
      const stub: ChainNode = {
        id, kind,
        role: ROLE_BY_KIND[kind][0],
        content: '',
        children: [],
        status: 'active',
        timestamp: Date.now(),
        sourceRefs: [],
      }
      nodes.set(id, stub)
      return stub
    }

    if (anchor.op === 'revise') {
      const old = nodes.get(id)
      if (old) old.status = 'superseded'
      const revised: ChainNode = {
        id: `${id}′`,
        kind,
        role: old?.role ?? ROLE_BY_KIND[kind][0],
        content,
        parent: old?.parent,
        children: [],
        revisionOf: old ? id : undefined,
        status: 'active',
        timestamp: Date.now(),
        sourceRefs: sourceRef ? [sourceRef] : [],
      }
      nodes.set(revised.id, revised)
      // 修正节点继承父的 children 位置：父 children 里旧 id 换成新 id
      if (old?.parent) {
        const parent = nodes.get(old.parent)
        if (parent) {
          parent.children = parent.children.map((c) => (c === id ? revised.id : c))
        }
      }
      return revised
    }

    // start / append / fork
    const parentId = anchor.path.length > 1 ? nodeId(kind, anchor.path.slice(0, -1)) : undefined
    const parent = parentId ? nodes.get(parentId) : undefined
    const role = anchor.op === 'start'
      ? ROLE_BY_KIND[kind][0]
      : parent
        ? (anchor.op === 'fork' ? parent.role : advanceRole(kind, parent.role))
        : ROLE_BY_KIND[kind][0]

    const node: ChainNode = {
      id,
      kind,
      role,
      content,
      parent: parentId,
      children: [],
      status: 'active',
      timestamp: Date.now(),
      sourceRefs: sourceRef ? [sourceRef] : [],
    }
    nodes.set(id, node)
    if (parentId && parent) {
      parent.children = [...parent.children, id]
    }
    return node
  }

  function activeRoots(kind: ChainKind): ChainNode[] {
    const roots: ChainNode[] = []
    for (const node of nodes.values()) {
      if (node.kind !== kind || node.parent || node.status !== 'active') continue
      roots.push(node)
    }
    return roots.sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  function activeNodes(): ChainNode[] {
    return [...nodes.values()]
      .filter((n) => n.status === 'active' && n.content)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  function dispose(): void {
    nodes.clear()
    ended.clear()
  }

  /**
   * 链级显式回溯（6.4）：整链作废保留为负向锚点。
   * 废链节点不删除（superseded + 原因，供 SELECT 对比论证引用），
   * 并按 end 语义收束（此后该链锚点/快照补漏均被忽略）。
   */
  function supersedeRoot(kind: ChainKind, root: number, reason: string): void {
    if (!reason.trim()) return
    const rootKey = `${kind}@${root}`
    ended.add(rootKey)
    for (const node of nodes.values()) {
      if (node.kind !== kind) continue
      if (rootKeyOf(node.id) !== rootKey) continue
      if (node.status !== 'active') continue // superseded 保持原状（不覆盖既有作废语义）
      node.status = 'superseded'
      node.supersededReason = reason
    }
  }

  /** 从父节点的 children 中脱离（删除节点前调用，保持图一致） */
  function detach(node: ChainNode): void {
    if (!node.parent) return
    const p = nodes.get(node.parent)
    if (p) p.children = p.children.filter((c) => c !== node.id)
  }

  function prune(limit: number): void {
    if (limit <= 0) return
    // 按链（kind@root）分组，逐链裁剪到 limit（对应 config.maxNodesPerChain"每链节点上限"）
    const byRoot = new Map<string, ChainNode[]>()
    for (const node of nodes.values()) {
      const key = rootKeyOf(node.id)
      const list = byRoot.get(key)
      if (list) list.push(node)
      else byRoot.set(key, [node])
    }

    for (const list of byRoot.values()) {
      let excess = list.length - limit
      if (excess <= 0) continue

      // 1) 优先剪 superseded 且无活跃子节点的（最新者优先剪）
      const superseded = list
        .filter((n) => n.status === 'superseded')
        .sort((a, b) => b.timestamp - a.timestamp)
      for (const node of superseded) {
        if (excess <= 0) break
        const hasActiveChild = node.children.some((c) => nodes.get(c)?.status === 'active')
        if (hasActiveChild) continue
        detach(node)
        nodes.delete(node.id)
        excess--
      }

      // 2) 仍超限：剪最旧的叶子（含子节点已被剪空的节点）
      if (excess > 0) {
        const leaves = list
          .filter((n) => nodes.has(n.id) && n.children.every((c) => !nodes.has(c)))
          .sort((a, b) => a.timestamp - b.timestamp)
        for (const leaf of leaves) {
          if (excess <= 0) break
          detach(leaf)
          nodes.delete(leaf.id)
          excess--
        }
      }
    }
  }

  return { nodes, endedRoots: ended, latestSummary, latestProgress, upsert, activeRoots, activeNodes, dispose, prune, supersedeRoot }
}

/** 节点 id → 链根键（`causal@1.2` → `causal@1`，修正后缀 ′ 不影响分组） */
function rootKeyOf(id: string): string {
  const at = id.indexOf('@')
  const kind = id.slice(0, at)
  const root = id.slice(at + 1).split('.')[0].replace(/′$/, '')
  return `${kind}@${root}`
}
