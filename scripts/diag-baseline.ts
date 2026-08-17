/**
 * 基线报告脚本：从 session 日志提取链分布 + 快照填充率 + 纠偏信号。
 * 用法：node --import tsx/esm scripts/diag-baseline.ts <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'

const ZSTD_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd.ts'
const DECODER_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts'

const file = process.argv[2]
if (!file) { console.error('用法: node --import tsx/esm scripts/diag-baseline.ts <session.jsonl.zstd>'); process.exit(1) }

const CORRECTION_INDICATORS = ['不对', '不是', '错了', '不是这个意思', '我说的是', '我意思是', '你理解错了', '搞错了', '你搞反了']

async function main(): Promise<void> {
  const { scanZstdFrames } = await import(ZSTD_MOD)
  const { PublicZstdFrameDecoder } = await import(DECODER_MOD)
  const raw = readFileSync(file)
  const frames = scanZstdFrames(raw)
  const decoder = new PublicZstdFrameDecoder()
  const chunks: Buffer[] = []
  try { for (const b of decoder.decode(raw, frames.frames)) chunks.push(Buffer.from(b)) } finally { decoder.close() }
  const cat = Buffer.concat(chunks)
  const lines = cat.toString('utf8').split('\n').filter(l => l.trim())

  // 解析事件
  const events: any[] = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

  console.log('=== 基线报告 ===')
  console.log(`会话: ${file}`)
  console.log(`事件总数: ${events.length}`)
  console.log(`时间范围: ${new Date(events[0]?.time ?? 0).toLocaleString()} ~ ${new Date(events[events.length-1]?.time ?? 0).toLocaleString()}`)
  console.log('')

  // 统计 turn 和步骤
  const turns = new Set<number>()
  let errorTurns = 0
  for (const e of events) {
    if (e.type === 'turn/start' && e.data?.turn) turns.add(e.data.turn)
    if (e.type === 'turn/end' && e.data?.reason?.kind === 'error') errorTurns++
  }
  console.log(`总轮次: ${turns.size}  (其中失败: ${errorTurns})`)

  // 提取 assistant/message 中的末尾 JSON 快照
  const assistantMsgs: any[] = events.filter(e => e.type === 'assistant/message')
  console.log(`assistant 消息数: ${assistantMsgs.length}`)

  // 解析快照
  const chainCount: Record<string, number> = {}
  let snapshotCount = 0
  let filledCount = 0
  let totalRoles = 0
  let chainRoles = 0

  for (const msg of assistantMsgs) {
    const content = msg.data?.message?.content ?? []
    const text = content.map((b: any) => b.text ?? '').join('')
    // 提取末尾 JSON 快照行
    const lines = text.trim().split('\n')
    const lastLine = lines[lines.length - 1]?.trim()
    if (!lastLine?.startsWith('{')) continue
    try {
      const snap = JSON.parse(lastLine)
      if (snap.chain && snap.chain !== 'null') {
        const chain = snap.chain
        chainCount[chain] = (chainCount[chain] ?? 0) + 1
        snapshotCount++
        // 统计 nodes 填充率
        if (snap.nodes) {
          const entries = Object.entries(snap.nodes).filter(([_, v]) => v !== '' && v !== null && v !== undefined)
          chainRoles += Object.keys(snap.nodes).length
          filledCount += entries.length
        }
      }
    } catch { /* 非 JSON 或格式错误 */ }
  }

  console.log(`含链快照的消息: ${snapshotCount}`)
  console.log('')
  console.log('--- 链分布 ---')
  const total = Object.values(chainCount).reduce((a, b) => a + b, 0)
  for (const [chain, count] of Object.entries(chainCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${chain}: ${count} 次 (${(count / total * 100).toFixed(0)}%)`)
  }
  console.log(`  (其他/未识别: ${snapshotCount - total} 次)`)

  console.log('')
  const fillRate = chainRoles > 0 ? (filledCount / chainRoles * 100).toFixed(0) : 'N/A'
  console.log(`快照平均填充率: ${fillRate}% (${filledCount}/${chainRoles} 角色位)`)

  // 用户纠正检测
  console.log('')
  console.log('--- 纠正信号 ---')
  let correctionCount = 0
  for (const e of events) {
    if (e.type !== 'user/message') continue
    const content = e.data?.content ?? []
    const text = content.map((b: any) => b.text ?? '').join('')
    const hit = CORRECTION_INDICATORS.find(ind => text.includes(ind))
    if (hit) {
      correctionCount++
      // 找前一条 assistant 消息的链
      const prevAssistant = [...events].slice(0, events.indexOf(e)).reverse().find((ev: any) => ev.type === 'assistant/message')
      let chain = '未知'
      if (prevAssistant) {
        const prevLines = (prevAssistant.data?.message?.content ?? []).map((b: any) => b.text ?? '').join('').trim().split('\n')
        const last = prevLines[prevLines.length - 1]?.trim()
        if (last?.startsWith('{')) try { chain = JSON.parse(last).chain ?? '未知' } catch {}
      }
      console.log(`  纠正 #${correctionCount}: "${hit}" (前链: ${chain}) 文本: ${text.slice(0, 60)}`)
    }
  }
  console.log(`  纠正事件总数: ${correctionCount}`)

  // 工具调用统计
  const toolCalls = events.filter(e => e.type === 'tool/call')
  console.log('')
  console.log(`工具调用: ${toolCalls.length} 次`)
  const toolNames = new Map<string, number>()
  for (const tc of toolCalls) {
    const name = tc.data?.name ?? 'unknown'
    toolNames.set(name, (toolNames.get(name) ?? 0) + 1)
  }
  for (const [name, count] of [...toolNames.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count} 次`)
  }

  console.log('')
  console.log('=== 报告结束 ===')
}

main().catch(err => { console.error('FAIL:', err); process.exit(1) })