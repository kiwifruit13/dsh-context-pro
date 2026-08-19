/**
 * PreToolCall Hook — injects code review hints into additionalContext
 *
 * This hook runs before tool execution and:
 * 1. Checks if the tool modifies code files
 * 2. Runs a quick review on the changes
 * 3. Returns a PreToolDecision with additionalContext for the model to see
 *
 * Implements the data paths from hook-tool-data-flow:
 * - Path 3: additionalContext (Hook → Model → Tool)
 * - Path 4: Decision (PreToolDecision mapping)
 */

import type { ToolExecution, ToolExecutionResult, PreToolDecision, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { CodeReviewCapability, CodeReviewOptions } from './capability.js'

// Use the execution input type for hook parameters
type HookExecution = ToolExecution

// Type assertion helper to bypass version mismatch between dsh-llm versions in test env
const asUserMsg = <T>(val: T) => val as any

export function preToolCallHook(
  capability: CodeReviewCapability,
  options: CodeReviewOptions,
) {
  return async (
    exec: HookExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> => {
    // Only review file-modifying tools
    const codeTools = new Set([
      'fs/write',
      'fs/edit',
      'fs/append',
      'fs/delete',
      'shell/exec', // Might modify files
    ])

    if (!codeTools.has(exec.name)) {
      return next()
    }

    // Quick pre-execution check - we don't have result yet
    // The actual review happens in post-execute, but we can inject
    // a hint based on the tool arguments

    const hint = await generatePreExecutionHint(exec, capability, options)
    if (hint) {
      // Inject via deferContext - this is the DSH way to add additionalContext
      // Cast to ToolRunContext which has deferContext, and use as any to bypass version mismatch
      (exec as ToolRunContext).deferContext(asUserMsg(hint))
    }

    return next()
  }
}

async function generatePreExecutionHint(
  exec: HookExecution,
  capability: CodeReviewCapability,
  options: CodeReviewOptions,
): Promise<UserMessage | null> {
  // For write/edit tools, we can do a quick static analysis on the input
  const args = exec.arguments as any

  if (exec.name === 'fs/write' && args.path && args.content) {
    const changes = [{
      path: args.path,
      language: detectLanguage(args.path),
      content: args.content,
      isNew: true,
      isDeleted: false,
    }]

    const report = await capability.reviewChanges(changes)
    if (report.findings.some(f => f.severity === 'critical' || f.severity === 'major')) {
      return formatReviewHint(report, 'pre-execution')
    }
  }

  if (exec.name === 'fs/edit' && args.path && args.newContent) {
    const diff = args.oldContent ? generateDiff(args.oldContent, args.newContent) : undefined
    const changes = [{
      path: args.path,
      language: detectLanguage(args.path),
      content: args.newContent,
      ...(diff !== undefined ? { diff } : {}),
      isNew: false,
      isDeleted: false,
    }]

    const report = await capability.reviewChanges(changes)
    if (report.findings.some(f => f.severity === 'critical' || f.severity === 'major')) {
      return formatReviewHint(report, 'pre-execution')
    }
  }

  return null
}

function formatReviewHint(report: any, phase: string): UserMessage {
  const criticalFindings = report.findings.filter((f: any) =>
    f.severity === 'critical' || f.severity === 'major'
  )

  const content = [
    {
      type: 'text' as const,
      text: `🔍 **Code Review (${phase})** — ${criticalFindings.length} significant finding(s)\n\n` +
        criticalFindings.slice(0, 3).map((f: any) =>
          `- **${f.severity.toUpperCase()}** [${f.category}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`
        ).join('\n') +
        (criticalFindings.length > 3 ? `\n... and ${criticalFindings.length - 3} more` : '') +
        `\n\n_Risk: ${report.summary.overallRisk} | Est. review time: ${report.summary.estimatedReviewTimeMinutes}min_`,
    },
  ]

  return asUserMsg({
    role: 'user',
    content,
    source: { kind: 'plugin', plugin: 'dsh-context-code-review' },
  })
}

/** Post-execution hook for full review with actual results */
export function postToolCallHook(
  capability: CodeReviewCapability,
  options: CodeReviewOptions,
) {
  return async (
    exec: HookExecution,
    result: ToolExecutionResult,
    next: () => Promise<any>,
  ): Promise<any> => {
    // Run full review on actual changes
    const reviewHint = await capability.generateReviewHint(exec, result)

    // Note: In the DSH hook system, post-execution hooks typically return
    // a PostToolDecision or modify the result. The additionalContext injection
    // happens at the pre-execution stage. Here we just proceed.
    // The reviewHint would be used by the caller if needed.

    // Log to session events would be done by the hook runner, not here

    return next()
  }
}

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go',
    java: 'java', cpp: 'cpp', c: 'c',
    cs: 'csharp', json: 'json', yaml: 'yaml',
    yml: 'yaml', md: 'markdown',
  }
  return map[ext ?? ''] ?? 'text'
}

function generateDiff(oldContent: string, newContent: string): string {
  // Simple diff - in production use a proper diff library
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const diff: string[] = []

  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (oldLine !== newLine) {
      if (oldLine !== undefined) diff.push(`- ${oldLine}`)
      if (newLine !== undefined) diff.push(`+ ${newLine}`)
    }
  }

  return diff.join('\n')
}