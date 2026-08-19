/**
 * OpenAPI 3.1 规范生成（极简版，避免类型问题）。
 * 仅在开发/调试环境注册，生产可通过配置关闭。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 生成基础 OpenAPI 文档（后续可扩展完整 schema） */
export function generateOpenAPISpec(): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'DSH Context Pro API',
      version: '0.2.0',
      description: '链感知上下文 + 洞察引擎 HTTP API',
    },
    servers: [{ url: '/', description: '当前部署' }],
    paths: {
      '/api/context-pro/topics': {
        get: {
          summary: '获取指定会话的推荐话题',
          parameters: [
            { name: 'sessionId', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]{4,}$' } },
          ],
          responses: {
            '200': { description: '成功' },
            '400': { description: '参数错误' },
          },
        },
      },
      '/api/context-pro/topics/stream': {
        get: {
          summary: 'SSE 实时推送话题变更',
          parameters: [
            { name: 'sessionId', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]{4,}$' } },
          ],
          responses: {
            '200': { description: 'SSE 流' },
            '400': { description: '参数错误' },
          },
        },
      },
      '/api/context-pro/topics/batch': {
        post: {
          summary: '批量查询多会话话题',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: '成功' }, '400': { description: '参数错误' }, '405': { description: '仅支持 POST' } },
        },
      },
      '/api/context-pro/mark-active': {
        post: {
          summary: '标记会话 Client 已激活',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: '成功' }, '400': { description: '参数错误' }, '405': { description: '仅支持 POST' } },
        },
      },
      '/api/context-pro/stats': {
        get: {
          summary: '获取全量可观测性指标',
          responses: { '200': { description: '成功' } },
        },
      },
      '/api/context-pro/openapi.json': {
        get: {
          summary: '获取 OpenAPI 3.1 规范文档',
          responses: { '200': { description: 'OpenAPI JSON' } },
        },
      },
    },
  }
}

/** 注册 OpenAPI 端点（仅开发环境建议开启） */
export function registerOpenAPIEndpoint(
  ctx: Context,
  logger: ReturnType<Context['logger']>,
): void {
  const webServer = ctx.get('webServer') as
    | { register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void | Promise<void> }) => () => void }
    | undefined

  if (!webServer) {
    logger.warn('webServer 不可用，OpenAPI 端点未注册')
    return
  }

  const spec = generateOpenAPISpec()

  const dispose = webServer.register({
    kind: 'exact',
    path: '/api/context-pro/openapi.json',
    handler(_req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(spec, null, 2))
    },
  })
  ctx.effect(() => dispose)

  logger.info('OpenAPI 端点已注册：GET /api/context-pro/openapi.json')
}