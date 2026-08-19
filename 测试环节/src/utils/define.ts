/**
 * Helper utilities for the three code shapes:
 * - definePlugin: registers a function plugin with config validation
 * - defineHook: registers an event hook with proper typing
 * - defineTool: registers a tool definition for external invocation
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult, PreToolDecision, PostToolDecision } from '@deepseek-ai/dsh-tools'

/** Define a function plugin with standard-schema config validation */
export function definePlugin<T>(
  name: string,
  callback: (ctx: Context, config: T) => Awaitable<void>,
  options?: {
    Config?: any // StandardSchemaV1 equivalent
    inject?: string[]
    provide?: string | string[]
  },
): Plugin.Function<T> {
  const pluginFn = async function pluginWrapper(ctx: Context, config: T) {
    await callback(ctx, config)
  }
  Object.defineProperty(pluginFn, 'name', { value: name, configurable: true })
  return Object.assign(pluginFn, {
    Config: options?.Config,
    inject: options?.inject,
    provide: options?.provide,
  }) as Plugin.Function<T>
}

/** Define an event hook with typed handler */
export function defineHook(
  ctx: Context,
  event: string,
  handler: (...args: any[]) => any,
): () => void {
  // In DSH, ctx.on is available for event registration
  // This is a simplified version for testing
  return ctx.on?.(event as any, handler) ?? (() => {})
}

/** Define a tool for external invocation (CLI/HTTP) */
export function defineTool(
  ctx: Context,
  name: string,
  definition: Omit<ToolDefinition, 'name'> & { name?: string },
): void {
  const toolDef: ToolDefinition = { name, ...definition }
  ctx.provide?.(`tool:${name}`, toolDef)
}

/** Event map for Cordis + DSH core events */
export interface ContextEventMap {
  'tools/pre-execute': (exec: ToolExecutionInput, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
  'tools/post-execute': (exec: ToolExecutionInput, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
  'agent/pre-step': (payload: { agent: any; messages: any[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<any>) => Promise<any>
  'internal/plugin': (fiber: any) => void
  'internal/status': (fiber: any, oldState: number) => void
  'internal/config': (fiber: any, config: any, next: () => any) => any
  'internal/update': (fiber: any, config: any, noSave: boolean, next: () => any) => any
  [key: string]: (...args: any[]) => any
}

type Awaitable<T> = T | Promise<T>