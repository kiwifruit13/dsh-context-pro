/**
 * 解码指定 session.jsonl.zstd，统计消息事件、查找链快照痕迹与插件追加的便条。
 * 用法：node --import tsx/esm scripts/diag-session-inspect.ts <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'

const ZSTD_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd.ts'
const DECODER_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts'

const file = process.argv[2]
if (!file) { console.error('用法: node --import tsx/esm scripts/diag-session-inspect.ts <session.jsonl.zstd>'); process.exit(1) }

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

  let userMsgs = 0, assistantMsgs = 0, snapshots = 0, sticky = 0
  const events: Array<{ i: number; type: string; line: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let o: { type?: string; data?: unknown }
    try { o = JSON.parse(line) } catch { continue }
    if (!o.type) continue
    events.push({ i, type: o.type, line })
    if (o.type === 'user/message') userMsgs++
    if (o.type === 'assistant/message') {
      assistantMsgs++
      const d = o.data as { message?: { content?: unknown[] } }
      const text = (d.message?.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('')
      if (text.includes('"chain"')) snapshots++
      if (text.includes('你可能想问')) sticky++
    }
  }

  console.log(`== 会话: ${file}`)
  console.log(`事件总数: ${events.length}, user/message: ${userMsgs}, assistant/message: ${assistantMsgs}`)
  console.log(`含链快照("chain")的 assistant 消息: ${snapshots}, 含推荐话题便条的: ${sticky}`)

  // 列出全部事件类型分布
  const dist = new Map<string, number>()
  for (const e of events) dist.set(e.type, (dist.get(e.type) ?? 0) + 1)
  console.log('\n事件类型分布:')
  for (const [t, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`)
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })