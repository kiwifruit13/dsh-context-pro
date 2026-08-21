/**
 * 五维认知图鉴提示词段：注入 systemPrompt，让模型以内化的方式感知链结构。
 *
 * 通过 ctx.systemPrompt.section() 注册一个有序提示片段（每次模型 step 前组装）。
 * 终局共识（设计方案与规划.md）：
 *   - CoT 放权——从"指令驱动"降级为"上下文浸泡"
 *   - 模型正文自然表达，不输出任何 [因果@1] 标签
 *   - 末尾一行 JSON 快照供系统提取（用户不可见，hook 自动剥离）
 *   - 锚点语法已下线，解析器已删除，仅保留末尾 JSON 快照为主提取通道
 *
 * 8.5 精简：~90 行 → ~25 行核心指令，五链详情移至 architectural-thinking 技能按需加载。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** 图鉴式提示词段内容（精简版 ~25 行，~500 tokens） */
export const CHAIN_PROTOCOL_SECTION = [
  '# 五维认知图鉴（dsh-context-pro 链感知）',
  '',
  '## 五链速览（详情见 `architectural-thinking` 技能）',
  '- 因果链（问题→原因→方案）| 逻辑链（前提→推理→结论）| 操作链（动作→步骤→结果）',
  '- 叙事链（开端→发展→转折→结局）| 时间链（过去→现在→未来）',
  '',
  '## 融合法则（详情见 `Integrated-Catalysis` 技能）',
  '主次分明（锁定得分最高的一条为主链），逻辑嫁接（主链中穿插其他链的节点），',
  '链间化学反应（交叉点往往是认知密度最高的地方），逃逸舱（纯寒暄时不提取结构）。',
  '',
  '## 操作链触发协议(**减少困惑度**)',
  '以操作链为主链时，列出步骤前**必须在正文第一句**声明对"动作对象"和"执行范围"的理解：',
  '"我理解为 [动作] + [目标对象/范围]……"（禁止以问号结尾）。',
  '理解被用户确认或默认推进后，步骤列表才正式生效。',
  '',
  '## 末尾快照（提取通道，用户不可见）',
  '**技巧**：可以先于用户看到前剥离快照',
  '回复正文结束后另起一行，用一行 JSON 输出当前主链终态：',
  '{"chain":"因果链","nodes":{"问题":"","原因":"","方案":""}}',
  'nodes 键用中文（因果=问题/原因/方案；逻辑=前提/推理/结论；操作=动作/步骤/结果；叙事=开端/发展/转折/结局；时间=过去/现在/未来）。',
  '值支持三种形态：字符串（括注置信度）、分叉（{"ai":..,"user":..}）、合流（value+from）。',
  '推翻旧主链时声明 supersede（root+reason），被推翻结论保留为"曾以为"。',
  '',
  '## 认知豁免权**最高优先级**（详情见 `chain-design-final` 技能）',
  '快照只记录已确认或已推断的结论，不限制推理。缺口可按推断填充，但必须标明置信度并在正文邀请纠正。',
  '',
  '## 纪律',
  '- 正文自然表达，不输出 [标签] 或 【节点名】——用户感受不到框架的存在',
  '- 末尾 JSON 快照行由系统自动剥离，在用户看到前直接剥离即可，用户不可见',
  '- 只在触及对应推理结构时输出，不为打标而打标',
  '- **重要**：好的结构让用户感到通畅，而不是看到框架',
].join('\n')

/**
 * 注册打标协议提示词段（返回 disposer，随 fiber 回卷）。
 * @param ctx - 插件上下文
 * @param order - 提示词段顺序（默认 30，位于系统指令之后、工具说明之前）
 */
export function registerChainProtocol(
  ctx: Context,
  order = 30,
): (() => void) | undefined {
  const systemPrompt = ctx.get('systemPrompt') as
    | { section: (s: PromptSection) => () => void }
    | undefined
  if (!systemPrompt) return undefined
  return systemPrompt.section({
    name: 'dsh-context-pro-chain-protocol',
    order,
    // 字段必须是 text（PromptSection 契约）——写 content 会让 text=undefined，
    // 每轮 assemble 时 interpolate() 执行 text.indexOf('{{') → 崩溃 indexOf（bug #24）
    text: CHAIN_PROTOCOL_SECTION,
  })
}