/**
 * DSH Context-Aware Code Review Plugin
 *
 * Provides a `context.codeReview` capability that analyzes code changes
 * with semantic context, dependency weights, and change history.
 *
 * Three code shapes:
 * - definePlugin (core): registers the capability & hooks
 * - defineHook (preToolCall): injects review hints into additionalContext
 * - defineTool (external): allows CLI/HTTP direct invocation
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import { definePlugin, defineHook, defineTool } from './utils/define.js'
import { CodeReviewCapability, CodeReviewConfig } from './capability.js'
import { preToolCallHook } from './hook.js'
import { codeReviewTool } from './tool.js'

type ExtendedContext = Context

export const defaultConfig: Required<CodeReviewConfig> = {
  autoReview: true,
  maxFiles: 20,
  includeDependencies: true,
  includeHistory: true,
}

/** Main plugin entrypoint — function shape */
export const plugin: Plugin.Function<CodeReviewConfig> = definePlugin(
  'dsh-context-code-review',
  async (ctx: ExtendedContext, config: CodeReviewConfig) => {
    const merged = { ...defaultConfig, ...config }

    // Register the core capability
    const capability = new CodeReviewCapability(ctx, merged)
    ctx.provide?.('context.codeReview', capability)

    // Register preToolCall hook for automatic review injection
    if (merged.autoReview) {
      defineHook(ctx, 'tools/pre-execute', preToolCallHook(capability, merged))
    }

    // Register external tool for direct invocation
    defineTool(ctx, 'context.codeReview', codeReviewTool(capability))

    ctx.logger('dsh-context-code-review').info('Plugin loaded', { config: merged })
  },
  {
    Config: {
      type: 'object',
      properties: {
        autoReview: { type: 'boolean' },
        maxFiles: { type: 'number', minimum: 1, maximum: 100 },
        includeDependencies: { type: 'boolean' },
        includeHistory: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
)

export { CodeReviewCapability } from './capability.js'
export type { CodeReviewConfig, CodeReviewOptions } from './capability.js'