/**
 * 图鉴协议验证：提示词段内容完整性（精简版 ~25 行，~500 tokens）。
 *
 * 设计：CoT 放权——System Prompt 只注入核心指令，完整图鉴文案迁移至技能文件按需加载。
 *
 * 📚 完整文档内容所在位置：
 *   - 五链人格图鉴（溯源者/架构师/手艺人/说书人/预言家）        → docs/Architectural-Thinking.md
 *   - 情绪底色序言、情绪水位、嗅觉催化三秒停顿                    → docs/Architectural-Thinking.md
 *   - 四大经典反应（深层归因动力学/抗脆弱执行手册/沉浸式深度诊断/变革蓝图） → docs/Integrated-Catalysis.md
 *   - 每链边界反面例、融合法则详情、浸泡式定位                      → docs/Integrated-Catalysis.md
 *   - 快照三形态示例、supersede 负向锚点、认知豁免权（记录仪非导航仪）  → docs/chain-design-final.md
 *   - 示例、操作链透明入口、步骤自动作废、情绪水位联动                → docs/chain-guide.md
 *
 * 验证目标：确认 System Prompt 注入的精简版包含核心指令，不含已下线锚点语法。
 */
import { CHAIN_PROTOCOL_SECTION } from '../src/chains/prompt.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

console.log('== 精简版核心指令（System Prompt 必需）==')
// 五链速览
check('含 5 链速览', ['因果链', '逻辑链', '操作链', '叙事链', '时间链'].every(k => CHAIN_PROTOCOL_SECTION.includes(k)))

// 融合法则核心
check('含融合法则核心', ['融合法则', '主次分明', '逻辑嫁接', '链间化学反应', '逃逸舱'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))

// 操作链触发协议
check('含操作链触发协议', CHAIN_PROTOCOL_SECTION.includes('操作链触发协议'))
check('含我理解为格式', CHAIN_PROTOCOL_SECTION.includes('我理解为'))
check('禁止问号结尾', CHAIN_PROTOCOL_SECTION.includes('禁止以问号结尾'))

// 末尾 JSON 快照指令（主提取通道）
check('含快照提取通道声明', CHAIN_PROTOCOL_SECTION.includes('提取通道'))
check('含快照 JSON 示例', CHAIN_PROTOCOL_SECTION.includes('{"chain":"因果链"'))
check('含 nodes 中文键说明', CHAIN_PROTOCOL_SECTION.includes('nodes 键用中文'))
check('含三种值形态说明', CHAIN_PROTOCOL_SECTION.includes('三种形态'))

// 认知豁免权
check('含认知豁免权', CHAIN_PROTOCOL_SECTION.includes('认知豁免权'))

// 纪律核心
check('含纪律：自然表达', CHAIN_PROTOCOL_SECTION.includes('自然表达'))
check('含纪律：自动剥离', CHAIN_PROTOCOL_SECTION.includes('自动剥离'))
check('含纪律：不为打标而打标', CHAIN_PROTOCOL_SECTION.includes('不为打标而打标'))

// 已下线内容确认无残留
check('无锚点语法残留', ['[因果@', '[逻辑@', '[操作@', '[叙事@', '[时间@', '[/链@'].every(s => !CHAIN_PROTOCOL_SECTION.includes(s)))

console.log('\n== 文档分层验证（完整内容应在技能文件，不在 System Prompt）==')
// 这些故意不在 System Prompt，验证确认不包含
check('无情绪底色序言（在 Architectural-Thinking.md）', !CHAIN_PROTOCOL_SECTION.includes('情绪即底色'))
check('无五链人格称呼（在 Architectural-Thinking.md）', !['溯源者', '架构师', '手艺人', '说书人', '预言家'].some(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('无边界反面例（在 Integrated-Catalysis.md）', !CHAIN_PROTOCOL_SECTION.includes('边界：'))
check('无四大经典反应（在 Integrated-Catalysis.md）', !['深层归因动力学', '抗脆弱执行手册', '沉浸式深度诊断', '变革蓝图'].some(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('无嗅觉催化（在 Architectural-Thinking.md）', !CHAIN_PROTOCOL_SECTION.includes('嗅觉催化'))
check('无记录仪表述（在 chain-design-final.md）', !CHAIN_PROTOCOL_SECTION.includes('记录仪'))
check('无浸泡式定位文案（在 Integrated-Catalysis.md）', !CHAIN_PROTOCOL_SECTION.includes('感知形态，而非贴分类标签'))
check('无示例（在 chain-guide.md）', !CHAIN_PROTOCOL_SECTION.includes('示例'))
check('无透明入口声明（在 chain-guide.md）', !CHAIN_PROTOCOL_SECTION.includes('透明入口'))
check('无自动作废规则（在 chain-guide.md）', !CHAIN_PROTOCOL_SECTION.includes('自动作废'))
check('无情绪水位联动（在 Architectural-Thinking.md）', !CHAIN_PROTOCOL_SECTION.includes('情绪水位'))

console.log('\n== 结构基础 ==')
check('行数合理（精简版）', CHAIN_PROTOCOL_SECTION.split('\n').length >= 20 && CHAIN_PROTOCOL_SECTION.split('\n').length <= 35)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)