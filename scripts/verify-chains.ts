/**
 * 链感知方案验证：5 链多级演化 + 生命周期。
 *
 * 提取通道：仅末尾 JSON 快照（锚点语法已下线，不再解析 [因果@1] 标签）。
 */
import { createChainGraph } from '../src/chains/graph.ts'
import { createChainIndex } from '../src/chains/index.ts'
import { parseSnapshot, stripSnapshotLine } from '../src/chains/snapshot.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

/** 辅助：用快照注入消息 */
function snapIngest(index: ReturnType<typeof createChainIndex>, sessionId: string, msgId: string, text: string, snapshotLine: string) {
  return index.ingest(sessionId, {
    id: msgId, role: 'user' as const,
    content: [{ type: 'text' as const, text: snapshotLine ? `${text}\n${snapshotLine}` : text }],
    source: { kind: 'plugin' as const, plugin: 'dsh-context-pro' },
  } as never)
}

console.log('== 1. ChainIndex：生命周期（快照通道）==')
const index = createChainIndex()
const ingested = index.ingest('sess-A', {
  id: 'm1', role: 'user' as const,
  content: [{ type: 'text' as const, text: '正文。\n{"chain":"因果链","nodes":{"问题":"注入没生效","原因":"scope 包装","方案":"展平"}}' }],
  source: { kind: 'plugin' as const, plugin: 'dsh-context-pro' },
} as never)
check('ingest 返回锚点数', ingested.length === 3, `n=${ingested.length}`)
check('graph 有节点', index.graph('sess-A')?.nodes.size === 3, `size=${index.graph('sess-A')?.nodes.size}`)

index.dispose('sess-A')
check('dispose 清空该会话', index.graph('sess-A') === undefined)
check('dispose 不影响其他会话', index.graph('sess-B') === undefined)

console.log('== 2. P0 回归：bug 修复 ==')
// #19 修正节点 sourceRefs 不重复（supersede 场景）
const idx19 = createChainIndex()
snapIngest(idx19, 'sess-19', 'm19a', '最初判断。', '{"chain":"因果链","nodes":{"问题":"项目延期","原因":"人力不足"}}')
snapIngest(idx19, 'sess-19', 'm19b', '新证据。', '{"chain":"因果链","supersede":{"reason":"新证据：人力充足"},"nodes":{"问题":"项目延期","原因":"需求混乱"}}')
const g19 = idx19.graph('sess-19')!
// supersede 后新链以 causal@2 为根（旧链 causal@1 被废）
check('#19 修正节点 sourceRefs 不重复',
  g19.nodes.get('causal@2.1')?.sourceRefs.length === 1,
  `refs=${JSON.stringify(g19.nodes.get('causal@2.1')?.sourceRefs)}`)

// #20b prune 每链上限（一条链裁剪，另一条不受影响）
const g2 = createChainGraph()
for (let i = 1; i <= 8; i++) {
  g2.upsert({ kind: 'causal', op: 'append', root: 1, path: [1, i], isRevise: false, index: 0, raw: '' }, `节点内容${i}`, 'msg-2')
}
g2.upsert({ kind: 'operation', op: 'start', root: 2, path: [2], isRevise: false, index: 0, raw: '' }, '唯一节点', 'msg-2')
g2.prune(5)
const causalCount = [...g2.nodes.values()].filter((n) => n.id.startsWith('causal@')).length
const opCount = [...g2.nodes.values()].filter((n) => n.id.startsWith('operation@')).length
check('#20b prune 每链裁剪到上限', causalCount === 5, `causal=${causalCount}`)
check('#20b 其他链不受影响', opCount === 1, `op=${opCount}`)

console.log('== 3. P2 末尾 JSON 快照通道 ==')
// 解析：标准快照行
const snap1 = parseSnapshot('正文。\n{"chain":"因果链","nodes":{"问题":"注入没生效","原因":"scope 包装","方案":"展平"}}')
check('解析标准快照', snap1?.chain === 'causal' && Object.keys(snap1?.nodes ?? {}).length === 3,
  `chain=${snap1?.chain}`)
// 解析：未识别 → null
check('未识别主链 → null', parseSnapshot('正文。\n{"chain":"null"}') === null)
// 解析：格式错（尾随逗号）-> 8.6 容错层修复后成功解析
const snapFix = parseSnapshot('正文。\n{"chain":"因果链",}')
check('非法 JSON（尾随逗号）-> 容错修复解析', snapFix?.chain === 'causal' && Object.keys(snapFix?.nodes ?? {}).length === 0,
  `chain=${snapFix?.chain}, nodes=${JSON.stringify(snapFix?.nodes)}`)
// 解析：链名非法 → undefined
check('非法链名 → 丢弃', parseSnapshot('{"chain":"玄学链","nodes":{}}') === undefined)
// 解析：英文 kind 变体
check('英文 kind 变体可解析', parseSnapshot('{"chain":"causal","nodes":{}}')?.chain === 'causal')
// 解析：正文中间的 JSON 不属于本通道（只认末行）
check('非末行 JSON 不解析', parseSnapshot('中间 {"chain":"因果链"}\n正文最后一行') === undefined)
// 解析：nodes 非法键/非法值丢弃
const snap2 = parseSnapshot('{"chain":"逻辑链","nodes":{"前提":"P","非法键":"X","结论":123}}')
check('nodes 非法条目丢弃', snap2?.chain === 'logic' && Object.keys(snap2?.nodes ?? {}).length === 1
  && snap2?.nodes?.premise?.value === 'P', JSON.stringify(snap2?.nodes))
// 剥离：末尾快照行剥掉、正文保留
const stripped2 = stripSnapshotLine('正文第一行\n正文第二行\n{"chain":"null"}')
check('stripSnapshotLine 剥离快照行', stripped2 === '正文第一行\n正文第二行', stripped2)

// 快照独立建图
const idx3 = createChainIndex()
snapIngest(idx3, 'sess-P2', 'p2a', '先这样。', '{"chain":"叙事链","nodes":{"开端":"A","发展":"B","转折":"C","结局":"D"}}')
const g3 = idx3.graph('sess-P2')!
check('快照独立建图：4 节点', g3.nodes.size === 4, `size=${g3.nodes.size}`)
check('快照建图角色归位', g3.nodes.get('narrative@1')?.role === 'beginning'
  && g3.nodes.get('narrative@1.2')?.role === 'twist'
  && g3.nodes.get('narrative@1.3')?.role === 'ending',
  `${g3.nodes.get('narrative@1')?.role}/${g3.nodes.get('narrative@1.2')?.role}/${g3.nodes.get('narrative@1.3')?.role}`)

// 快照增量：补漏不覆盖
snapIngest(idx3, 'sess-P2', 'p2b', '正文。', '{"chain":"因果链","nodes":{"问题":"注入没生效","原因":"scope 包装","方案":"展平处理"}}')
check('快照建图所有节点存在', g3.nodes.get('causal@1')?.role === 'problem'
  && g3.nodes.get('causal@1.1')?.role === 'cause'
  && g3.nodes.get('causal@1.2')?.role === 'solution',
  `${g3.nodes.get('causal@1')?.role}/${g3.nodes.get('causal@1.1')?.role}/${g3.nodes.get('causal@1.2')?.role}`)

// ended 链快照丢弃
const idx3e = createChainIndex()
g3.upsert({ kind: 'operation', op: 'end', root: 1, path: [1], isRevise: false, index: 0, raw: '' }, '', 'p2e')
snapIngest(idx3e, 'sess-P2e', 'p2e', '正文', '{"chain":"操作链","nodes":{"结果":"快照版结果"}}')
check('ended 链快照不重复建图', !idx3e.graph('sess-P2e')?.nodes.has('operation@1.1'))

console.log('== 4. P3 数据模型：confidence / diverged-converged / supersede ==')
// confidence：快照字符串值括注 + 对象显式（0-100 归一化）
const snapC1 = parseSnapshot('{"chain":"因果链","nodes":{"原因":"需求失控（置信度78%）"}}')
check('confidence 快照括注提取', snapC1?.nodes?.cause?.confidence === 0.78)
const snapC2 = parseSnapshot('{"chain":"因果链","nodes":{"方案":{"value":"裁剪","confidence":78}}}')
check('confidence 对象声明 0-100 归一化', snapC2?.nodes?.solution?.confidence === 0.78)

// diverged/converged：路径分歧并行记录 + 合流继承
const idx4 = createChainIndex()
snapIngest(idx4, 'sess-P3', 'p3a', '正文。', '{"chain":"因果链","nodes":{"问题":"项目延期","原因":{"ai":"人力不足","user":"需求混乱"},"方案":{"value":"优先级裁剪","from":["ai","user"],"confidence":0.8}}}')
const g4 = idx4.graph('sess-P3')!
check('diverged 双路径并行建图', g4.nodes.get('causal@1.1')?.divergence === 'ai'
  && g4.nodes.get('causal@1.2')?.divergence === 'user',
  `${g4.nodes.get('causal@1.1')?.divergence}/${g4.nodes.get('causal@1.2')?.divergence}`)
check('diverged 双路径同角色', g4.nodes.get('causal@1.1')?.role === 'cause'
  && g4.nodes.get('causal@1.2')?.role === 'cause')
check('converged 合流继承标记', g4.nodes.get('causal@1.3')?.convergedFrom?.join(',') === 'ai,user'
  && g4.nodes.get('causal@1.3')?.confidence === 0.8,
  JSON.stringify(g4.nodes.get('causal@1.3')?.convergedFrom))

// supersede：显式回溯通道（废链保留为负向锚点）
const idx4b = createChainIndex()
snapIngest(idx4b, 'sess-P3b', 'p3b1', '正文。', '{"chain":"因果链","nodes":{"问题":"项目延期","原因":"人力不足"}}')
snapIngest(idx4b, 'sess-P3b', 'p3b2', '新证据。', '{"chain":"因果链","supersede":{"reason":"新证据：人力充足，需求混乱"},"nodes":{"问题":"项目延期","原因":"需求失控（置信度78%）"}}')
const g4b = idx4b.graph('sess-P3b')!
check('supersede 废链保留+废因', g4b.nodes.get('causal@1')?.status === 'superseded'
  && g4b.nodes.get('causal@1')?.supersededReason === '新证据：人力充足，需求混乱',
  `${g4b.nodes.get('causal@1')?.status}/${g4b.nodes.get('causal@1')?.supersededReason}`)
check('supersede 后新链建图', g4b.nodes.get('causal@2')?.status === 'active'
  && g4b.nodes.get('causal@2.1')?.confidence === 0.78)
// 废链不可再追加
snapIngest(idx4b, 'sess-P3b', 'p3b3', '追加内容', '{"chain":"因果链","nodes":{"原因":"追加内容"}}')
check('废链收束不可再追加', !g4b.nodes.has('causal@1.2'))
// supersede 容错：缺 reason 整个声明丢弃
const noReason = parseSnapshot('{"chain":"因果链","supersede":{"root":1},"nodes":{"问题":"X"}}')
check('supersede 缺 reason 丢弃', noReason?.supersede === undefined)

// 补漏时 confidence 元数据刷新（修复置信度趋势预警路径不可达的设计缺口）
// 第一轮：cause 节点入库，confidence=0.78
const idx4c = createChainIndex()
snapIngest(idx4c, 'sess-P3c', 'p3c1', '正文。', '{"chain":"因果链","nodes":{"问题":"项目延期","原因":"需求失控（置信度78%）"}}')
const g4c = idx4c.graph('sess-P3c')!
check('首轮 confidence 入库', g4c.nodes.get('causal@1.1')?.confidence === 0.78,
  `actual=${g4c.nodes.get('causal@1.1')?.confidence}`)
// 第二轮：补漏快照提供不同 confidence（0.45）+ 不同 value
// 预期：confidence 被刷新为 0.45，value/核心内容不被覆盖
snapIngest(idx4c, 'sess-P3c', 'p3c2', '新进展。', '{"chain":"因果链","nodes":{"原因":{"value":"完全不同的内容","confidence":45}}}')
const g4c2 = idx4c.graph('sess-P3c')!
check('补漏刷新 confidence 元数据', g4c2.nodes.get('causal@1.1')?.confidence === 0.45,
  `actual=${g4c2.nodes.get('causal@1.1')?.confidence}`)
check('补漏不覆盖核心内容', g4c2.nodes.get('causal@1.1')?.content === '需求失控（置信度78%）',
  `actual=${g4c2.nodes.get('causal@1.1')?.content}`)
// 第二轮不新增节点（补漏无新角色，toAdd.length===0）
check('补漏无新增节点', g4c2.nodes.size === 2,  // causal@1 (root) + causal@1.1
  `actual size=${g4c2.nodes.size}, ids=[${[...g4c2.nodes.keys()].join(',')}]`)

console.log('== 5. P4 脉络导览元数据层 ==')
// 导览：GPS 单行（进度/置信度/缺口）
const idx5 = createChainIndex()
snapIngest(idx5, 'sess-P4', 'p4a', '正文。', '{"chain":"因果链","nodes":{"问题":"项目延期","原因":"需求失控（置信度78%）"}}')
const guide5 = idx5.guide('sess-P4')!
check('guide 返回主链', guide5.primary?.kind === 'causal' && guide5.primary.root === 1)
check('headline GPS 格式', guide5.headline === '[当前链:causal链 | 进度:问题✓→原因✓→解决方案✗ | 置信度:78%]',
  guide5.headline)
check('gaps 脉络缺口探测', guide5.primary?.gaps.join(',') === 'solution',
  guide5.primary?.gaps.join(','))
check('track 轨道图', guide5.track === '问题（共识） → 原因（共识） → 解决方案（缺）', guide5.track)
// 导览：diverged/converged 轨道投射
snapIngest(idx5, 'sess-P4', 'p4b', '正文。', '{"chain":"因果链","nodes":{"方案":{"value":"优先级裁剪","from":["ai","user"]}}}')
const guide5b = idx5.guide('sess-P4')!
check('converged 轨道合流', guide5b.track.includes('方案（合流）'), guide5b.track)
check('合流后缺口清零', guide5b.primary?.gaps.length === 0)
// 导览：ended 链快照不报缺口
const idx5c = createChainIndex()
snapIngest(idx5c, 'sess-P4c', 'p4c', '正文。', '{"chain":"操作链","nodes":{"动作":"步骤一","步骤":"步骤二","结果":"完毕"}}')
const guide5c = idx5c.guide('sess-P4c')!
check('ended 链快照不缺缺口', guide5c.primary?.gaps.length === 0)
// 导览：空会话
check('空会话 guide undefined', idx5.guide('no-such') === undefined)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)