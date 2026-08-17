/**
 * dump 指定崩溃索引（事件#）前方最近 N 条 user/message、assistant/message、request/header 的完整 JSON。
 * 用法：node --import tsx/esm scripts/diag-msgs.ts <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'

const ZSTD_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd.ts'
const DECODER_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts'

const file = process.argv[2]
if (!file) { console.error('用法: node --import tsx/esm scripts/diag-msgs.ts <session.jsonl.zstd>'); process.exit(1) }

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

  const events: Array<{ i: number; line: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try { JSON.parse(line); events.push({ i, line }) } catch { /* skip */ }
  }

  // 崩溃点：turn/end error
  const crashes: number[] = []
  for (let k = 0; k < events.length; k++) {
    const o = JSON.parse(events[k].line) as { type?: string; data?: { reason?: { kind?: string; error?: { message?: string } } } }
    if (o.type === 'turn/end' && o.data?.reason?.kind === 'error') crashes.push(k)
  }

  for (const crashIdx of crashes) {
    const crash = JSON.parse(events[crashIdx].line) as { data?: { reason?: { error?: { message?: string } } } }
    console.log(`\n########## 崩溃 #${crashIdx}: ${crash.data?.reason?.error?.message} ##########`)
    // 向前找最近 30 条，dump 消息类事件
    const start = Math.max(0, crashIdx - 30)
    for (let k = start; k <= crashIdx; k++) {
      const e = events[k]
      const o = JSON.parse(e.line) as { type?: string }
      if (['user/message', 'assistant/message', 'request/header', 'turn/end'].includes(o.type ?? '')) {
        console.log(`\n--- #${k} ${o.type} ---`)
        console.log(e.line.slice(0, 5000))
      }
    }
  }
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })