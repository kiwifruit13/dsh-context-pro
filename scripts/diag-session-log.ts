/**
 * 解码 dsh session 日志（zstd 多帧），提取 agent 错误/失败事件。
 * 用法：node --import tsx/esm scripts/diag-session-log.ts <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'

const ZSTD_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd.ts'
const DECODER_MOD = 'file:///D:/Git/github/deepseek-harness-master/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts'

const file = process.argv[2]
if (!file) {
  console.error('用法: node --import tsx/esm scripts/diag-session-log.ts <session.jsonl.zstd>')
  process.exit(1)
}

async function main(): Promise<void> {
  const { scanZstdFrames } = await import(ZSTD_MOD)
  const { PublicZstdFrameDecoder } = await import(DECODER_MOD)
  const raw = readFileSync(file)
  console.log('文件大小:', raw.length, 'bytes')

  let frames
  try {
    frames = scanZstdFrames(raw)
  } catch (err) {
    console.error('帧扫描失败:', (err as Error).message)
    process.exit(1)
  }
  console.log('完整帧数:', frames.frames.length, frames.tornStart !== undefined ? `+ torn@${frames.tornStart}` : '')

  const decoder = new PublicZstdFrameDecoder()
  const chunks: Buffer[] = []
  try {
    for (const buf of decoder.decode(raw, frames.frames)) chunks.push(Buffer.from(buf))
  } catch (err) {
    console.error('解码失败:', (err as Error).message)
  } finally {
    decoder.close()
  }

  const cat = Buffer.concat(chunks)
  console.log('解码成功, 总大小:', cat.length, 'bytes')
  const lines = cat.toString('utf8').split('\n')
  console.log('总行数:', lines.length)

  const KW = /error|fail|exception|throw|indexOf|undefined|429|quota|steering/i
  let shown = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (KW.test(line)) {
      let s = line
      // 尝试打印结构化字段
      try {
        const o = JSON.parse(line)
        if (o.type) s = `[${o.type}] ${s}`
      } catch { /* 非 JSON 行 */ }
      console.log(`[L${i}] ${s.slice(0, 3000)}`)
      shown++
      if (shown >= 80) { console.log('... (截断)'); break }
    }
  }
  if (shown === 0) {
    console.log('未匹配错误关键字，打印最后 40 行:')
    for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) {
      if (lines[i].trim()) console.log(`[L${i}] ${lines[i].slice(0, 1500)}`)
    }
  }
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1) })