/**
 * 定位 turn/end error 的可疑来源：dump 指定 turn 的完整事件序列，
 * 并高亮 pre-step / 链提取 / 注入相关事件。用法：
 *   node --import tsx/esm scripts/diag-session-turn.ts <session.jsonl.zstd> <turn>
 */
import { readFileSync } from 'node:fs'

const ZSTD_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd.ts'
const DECODER_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts'

const file = process.argv[2]
const targetTurn = Number(process.argv[3] ?? 4)
if (!file) { console.error('用法: node --import tsx/esm scripts/diag-session-turn.ts <session.jsonl.zstd> <turn>'); process.exit(1) }

async function main(): Promise<void> {
  const { scanZstdFrames } = await import(ZSTD_MOD)
  const { PublicZstdFrameDecoder } = await import(DECODER_MOD)
  const raw = readFileSync(file)
  const frames = scanZstdFrames(raw)
  const decoder = new PublicZstdFrameDecoder()
  const chunks: Buffer[] = []
  try {
    for (const buf of decoder.decode(raw, frames.frames)) chunks.push(Buffer.from(buf))
  } finally { decoder.close() }
  const cat = Buffer.concat(chunks)
  const lines = cat.toString('utf8').split('\n')

  const inTurn: Array<{ i: number; line: string }> = []
  let curTurn = 0
  // 粗扫：用 turn/start 与 turn/end 分隔
  const turnStarts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let o: { type?: string; data?: { turn?: number } } | null = null
    try { o = JSON.parse(line) } catch { continue }
    const t = o.type ?? ''
    const turn = o.data?.turn
    if (turn === targetTurn) inTurn.push({ i, line })
  }

  console.log(`turn ${targetTurn} 共 ${inTurn.length} 条事件`)
  if (inTurn.length === 0) return

  // 打印事件类型分布
  const byType = new Map<string, number>()
  for (const { line } of inTurn) {
    let o: { type?: string } | null = null
    try { o = JSON.parse(line) } catch { continue }
    byType.set(o.type ?? '?', (byType.get(o.type ?? '?') ?? 0) + 1)
  }
  console.log('事件类型分布:', JSON.stringify([...byType.entries()]))

  // 高亮关键事件并打印每类首个
  const HIGHLIGHT = /pre-step|prestep|chain|inject|plugin|user\/message|assistant\/chunk|tool\/result|turn\/end|error|surface/i
  let shown = 0
  for (const { i, line } of inTurn) {
    if (!HIGHLIGHT.test(line)) continue
    console.log(`[L${i}] ${line.slice(0, 2200)}`)
    shown++
    if (shown >= 120) { console.log('... (截断)'); break }
  }
  if (shown === 0) console.log('无高亮事件，打印全部:')
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })