/**
 * 精确提取 session 日志中的错误事件（agent/error / turn/end error / step 失败），
 * 打印完整堆栈。用法：
 *   node --import tsx/esm scripts/diag-session-errors.ts <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'

const ZSTD_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd.ts'
const DECODER_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts'

const file = process.argv[2]
if (!file) { console.error('用法: node --import tsx/esm scripts/diag-session-errors.ts <session.jsonl.zstd>'); process.exit(1) }

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

  console.log(`总行数: ${lines.length}`)
  let errorCount = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let o: { type?: string; data?: Record<string, unknown> } | null = null
    try { o = JSON.parse(line) } catch { continue }
    const t = o.type ?? ''
    const d = o.data ?? {}
    // 错误事件类型
    const isErrorEvent =
      t === 'agent/error' ||
      (t === 'turn/end' && (d as { reason?: unknown }).reason !== undefined && /error/i.test(JSON.stringify((d as { reason?: unknown }).reason))) ||
      (t === 'step/end' && (d as { error?: unknown }).error !== undefined) ||
      (t === 'assistant/chunk' && /error/i.test(JSON.stringify(d))) ||
      (t === 'llm/retry' && /error/i.test(JSON.stringify(d))) ||
      (t === 'agent/turn-stopping')
    if (!isErrorEvent) continue
    errorCount++
    console.log(`\n===== [L${i}] ${t} =====`)
    console.log(line.slice(0, 4000))
  }
  console.log(`\n总计错误事件: ${errorCount}`)
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })