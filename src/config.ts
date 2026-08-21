/**
 * DSH-Context-Pro 配置契约。
 * 契约先行：schema 先于实现；无效配置 → ValidationError，插件拒绝启动。
 *
 * 终局设计（设计方案与规划.md）：CoT 放权——系统只做两件事：
 *   1. 在 System Prompt 中注入五链图鉴（prompt.ts）
 *   2. 在模型回复末尾解析 JSON 快照（hook.ts）
 * prestep 零干预。
 */
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** 链感知配置（5 链图鉴方案） */
  chains: {
    /** 链感知开关 */
    enabled: boolean
    /** 每链节点上限（默认 20） */
    maxNodesPerChain?: number
    /** 注入打标协议提示词段（默认 false） */
    injectProtocol?: boolean
    /** 洞察引擎配置（超然层，依赖 chains.enabled，P0 可配置化） */
    insight?: {
      /** 洞察开关（默认 true；chains.enabled=false 时强制 false） */
      enabled: boolean
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
  }
}

const chainsDefault = {
  enabled: false,
  maxNodesPerChain: 20,
  injectProtocol: false,
  insight: {
    enabled: true,
    similarityThreshold: 0.15,
    maxStaleRounds: 3,
    maxInsights: 20,
    maxTopics: 10,
    historyWindow: 40,
    maxSessions: 100,
    selectiveAnalysis: false,
    auth: {
      enabled: false,
      keys: [],
      keyHashes: [],
      headerName: 'x-api-key',
      queryParam: 'api_key',
      skipPaths: ['/api/context-pro/openapi.json', '/health'],
      devAutoKey: true,
    },
    rateLimit: {
      maxRequests: 100,
      windowMs: 60_000,
    },
  },
}

export const Config: z<Config> = z.object({
  chains: z
    .object({
      enabled: z.boolean().default(false),
      maxNodesPerChain: z.number().min(1).default(20),
      injectProtocol: z.boolean().default(false),
      insight: z
        .object({
          enabled: z.boolean().default(true),
          similarityThreshold: z.number().min(0).max(1).default(0.15),
          maxStaleRounds: z.number().step(1).min(1).default(3),
          maxInsights: z.number().step(1).min(1).default(20),
          maxTopics: z.number().step(1).min(1).default(10),
          historyWindow: z.number().step(1).min(1).default(40),
          maxSessions: z.number().step(1).min(1).default(100),
          selectiveAnalysis: z.boolean().default(false),
          /** API Key 鉴权配置（P2 可选） */
          auth: z.object({
            enabled: z.boolean().default(false),
            keys: z.array(z.string()).default([]),
            keyHashes: z.array(z.string()).default([]),
            headerName: z.string().default('x-api-key'),
            queryParam: z.string().default('api_key'),
            skipPaths: z.array(z.string()).default(['/api/context-pro/openapi.json', '/health']),
            devAutoKey: z.boolean().default(true),
          }).default({ enabled: false, keys: [], keyHashes: [], headerName: 'x-api-key', queryParam: 'api_key', skipPaths: ['/api/context-pro/openapi.json', '/health'], devAutoKey: true }),
          /** 限流配置（P2 可选） */
          rateLimit: z.object({
            maxRequests: z.number().step(1).min(1).default(100),
            windowMs: z.number().step(1).min(1).default(60_000),
          }).default({ maxRequests: 100, windowMs: 60_000 }),
        })
        .default(chainsDefault.insight),
    })
    .default(chainsDefault),
})
