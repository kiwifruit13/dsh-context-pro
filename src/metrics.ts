/**
 * 可观测性指标收集（阶段 9）。
 *
 * 三组指标：
 *   9.1 快照提取成功率：总尝试次数、成功次数、失败原因分布
 *   9.2 链图健康度：每轮活跃链数、节点数、superseded 数、ended 数
 *   9.3 洞察引擎命中率：get_insights 调用次数、非空返回次数、话题便条触发次数
 */

// ---------------------------------------------------------------------------
// 9.1 快照提取成功率
// ---------------------------------------------------------------------------

export interface SnapshotStats {
  totalAttempts: number
  successCount: number
  /** 失败原因 -> 次数 */
  failureReasons: Record<string, number>
  /** 最近 N 条失败详情（用于调试） */
  recentFailures: { text: string; reason: string; timestamp: number }[]
}

const MAX_RECENT_FAILURES = 20

const snapshotStats: SnapshotStats = {
  totalAttempts: 0,
  successCount: 0,
  failureReasons: {},
  recentFailures: [],
}

/** 记录快照解析结果 */
export function recordSnapshotAttempt(success: boolean, reason?: string, text?: string): void {
  snapshotStats.totalAttempts++
  if (success) {
    snapshotStats.successCount++
  } else {
    const r = reason ?? 'unknown'
    snapshotStats.failureReasons[r] = (snapshotStats.failureReasons[r] ?? 0) + 1
    if (text) {
      snapshotStats.recentFailures.push({ text: text.slice(0, 200), reason: r, timestamp: Date.now() })
      if (snapshotStats.recentFailures.length > MAX_RECENT_FAILURES) {
        snapshotStats.recentFailures.shift()
      }
    }
  }
}

/** 获取当前快照提取统计 */
export function getSnapshotStats(): SnapshotStats {
  return { ...snapshotStats, failureReasons: { ...snapshotStats.failureReasons }, recentFailures: [...snapshotStats.recentFailures] }
}

// ---------------------------------------------------------------------------
// 9.2 链图健康度
// ---------------------------------------------------------------------------

export interface ChainHealthEntry {
  timestamp: number
  activeChains: number
  totalNodes: number
  supersededNodes: number
  endedChains: number
}

const chainHealthHistory: ChainHealthEntry[] = []
const MAX_CHAIN_HEALTH = 200

/** 记录一轮链图健康度 */
export function recordChainHealth(health: Omit<ChainHealthEntry, 'timestamp'>): void {
  chainHealthHistory.push({ ...health, timestamp: Date.now() })
  if (chainHealthHistory.length > MAX_CHAIN_HEALTH) {
    chainHealthHistory.shift()
  }
}

/** 获取链图健康度历史（最近 N 条） */
export function getChainHealthHistory(limit = 50): ChainHealthEntry[] {
  return chainHealthHistory.slice(-limit)
}

/** 获取链图健康度聚合摘要 */
export function getChainHealthSummary(): { avgNodes: number; avgActiveChains: number; totalEntries: number } {
  if (chainHealthHistory.length === 0) return { avgNodes: 0, avgActiveChains: 0, totalEntries: 0 }
  const sum = chainHealthHistory.reduce((acc, e) => ({
    nodes: acc.nodes + e.totalNodes,
    chains: acc.chains + e.activeChains,
  }), { nodes: 0, chains: 0 })
  return {
    avgNodes: Math.round(sum.nodes / chainHealthHistory.length),
    avgActiveChains: Math.round(sum.chains / chainHealthHistory.length * 10) / 10,
    totalEntries: chainHealthHistory.length,
  }
}

// ---------------------------------------------------------------------------
// 9.3 洞察引擎命中率
// ---------------------------------------------------------------------------

export interface InsightStats {
  toolCallCount: number
  nonEmptyReturnCount: number
  topicNoteTriggeredCount: number
  /** 最近一轮的话题便条触发时间戳 */
  lastTopicNoteTimestamp: number
}

const insightStats: InsightStats = {
  toolCallCount: 0,
  nonEmptyReturnCount: 0,
  topicNoteTriggeredCount: 0,
  lastTopicNoteTimestamp: 0,
}

/** 记录 get_insights 工具调用 */
export function recordInsightToolCall(returnedNonEmpty: boolean): void {
  insightStats.toolCallCount++
  if (returnedNonEmpty) insightStats.nonEmptyReturnCount++
}

/** 记录话题便条触发 */
export function recordTopicNoteTriggered(): void {
  insightStats.topicNoteTriggeredCount++
  insightStats.lastTopicNoteTimestamp = Date.now()
}

/** 获取洞察引擎统计 */
export function getInsightStats(): InsightStats {
  return { ...insightStats }
}

// ---------------------------------------------------------------------------
// 全量聚合端点
// ---------------------------------------------------------------------------

export interface AllMetrics {
  snapshot: SnapshotStats
  chainHealth: ReturnType<typeof getChainHealthSummary>
  insight: InsightStats
  timestamp: number
}

/** 获取全量指标 */
export function getAllMetrics(): AllMetrics {
  return {
    snapshot: getSnapshotStats(),
    chainHealth: getChainHealthSummary(),
    insight: getInsightStats(),
    timestamp: Date.now(),
  }
}