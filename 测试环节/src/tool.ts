/**
 * External Tool Definition — allows CLI/HTTP direct invocation of code review
 *
 * Implements Path 1 (stdin payload) and Path 2 (stdout JSON) for external hook compatibility,
 * and provides a native tool interface for programmatic use.
 */

import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult, JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { CodeReviewCapability, FileChange, ReviewReport } from './capability.js'

export function codeReviewTool(capability: CodeReviewCapability): any {
  return {
    description: 'Perform context-aware code review on a set of file changes. Analyzes semantic context, dependencies, change history, and risk factors.',
    output: {
      properties: {
        success: { type: 'boolean' },
        report: { type: 'object' },
        error: { type: 'string' },
      },
    } as any,
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to review',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
              content: { type: 'string', description: 'File content' },
              diff: { type: 'string', description: 'Optional diff' },
              isNew: { type: 'boolean', description: 'Whether this is a new file' },
              isDeleted: { type: 'boolean', description: 'Whether this file was deleted' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
        options: {
          type: 'object',
          description: 'Review options',
          properties: {
            maxFiles: { type: 'number', default: 20 },
            includeDependencies: { type: 'boolean', default: true },
            includeHistory: { type: 'boolean', default: true },
          },
          additionalProperties: false,
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
      const args = exec.arguments as {
        files: FileChange[]
        options?: Partial<{ maxFiles: number; includeDependencies: boolean; includeHistory: boolean }>
      }

      const { files, options = {} } = args

      // Validate
      if (!files || files.length === 0) {
        return {
          isError: true,
          error: { message: 'At least one file is required' },
          content: [{ type: 'text', text: 'Error: At least one file is required' }],
        }
      }

      try {
        // Run review with options
        const report = await capability.reviewChanges(files)

        // Format output
        const content = formatReport(report)

        const additionalContexts = report.summary.overallRisk !== 'low' ? [{
            role: 'user',
            content: [{
              type: 'text',
              text: `⚠️ Review completed with ${report.summary.overallRisk.toUpperCase()} risk. ${report.recommendations.join(' ')}`,
            }],
            source: { kind: 'plugin', plugin: 'dsh-context-code-review' },
          }] : undefined

        return {
          isError: false,
          value: report as unknown as JsonValue,
          content: content as any,
          additionalContexts: additionalContexts as any,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          isError: true,
          error: { message },
          content: [{ type: 'text', text: `Review failed: ${message}` }] as any,
        }
      }
    },
  }
}

function formatReport(report: ReviewReport): any[] {
  const blocks: any[] = []

  // Summary
  blocks.push({
    type: 'text',
    text: `## Code Review Report\n\n` +
      `**Files reviewed:** ${report.summary.filesReviewed}\n` +
      `**Overall risk:** ${report.summary.overallRisk.toUpperCase()}\n` +
      `**Estimated review time:** ${report.summary.estimatedReviewTimeMinutes} min\n\n` +
      `**Findings by severity:**\n` +
      Object.entries(report.summary.findingsBySeverity)
        .map(([sev, count]) => `- ${sev}: ${count}`)
        .join('\n'),
  })

  // Recommendations
  if (report.recommendations.length > 0) {
    blocks.push({
      type: 'text',
      text: `\n## Recommendations\n\n` + report.recommendations.map(r => `- ${r}`).join('\n'),
    })
  }

  // Top findings
  const topFindings = report.findings.slice(0, 10)
  if (topFindings.length > 0) {
    blocks.push({
      type: 'text',
      text: `\n## Top Findings\n\n` +
        topFindings.map(f =>
          `### ${f.severity.toUpperCase()} [${f.category}] ${f.file}${f.line ? `:${f.line}` : ''}\n` +
          `${f.message}\n` +
          (f.suggestion ? `> 💡 ${f.suggestion}\n` : '') +
          (f.relatedSymbols?.length ? `> 🔗 Related: ${f.relatedSymbols.join(', ')}\n` : '') +
          `> Confidence: ${Math.round(f.confidence * 100)}%`
        ).join('\n\n'),
    })
  }

  // Dependency hotspots
  if (report.dependencyGraph.hotspots.length > 0) {
    blocks.push({
      type: 'text',
      text: `\n## Dependency Hotspots\n\n` +
        report.dependencyGraph.hotspots.map(h => `- ${h}`).join('\n'),
    })
  }

  return blocks
}

/** CLI-compatible stdio interface for external hook usage */
export interface StdioReviewRequest {
  files: FileChange[]
  options?: { maxFiles?: number; includeDependencies?: boolean; includeHistory?: boolean }
}

export interface StdioReviewResponse {
  success: boolean
  report?: ReviewReport
  error?: string
}

/** Parse stdin JSON and output stdout JSON for hook compatibility */
export async function runStdioReview(
  capability: CodeReviewCapability,
  input: StdioReviewRequest,
): Promise<StdioReviewResponse> {
  try {
    const report = await capability.reviewChanges(input.files)
    return { success: true, report }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}