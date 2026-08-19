/**
 * 技能注册：把 AGENTS.md（智能体工作原则）、CLAUDE.md（API/接口/胶水公约）、
 * Architectural-Thinking.md（五维认知图鉴）、融合进阶.md（链间化学反应催化酶）、
 * 洞察引擎.md（超然层洞察模块）注册为 ctx.skills 技能，
 * 模型在会话目录中可见 name+description，按需加载全文。
 *
 * 不强制执行：模型按需加载，不注入 prompt。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

const here = dirname(fileURLToPath(import.meta.url))
const docsDir = join(here, '../docs')

const SKILL_DEFS = [
  {
    fileName: 'AGENTS.md',
    name: 'agent-principles',
    description: '智能体工作原则：核心哲学、工具调用纪律、编码契约、知识边界、完成定义',
    whenToUse: '当需要回顾智能体工作原则、工具调用纪律、编码规范或验证完成标准时使用',
  },
  {
    fileName: 'CLAUDE.md',
    name: 'api-contract-guide',
    description: 'API/接口/胶水代码开发全链路公约：API设计规范、接口契约设计原则、胶水代码红线、评审检查清单',
    whenToUse: '当需要API设计规范、接口契约设计原则、胶水代码实现规范或PR评审检查清单时使用',
  },
  {
    fileName: 'Architectural-Thinking.md',
    name: 'architectural-thinking',
    description: '五维认知结构图鉴（模型内化版）：因果/逻辑/操作/叙事/时间五链认知框架+情绪底色协议+融合法则',
    whenToUse: '当需要系统性认知推理、复杂问题拆解、多维度分析或选择最优认知框架时使用',
  },
  {
    fileName: 'Integrated-Catalysis.md',
    name: 'integrated-catalysis',
    description: '链间化学反应催化酶设计：四大经典反应方程式（因果×时间/逻辑×操作/叙事×因果/时间×叙事）+嗅觉催化机制+三秒直觉反射训练+完整CoT推演示例',
    whenToUse: '当需要深度链间嫁接、多链协同推理、融合法则的进阶应用或突破单链分析瓶颈时使用',
  },
  {
    fileName: '融合进阶.md',
    name: 'chain-fusion-advanced',
    description: '链间化学反应催化酶设计：四大经典反应方程式（因果×时间/逻辑×操作/叙事×因果/时间×叙事）+嗅觉催化机制+快照策略',
    whenToUse: '当需要深度链间嫁接、多链协同推理、复杂认知交叉分析或突破单链分析瓶颈时使用',
  },
  {
    fileName: '洞察引擎.md',
    name: 'insight-engine',
    description: '洞察引擎（超然层）：五大分析器（链间化学反应检测/链迁移预测/置信度趋势预警/缺口聚合/分歧收敛）+推荐话题生成+get_insights工具接口+生命周期与会话绑定',
    whenToUse: '当需要理解洞察引擎的工作原理、分析器检测逻辑、get_insights工具的返回格式或洞察模块的配置方式时使用',
  },
  {
    fileName: 'data-flow.md',
    name: 'hook-tool-data-flow',
    description: 'DSH Hook 与 Tool 间六条数据通路全景图：身份锚点（payload.session_id / exec.agent.id 不变式）、stdin payload 构造、stdout JSON 解码、additionalContext 跨层传递、Decision 裁决映射、Session 事件日志、steer/inject 行为注入',
    whenToUse: '当需要理解 DSH 中 Hook 与 Tool 之间的数据传递机制、身份锚点的不变式维护、六条数据通路的实现原理或排查 Hook/Tool 数据错位问题时使用',
  },
]

/**
 * 注册项目技能（可选依赖 ctx.skills；服务缺失时静默跳过）。
 * @param ctx - 插件上下文
 * @param logger - 可选的日志器，用于记录注册失败详情
 * @returns 是否全部注册成功
 */
export async function registerProjectSkills(
  ctx: Context,
  logger?: { warn: (msg: string) => void },
): Promise<boolean> {
  const skills = ctx.get('skills') as {
    register: (r: unknown) => Promise<void> | void
  } | undefined
  if (!skills) return false

  const log = logger ?? { warn: () => {} }
  let allOk = true
  for (const def of SKILL_DEFS) {
    try {
      const content = await readFile(join(docsDir, def.fileName), 'utf-8')
      await skills.register({
        name: def.name,
        description: def.description,
        whenToUse: def.whenToUse,
        content,
        source: 'custom',
        provider: 'dsh-context-pro',
        resourceBase: { kind: 'directory', path: docsDir },
        invocation: { modelInvocable: true, userInvocable: true },
      })
    } catch (error: unknown) {
      log.warn(`技能 "${def.name}"（${def.fileName}）注册失败: ${String(error)}`)
      allOk = false
    }
  }
  return allOk
}