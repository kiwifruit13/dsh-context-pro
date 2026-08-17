/**
 * DSH-Context-Pro 插件入口。
 *
 * 定位：DSH Agent 的「上下文整形器」——在每一轮推理前（agent/pre-step）把上下文
 * 塑造成高信噪比、高相关、可回溯的注入块。
 *
 * 能力：SELECT/INJECT/MEASURE 三阶段 + 链感知上下文（5 链标签方案，chains.enabled）。
 */
import { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigSchema } from './config.ts'
import { registerPreStepHook } from './prestep.ts'
import { registerChainHook } from './chains/hook.ts'
import { registerChainProtocol } from './chains/prompt.ts'
import { registerProjectSkills } from './skills.ts'

export const name = 'context-pro'
/** The agent registry that owns pre-step processing（服务名 camelCase，非 cordis.yml 条目 id） */
export const inject = ['agents']

export function apply(ctx: Context, config: ConfigSchema = {}): void {
  const logger = ctx.logger('context-pro')
  const chains = config.chains
  const chainsEnabled = chains?.enabled ?? false
  const injectProtocol = chains?.injectProtocol ?? false

  logger.info(
    `启动: chains=${chainsEnabled}, protocol=${injectProtocol}`,
  )

  // 打标协议提示词段（chains.injectProtocol 时注入；disposer 挂 effect 随 fiber 回卷）
  if (chainsEnabled && injectProtocol) {
    const dispose = registerChainProtocol(ctx)
    if (dispose) {
      ctx.effect(() => dispose)
      logger.info('打标协议提示词段已注入')
    } else {
      logger.warn('systemPrompt 服务不可用，打标协议未注入')
    }
  }

  // 注册项目技能（AGENTS.md + CLAUDE.md + Architectural-Thinking.md + Integrated-Catalysis.md，可选依赖，静默跳过）
  registerProjectSkills(ctx).then((ok) => {
    if (ok) logger.info('项目技能已注册（agent-principles + api-contract-guide + architectural-thinking + integrated-catalysis）')
  })

  // 链感知钩子（会话内临时链索引；enabled 时监听 session/event；每链节点上限透传）
  const chainIndex = registerChainHook(ctx, chainsEnabled, chains?.maxNodesPerChain)

  // 注册 pre-step 拦截器（链协议模式零干预，仅防御性兜底；副作用随 fiber 自动回卷）
  registerPreStepHook(ctx)
}
