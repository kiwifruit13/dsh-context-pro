/**
 * 图鉴协议验证：提示词段内容完整性（五链图鉴 + 情绪底色 + 末尾 JSON 快照）。
 *
 * 终局共识（设计方案与规划.md）：
 *   锚点语法已下线，解析器已删除，仅保留末尾 JSON 快照为主提取通道。
 */
import { CHAIN_PROTOCOL_SECTION } from '../src/chains/prompt.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

console.log('== 协议内容完整性（新设计）==')
check('含 5 链定义', ['因果', '逻辑', '操作', '叙事', '时间'].every(k => CHAIN_PROTOCOL_SECTION.includes(k)))
check('不含锚点语法', ['[因果@n]', '[逻辑@n]', '[操作@n]', '[叙事@n]', '[时间@n]', '[链@n.m]', '[/链@n]'].every(s => !CHAIN_PROTOCOL_SECTION.includes(s)))
check('含纪律（正文自然表达）', CHAIN_PROTOCOL_SECTION.includes('自然语言') && CHAIN_PROTOCOL_SECTION.includes('不'))
check('含纪律（模型唯一打标）', CHAIN_PROTOCOL_SECTION.includes('唯一打标者'))
check('含纪律（JSON 快照自动剥离声明）', CHAIN_PROTOCOL_SECTION.includes('自动剥离') && CHAIN_PROTOCOL_SECTION.includes('不需要自行隐藏'))
check('含示例', CHAIN_PROTOCOL_SECTION.includes('示例'))

console.log('== 图鉴要素（设计方案与规划.md 终局共识）==')
check('含情绪底色序言', ['情绪即底色', '情绪水位'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('含五链人格图鉴', ['溯源者', '架构师', '手艺人', '说书人', '预言家'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('每链含边界反面例', (CHAIN_PROTOCOL_SECTION.match(/边界：/g) ?? []).length === 5)
check('含融合法则', ['融合法则', '主次分明', '逻辑嫁接', '链间化学反应', '逃逸舱'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('含四大经典反应', ['深层归因动力学', '抗脆弱执行手册', '沉浸式深度诊断', '变革蓝图'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('含嗅觉催化三秒停顿', ['嗅觉催化', '腐蚀味', '阻力味', '空洞味', '走单链'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('含认知豁免权（记录仪非导航仪）', CHAIN_PROTOCOL_SECTION.includes('认知豁免权') && CHAIN_PROTOCOL_SECTION.includes('记录仪'))
check('浸泡式定位（不贴分类标签）', CHAIN_PROTOCOL_SECTION.includes('感知形态，而非贴分类标签'))
check('废链保留（曾以为）', CHAIN_PROTOCOL_SECTION.includes('曾以为'))
check('末尾 JSON 快照指令（主提取通道）', ['末尾快照', '{"chain":"null"}', '提取通道'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('快照三形态指令（6.4 数据模型）', ['nodes 值支持三种形态', '"ai":"人力不足","user":"需求混乱"', '"from":["ai","user"]'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('supersede 显式回溯指令（6.4 负向锚点）', ['"supersede"', '曾以为', '不得作为当前推理前提'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('结构完整（序言/图鉴/法则/快照/豁免/示例/纪律）',
  ['序言', '五链图鉴', '融合法则', '末尾快照', '认知豁免权', '示例', '纪律'].every(s => CHAIN_PROTOCOL_SECTION.includes(s)))
check('无空行溢出', CHAIN_PROTOCOL_SECTION.split('\n').length > 10)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)