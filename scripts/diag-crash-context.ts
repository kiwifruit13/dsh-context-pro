/**
 * 找 turn/end error（indexOf 崩溃）并 dump 前方最后 N 条事件，还原崩溃现场。
 * 用法：node --import tsx/esm scripts/diag-crash-context.ts <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'

const ZSTD_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd.ts'
const DECODER_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts'

const file = process.argv[2]
if (!file) { console.error('用法: node --import tsx/esm scripts/diag-crash-context.ts <session.jsonl.zstd>'); process.exit(1) }

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

  // 收集所有解析成功的行
  const events: Array<{ i: number; line: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try { JSON.parse(line); events.push({ i, line }) } catch { /* skip */ }
  }
  console.log(`有效事件数: ${events.length}`)

  // 找所有 turn/end error
  const crashes: number[] = []
  for (let k = 0; k < events.length; k++) {
    const o = JSON.parse(events[k].line) as { type?: string; data?: { reason?: { kind?: string; error?: { message?: string } } } }
    if (o.type === 'turn/end' && o.data?.reason?.kind === 'error') {
      crashes.push(k)
    }
  }
  console.log(`turn/end error 数: ${crashes.length}`)
  if (crashes.length === 0) return

  for (const crashIdx of crashes) {
    const crash = events[crashIdx]
    const o = JSON.parse(crash.line) as { data?: { reason?: { error?: { message?: string } } } }
    console.log(`\n########## 崩溃 @ 事件#${crashIdx} (L${crash.i}) ##########`)
    console.log('错误:', o.data?.reason?.error?.message)
    console.log('---- 前方最后 25 条事件 ----')
    const start = Math.max(0, crashIdx - 25)
    for (let k = start; k <= crashIdx; k++) {
      const e = events[k]
      const p = JSON.parse(e.line) as { type?: string; data?: { turn?: number; step?: number; name?: string; callId?: string; message?: { content?: Array<{ text?: string; isError?: boolean }>; role?: string } } }
      const line = e.line
      let summary = line
      try {
        if (p.type === 'tool/result') {
          const content = p.data?.message?.content ?? []
          const text = content.map((b) => (b.text ?? '')).join('').slice(0, 300)
          summary = `[tool/result ${p.data?.name ?? ''}] ${text}`
        } else if (p.type === 'tool/call') {
          summary = `[tool/call ${p.data?.name ?? ''}] ${String(p.data?.callId ?? '')}`
        } else if (p.type === 'assistant/message' || p.type === 'user/message') {
          const content = p.data?.message?.content ?? []
          const text = content.map((b) => (typeof b === 'object' && b !== null ? (b.text ?? '') : '')).join('').slice(0, 200)
          summary = `[${p.type} ${p.data?.role ?? ''}] ${text}`
        } else {
          summary = `[${p.type} t${p.data?.turn ?? ''} s${p.data?.step ?? ''}]`
        }
      } catch { /* keep raw */ }
      console.log(`  #${k} ${summary}`)
    }
  }
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })