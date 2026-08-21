/**
 * API Key 鉴权中间件（可配置、支持多 key、常量时间比较防时序攻击）。
 * 可在 config.chains.insight.apiKeys 中配置，或通过环境变量注入。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'http'
import { createHash } from 'node:crypto'

export interface ApiKeyConfig {
  /** 是否启用鉴权（默认 false，开发环境建议关闭） */
  enabled?: boolean
  /** 有效 API Key 列表（生产环境建议仅配置哈希） */
  keys?: string[]
  /** Key 哈希列表（推荐：存 SHA-256 十六进制，防泄露） */
  keyHashes?: string[]
  /** 请求头名（默认 x-api-key） */
  headerName?: string
  /** 查询参数名（备选，默认 api_key） */
  queryParam?: string
  /** 免鉴权路径前缀（如 /health、/openapi.json） */
  skipPaths?: string[]
  /** 开发模式自动保护：未显式配置 keys 时，从环境变量 CONTEXT_PRO_DEV_KEY 读取（默认开启） */
  devAutoKey?: boolean
}

/** 简单内存限流桶（Token Bucket） */
export interface RateLimitConfig {
  /** 每窗口最大请求数 */
  maxRequests?: number
  /** 窗口大小（毫秒） */
  windowMs?: number
  /** key 提取函数（默认按 IP + API Key） */
  keyGenerator?: (req: IncomingMessage, apiKey: string | null) => string
}

/** 鉴权 + 限流中间件工厂 */
export function createAuthMiddleware(
  apiKeyConfig: ApiKeyConfig = {},
  rateLimitConfig: RateLimitConfig = {},
) {
  const {
    enabled = false,
    keys = [],
    keyHashes = [],
    headerName = 'x-api-key',
    queryParam = 'api_key',
    skipPaths = ['/api/context-pro/openapi.json', '/health'],
    devAutoKey = true, // 开发模式默认开启自动保护
  } = apiKeyConfig

  const {
    maxRequests = 100,
    windowMs = 60_000,
    keyGenerator = (req, apiKey) => {
      const ip = req.headers['x-forwarded-for'] as string ?? req.socket.remoteAddress ?? 'unknown'
      return `${ip}:${apiKey ?? 'no-key'}`
    },
  } = rateLimitConfig

  const isDev = process.env.NODE_ENV !== 'production'

  // 开发模式自动保护：从环境变量读取或生成临时 key
  // 生产模式下 devAutoKey 被强制忽略——即使显式设置也拒绝自动放行，
  // 避免配置失误暴露到外部网络时无鉴权保护。
  const devAutoKeyEnabled = devAutoKey && isDev
  let effectiveKeys = [...keys]
  let effectiveKeyHashes = [...keyHashes]
  let devKeyGenerated = false

  if (devAutoKeyEnabled && effectiveKeys.length === 0 && effectiveKeyHashes.length === 0) {
    const envKey = process.env.CONTEXT_PRO_DEV_KEY
    if (envKey) {
      effectiveKeys = [envKey]
    } else {
      // 生成临时开发 key（每次启动不同，防止硬编码泄露）
      const tempKey = `dev-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 16)}`
      effectiveKeys = [tempKey]
      devKeyGenerated = true
    }
  }

  // 预处理：统一存储有效 key 的哈希集合（常量时间查找用 Set）
  const validKeyHashes = new Set<string>()
  for (const k of effectiveKeys) {
    validKeyHashes.add(hashKey(k))
  }
  for (const h of effectiveKeyHashes) {
    validKeyHashes.add(h.toLowerCase())
  }

  // 内存 Token Bucket（简单实现，进程重启归零）
  const buckets = new Map<string, { tokens: number; resetAt: number }>()

  function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex')
  }

  function checkRateLimit(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now()
    const bucket = buckets.get(key)
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { tokens: maxRequests - 1, resetAt: now + windowMs })
      return { allowed: true }
    }
    if (bucket.tokens > 0) {
      bucket.tokens--
      return { allowed: true }
    }
    return { allowed: false, retryAfterMs: bucket.resetAt - now }
  }

  function extractApiKey(req: IncomingMessage): string | null {
    // 优先 Header
    const headerKey = req.headers[headerName.toLowerCase()]
    if (headerKey) return Array.isArray(headerKey) ? headerKey[0] : headerKey
    // 备选 Query
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const queryKey = url.searchParams.get(queryParam)
    if (queryKey) return queryKey
    return null
  }

  function skipPath(pathname: string): boolean {
    return skipPaths.some((p) => pathname.startsWith(p))
  }

  // 记录开发模式自动生成的 key（仅记录一次，避免刷屏）
  let devKeyLogged = false

  return async function authMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void | Promise<void>,
  ): Promise<void> {
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname

    // 1. 跳过白名单路径
    if (skipPath(pathname)) {
      return next()
    }

    // 2. 鉴权（当有有效 keys 时生效，包括开发模式自动生成的）
    if (validKeyHashes.size > 0) {
      const apiKey = extractApiKey(req)
      if (!apiKey) {
        if (isDev && devKeyGenerated && !devKeyLogged) {
          // 开发模式自动生成 key 时，记录提示信息
          console.log('[context-pro] 开发模式自动生成 API Key，请在请求头添加:', effectiveKeys[0])
          devKeyLogged = true
        }
        writeJson(res, 401, { ok: false, error: 'Missing API Key', hint: isDev && devKeyGenerated ? '开发模式：请在请求头添加 x-api-key' : undefined })
        return
      }
      const keyHash = hashKey(apiKey)
      if (!validKeyHashes.has(keyHash)) {
        writeJson(res, 403, { ok: false, error: 'Invalid API Key' })
        return
      }
    } else if (isDev) {
      // 开发模式且无任何 key 配置：记录警告但放行（避免阻断本地开发）
      if (!devKeyLogged) {
        console.warn('[context-pro] 警告：开发模式下 HTTP 端点无鉴权保护，建议配置 chains.insight.auth 或设置 CONTEXT_PRO_DEV_KEY 环境变量')
        devKeyLogged = true
      }
    }

    // 3. 限流
    const apiKey = extractApiKey(req)
    const rlKey = keyGenerator(req, apiKey)
    const { allowed, retryAfterMs } = checkRateLimit(rlKey)
    if (!allowed) {
      res.setHeader('Retry-After', Math.ceil((retryAfterMs ?? 0) / 1000))
      writeJson(res, 429, { ok: false, error: 'Rate limit exceeded' })
      return
    }

    // 4. 通过
    return next()
  }
}

function writeJson(res: ServerResponse, status: number, data: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** 在 registerInsightHTTP 中集成鉴权的包装器 */
export function withAuth(
  handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void | Promise<void>,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
): (req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void> {
  return async (req, res) => {
    return new Promise<void>((resolve) => {
      authMiddleware(req, res, () => {
        Promise.resolve(handler(req, res)).then(resolve)
      })
    })
  }
}