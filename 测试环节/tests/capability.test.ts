/**
 * Unit tests for CodeReviewCapability
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CodeReviewCapability, FileChange, ReviewFinding } from '../src/capability.js'

describe('CodeReviewCapability', () => {
  let capability: CodeReviewCapability
  let mockCtx: any

  beforeEach(() => {
    mockCtx = {
      logger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    }
    capability = new CodeReviewCapability(mockCtx, {
      maxFiles: 20,
      includeDependencies: true,
      includeHistory: true,
    })
  })

  describe('detectBreakingChanges', () => {
    it('detects exported function signature changes', () => {
      const change: FileChange = {
        path: 'src/api.ts',
        language: 'typescript',
        content: 'export function foo(bar: string): number { return 1 }',
        diff: '-export function foo(bar: string): number { return 1 }\n+export function foo(bar: number): string { return "1" }',
        isNew: false,
        isDeleted: false,
      }

      // Access private method via bracket notation for testing
      const findings = (capability as any).detectBreakingChanges(change, [{
        name: 'foo',
        kind: 'function',
        location: { file: 'src/api.ts', line: 1, column: 0 },
        signature: 'export function foo(bar: string): number { return 1 }',
        isExported: true,
        references: 5,
      }])

      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].category).toBe('breaking-change')
      expect(findings[0].severity).toBe('critical')
    })
  })

  describe('detectTestGaps', () => {
    it('flags missing test file', () => {
      const change: FileChange = {
        path: 'src/utils.ts',
        language: 'typescript',
        content: 'export function helper() { return 42 }',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectTestGaps(change)
      expect(findings.length).toBe(1)
      expect(findings[0].category).toBe('test-gap')
      expect(findings[0].severity).toBe('major')
    })

    it('does not flag test files themselves', () => {
      const change: FileChange = {
        path: 'src/utils.test.ts',
        language: 'typescript',
        content: 'import { helper } from "./utils"\ntest("helper", () => expect(helper()).toBe(42))',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectTestGaps(change)
      expect(findings.length).toBe(0)
    })
  })

  describe('detectStyleIssues', () => {
    it('flags long lines', () => {
      const change: FileChange = {
        path: 'src/style.ts',
        language: 'typescript',
        content: 'const veryLongLineThatExceedsTheMaximumAllowedLengthAndShouldBeFlagged = "this is a very long string that goes well beyond 120 characters"',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectStyleIssues(change)
      const longLineFinding = findings.find(f => f.message.includes('120 characters'))
      expect(longLineFinding).toBeDefined()
      expect(longLineFinding!.severity).toBe('minor')
    })

    it('flags TODO comments', () => {
      const change: FileChange = {
        path: 'src/todo.ts',
        language: 'typescript',
        content: '// TODO: implement this later\nexport function foo() {}',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectStyleIssues(change)
      const todoFinding = findings.find(f => f.message.includes('TODO'))
      expect(todoFinding).toBeDefined()
      expect(todoFinding!.severity).toBe('info')
    })
  })

  describe('detectPerformanceIssues', () => {
    it('detects N+1 async pattern', () => {
      const change: FileChange = {
        path: 'src/perf.ts',
        language: 'typescript',
        content: 'items.map(async item => await process(item))',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectPerformanceIssues(change)
      const nPlusOne = findings.find(f => f.message.includes('N+1'))
      expect(nPlusOne).toBeDefined()
      expect(nPlusOne!.severity).toBe('major')
    })
  })

  describe('detectSecurityPatterns', () => {
    it('detects eval usage', () => {
      const change: FileChange = {
        path: 'src/sec.ts',
        language: 'typescript',
        content: 'eval(userInput)',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectSecurityPatterns(change)
      const evalFinding = findings.find(f => f.message.includes('eval'))
      expect(evalFinding).toBeDefined()
      expect(evalFinding!.severity).toBe('critical')
    })

    it('detects hardcoded secrets', () => {
      const change: FileChange = {
        path: 'src/config.ts',
        language: 'typescript',
        content: 'const api_key = "sk-1234567890abcdef"',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectSecurityPatterns(change)
      const secretFinding = findings.find(f => f.message.includes('secret'))
      expect(secretFinding).toBeDefined()
      expect(secretFinding!.severity).toBe('critical')
    })
  })

  describe('detectDocumentationGaps', () => {
    it('flags exported functions without JSDoc', () => {
      const change: FileChange = {
        path: 'src/undoc.ts',
        language: 'typescript',
        content: 'export function publicApi() { return 1 }',
        isNew: true,
        isDeleted: false,
      }

      const findings = (capability as any).detectDocumentationGaps(change, [{
        name: 'publicApi',
        kind: 'function',
        location: { file: 'src/undoc.ts', line: 1, column: 0 },
        isExported: true,
        references: 1,
      }])

      expect(findings.length).toBe(1)
      expect(findings[0].category).toBe('documentation')
      expect(findings[0].severity).toBe('minor')
    })
  })

  describe('reviewChanges integration', () => {
    it('produces a complete review report', async () => {
      const changes: FileChange[] = [{
        path: 'src/main.ts',
        language: 'typescript',
        content: `
export function calculateTotal(items: number[]): number {
  return items.reduce((sum, n) => sum + n, 0)
}

export class Processor {
  async process(data: string) {
    // TODO: implement
    return data.toUpperCase()
  }
}
        `.trim(),
        isNew: true,
        isDeleted: false,
      }]

      const report = await capability.reviewChanges(changes)

      expect(report.summary.filesReviewed).toBe(1)
      expect(report.findings.length).toBeGreaterThan(0)
      expect(report.summary.overallRisk).toBeDefined()
      expect(report.recommendations.length).toBeGreaterThan(0)
      expect(report.dependencyGraph.nodes.length).toBeGreaterThan(0)
    })

    it('handles empty changes', async () => {
      const report = await capability.reviewChanges([])
      expect(report.summary.filesReviewed).toBe(0)
      expect(report.findings.length).toBe(0)
    })
  })
})