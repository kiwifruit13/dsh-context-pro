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
  /** 链感知配置（5 链图鉴方案，默认关闭） */
  chains?: {
    /** 链感知开关 */
    enabled: boolean
    /** 每链节点上限（默认 20） */
    maxNodesPerChain?: number
    /** 注入打标协议提示词段（默认 false） */
    injectProtocol?: boolean
  }
}

const chainsDefault = { enabled: false, maxNodesPerChain: 20, injectProtocol: false }

export const Config: z<Config> = z.object({
  chains: z
    .object({
      enabled: z.boolean().default(false),
      maxNodesPerChain: z.number().default(20),
      injectProtocol: z.boolean().default(false),
    })
    .default(chainsDefault),
})
