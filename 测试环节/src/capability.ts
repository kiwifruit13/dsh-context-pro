/**
 * Core Code Review Capability
 *
 * Analyzes code changes with:
 * - Semantic context (symbols, imports, exports)
 * - Dependency weights (import graph, call graph)
 * - Change history (git blame, recent modifications)
 * - Risk assessment (breaking changes, test coverage gaps)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'

// Extend Context with logger for this plugin (DSH Context already has logger)
type ExtendedContext = Context & {
  logger(name: string): { info: (msg: string, meta?: object) => void; warn: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void }
}

export interface FileChange {
  path: string
  language: string
  content: string
  diff?: string
  isNew: boolean
  isDeleted: boolean
}

export interface SymbolInfo {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'export'
  location: { file: string; line: number; column: number }
  signature?: string
  docComment?: string
  references: number
  isExported: boolean
}

export interface DependencyEdge {
  from: string
  to: string
  weight: number
  type: 'import' | 'call' | 'type' | 'reexport'
}

export interface ChangeHistoryEntry {
  file: string
  author: string
  date: string
  message: string
  linesChanged: number
}

export interface ReviewFinding {
  id: string
  severity: 'critical' | 'major' | 'minor' | 'info'
  category: 'breaking-change' | 'test-gap' | 'dependency-risk' | 'style' | 'performance' | 'security' | 'documentation'
  file: string
  line?: number
  message: string
  suggestion?: string
  relatedSymbols?: string[]
  confidence: number
}

export interface ReviewReport {
  summary: {
    filesReviewed: number
    findingsBySeverity: Record<string, number>
    overallRisk: 'low' | 'medium' | 'high' | 'critical'
    estimatedReviewTimeMinutes: number
  }
  findings: ReviewFinding[]
  dependencyGraph: {
    nodes: SymbolInfo[]
    edges: DependencyEdge[]
    hotspots: string[]
  }
  changeHistory: ChangeHistoryEntry[]
  recommendations: string[]
}

export interface CodeReviewConfig {
  /** Enable automatic review on tool calls that modify code */
  autoReview?: boolean
  /** Maximum files to review in a single batch */
  maxFiles?: number
  /** Include dependency analysis in review */
  includeDependencies?: boolean
  /** Include change history in review */
  includeHistory?: boolean
}

export interface CodeReviewOptions {
  maxFiles: number
  includeDependencies: boolean
  includeHistory: boolean
}

export class CodeReviewCapability {
  private logger: ReturnType<ExtendedContext['logger']>
  private options: CodeReviewOptions

  constructor(ctx: ExtendedContext, options: CodeReviewOptions) {
    this.logger = ctx.logger('context.codeReview')
    this.options = options
  }

  /** Main entry: review a set of file changes */
  async reviewChanges(changes: FileChange[]): Promise<ReviewReport> {
    this.logger.info('Starting code review', { fileCount: changes.length })

    // Limit files
    const limitedChanges = changes.slice(0, this.options.maxFiles)

    // Parallel analysis - extract symbols first, then use them
    const symbols = await this.extractSymbols(limitedChanges)
    const [dependencies, history] = await Promise.all([
      this.options.includeDependencies ? this.analyzeDependencies(limitedChanges, symbols) : { nodes: [], edges: [], hotspots: [] },
      this.options.includeHistory ? this.fetchChangeHistory(limitedChanges) : [],
    ])

    // Generate findings
    const findings = await this.generateFindings(limitedChanges, symbols, dependencies, history)

    // Build report
    const report = this.buildReport(limitedChanges, findings, dependencies, history)

    this.logger.info('Code review completed', {
      findings: findings.length,
      risk: report.summary.overallRisk,
    })

    return report
  }

  /** Review a single tool execution's file modifications */
  async reviewToolExecution(exec: ToolExecution, result: ToolExecutionResult): Promise<ReviewReport | null> {
    // Extract file changes from tool execution
    const changes = this.extractChangesFromExecution(exec, result)
    if (changes.length === 0) return null

    return this.reviewChanges(changes)
  }

  /** Generate review hint for injection into additionalContext */
  async generateReviewHint(exec: ToolExecution, result: ToolExecutionResult): Promise<UserMessage | null> {
    const report = await this.reviewToolExecution(exec, result)
    if (!report) return null

    const criticalFindings = report.findings.filter(f => f.severity === 'critical' || f.severity === 'major')
    if (criticalFindings.length === 0) return null

    const content: ContentBlock[] = [
      {
        type: 'text',
        text: `🔍 **Code Review Alert** (${criticalFindings.length} significant findings)\n\n` +
          criticalFindings.slice(0, 5).map(f =>
            `- **${f.severity.toUpperCase()}** [${f.category}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`
          ).join('\n') +
          (criticalFindings.length > 5 ? `\n... and ${criticalFindings.length - 5} more` : ''),
      },
    ]

    return {
      role: 'user',
      content,
      source: { kind: 'plugin', plugin: 'dsh-context-code-review' },
    } as UserMessage
  }

  // ===== Private Analysis Methods =====

  private async extractSymbols(changes: FileChange[]): Promise<SymbolInfo[]> {
    const symbols: SymbolInfo[] = []

    for (const change of changes) {
      const fileSymbols = this.parseSymbols(change)
      symbols.push(...fileSymbols)
    }

    return symbols
  }

  private parseSymbols(change: FileChange): SymbolInfo[] {
    const symbols: SymbolInfo[] = []
    const lines = change.content.split('\n')

    // Simple regex-based symbol extraction (TypeScript/JavaScript focus)
    const patterns = [
      { regex: /^export\s+(?:async\s+)?function\s+(\w+)/, kind: 'function' as const },
      { regex: /^export\s+class\s+(\w+)/, kind: 'class' as const },
      { regex: /^export\s+interface\s+(\w+)/, kind: 'interface' as const },
      { regex: /^export\s+type\s+(\w+)/, kind: 'type' as const },
      { regex: /^export\s+(?:const|let|var)\s+(\w+)/, kind: 'variable' as const },
      { regex: /^(?:async\s+)?function\s+(\w+)/, kind: 'function' as const },
      { regex: /^class\s+(\w+)/, kind: 'class' as const },
      { regex: /^interface\s+(\w+)/, kind: 'interface' as const },
      { regex: /^type\s+(\w+)/, kind: 'type' as const },
    ]

    lines.forEach((line, idx) => {
      for (const { regex, kind } of patterns) {
        const match = line.match(regex)
        if (match && match[1]) {
          symbols.push({
            name: match[1],
            kind,
            location: { file: change.path, line: idx + 1, column: match.index ?? 0 },
            signature: line.trim(),
            isExported: line.trim().startsWith('export '),
            references: 0, // Would need full analysis
          })
        }
      }
    })

    return symbols
  }

  private async analyzeDependencies(
    changes: FileChange[],
    symbols: SymbolInfo[],
  ): Promise<{ nodes: SymbolInfo[]; edges: DependencyEdge[]; hotspots: string[] }> {
    const edges: DependencyEdge[] = []
    const importMap = new Map<string, Set<string>>()

    // Extract imports from changed files
    for (const change of changes) {
      const imports = this.extractImports(change.content)
      importMap.set(change.path, new Set(imports))

      for (const imp of imports) {
        edges.push({
          from: change.path,
          to: imp,
          weight: 1,
          type: 'import',
        })
      }
    }

    // Find hotspots (files with many incoming dependencies)
    const incomingCount = new Map<string, number>()
    for (const edge of edges) {
      incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1)
    }

    const hotspots = [...incomingCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file]) => file)

    return { nodes: symbols, edges, hotspots }
  }

  private extractImports(content: string): string[] {
    const imports: string[] = []
    const lines = content.split('\n')

    for (const line of lines) {
      const match = line.match(/^import\s+.*?\s+from\s+['"](.+?)['"]/)
      if (match && match[1]) {
        imports.push(match[1])
      }
    }

    return imports
  }

  private async fetchChangeHistory(changes: FileChange[]): Promise<ChangeHistoryEntry[]> {
    // In production, this would call git log or a history service
    // For now, return mock data structure
    const history: ChangeHistoryEntry[] = []

    for (const change of changes) {
      // Simulate git log --oneline -10 -- <file>
      history.push({
        file: change.path,
        author: 'unknown',
        date: new Date().toISOString(),
        message: 'Recent modification',
        linesChanged: change.content.split('\n').length,
      })
    }

    return history
  }

  private async generateFindings(
    changes: FileChange[],
    symbols: SymbolInfo[],
    dependencies: { nodes: SymbolInfo[]; edges: DependencyEdge[]; hotspots: string[] },
    history: ChangeHistoryEntry[],
  ): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = []

    for (const change of changes) {
      // 1. Breaking change detection
      findings.push(...this.detectBreakingChanges(change, symbols))

      // 2. Test gap detection
      findings.push(...this.detectTestGaps(change))

      // 3. Dependency risk
      if (this.options.includeDependencies) {
        findings.push(...this.detectDependencyRisks(change, dependencies))
      }

      // 4. Style/consistency
      findings.push(...this.detectStyleIssues(change))

      // 5. Performance hints
      findings.push(...this.detectPerformanceIssues(change))

      // 6. Security patterns
      findings.push(...this.detectSecurityPatterns(change))

      // 7. Documentation gaps
      findings.push(...this.detectDocumentationGaps(change, symbols))
    }

    // Sort by severity and confidence
    return findings.sort((a, b) => {
      const severityOrder = { critical: 0, major: 1, minor: 2, info: 3 }
      if (severityOrder[a.severity] !== severityOrder[b.severity]) {
        return severityOrder[a.severity] - severityOrder[b.severity]
      }
      return b.confidence - a.confidence
    })
  }

  private detectBreakingChanges(change: FileChange, symbols: SymbolInfo[]): ReviewFinding[] {
    const findings: ReviewFinding[] = []
    const fileSymbols = symbols.filter(s => s.location.file === change.path)

    for (const symbol of fileSymbols) {
      if (symbol.isExported && change.diff) {
        // Check if exported signature changed
        if (change.diff.includes(`-${symbol.signature}`) || change.diff.includes(`+${symbol.signature}`)) {
          findings.push({
            id: `breaking-${change.path}-${symbol.name}`,
            severity: 'critical',
            category: 'breaking-change',
            file: change.path,
            line: symbol.location.line,
            message: `Exported ${symbol.kind} "${symbol.name}" signature may have changed`,
            suggestion: 'Verify backward compatibility; consider deprecation path',
            relatedSymbols: [symbol.name],
            confidence: 0.8,
          })
        }
      }
    }

    return findings
  }

  private detectTestGaps(change: FileChange): ReviewFinding[] {
    const findings: ReviewFinding[] = []

    // Check if test file exists
    const testPaths = [
      change.path.replace(/\.(ts|js)$/, '.test.$1'),
      change.path.replace(/\.(ts|js)$/, '.spec.$1'),
      change.path.replace('/src/', '/tests/').replace(/\.(ts|js)$/, '.test.$1'),
    ]

    const hasTest = testPaths.some(p => {
      // In real implementation, check filesystem
      return false // Mock: assume no test
    })

    if (!hasTest && !change.path.includes('.test.') && !change.path.includes('.spec.')) {
      findings.push({
        id: `test-gap-${change.path}`,
        severity: 'major',
        category: 'test-gap',
        file: change.path,
        message: 'No corresponding test file found for this change',
        suggestion: 'Add unit tests covering the modified functionality',
        confidence: 0.7,
      })
    }

    return findings
  }

  private detectDependencyRisks(
    change: FileChange,
    dependencies: { nodes: SymbolInfo[]; edges: DependencyEdge[]; hotspots: string[] },
  ): ReviewFinding[] {
    const findings: ReviewFinding[] = []

    // Check if modified file is a hotspot
    if (dependencies.hotspots.includes(change.path)) {
      findings.push({
        id: `hotspot-${change.path}`,
        severity: 'major',
        category: 'dependency-risk',
        file: change.path,
        message: 'This file is a dependency hotspot (many files depend on it)',
        suggestion: 'Changes here have high blast radius; ensure comprehensive testing',
        confidence: 0.85,
      })
    }

    // Check for circular dependencies (simplified)
    const outgoing = dependencies.edges.filter(e => e.from === change.path)
    const incoming = dependencies.edges.filter(e => e.to === change.path)
    for (const out of outgoing) {
      for (const inEdge of incoming) {
        if (out.to === inEdge.from) {
          findings.push({
            id: `circular-${change.path}-${out.to}`,
            severity: 'critical',
            category: 'dependency-risk',
            file: change.path,
            message: `Potential circular dependency with ${out.to}`,
            suggestion: 'Refactor to break the cycle',
            confidence: 0.6,
          })
        }
      }
    }

    return findings
  }

  private detectStyleIssues(change: FileChange): ReviewFinding[] {
    const findings: ReviewFinding[] = []
    const lines = change.content.split('\n')

    lines.forEach((line, idx) => {
      // Line too long
      if (line.length > 120) {
        findings.push({
          id: `style-line-${change.path}-${idx}`,
          severity: 'minor',
          category: 'style',
          file: change.path,
          line: idx + 1,
          message: `Line exceeds 120 characters (${line.length})`,
          suggestion: 'Break into multiple lines',
          confidence: 0.9,
        })
      }

      // TODO/FIXME comments
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
        findings.push({
          id: `style-todo-${change.path}-${idx}`,
          severity: 'info',
          category: 'documentation',
          file: change.path,
          line: idx + 1,
          message: 'Contains TODO/FIXME/HACK comment',
          suggestion: 'Create issue or resolve before merge',
          confidence: 1.0,
        })
      }
    })

    return findings
  }

  private detectPerformanceIssues(change: FileChange): ReviewFinding[] {
    const findings: ReviewFinding[] = []
    const content = change.content

    // Detect potential N+1 queries
    if (/\.map\(.*await|\.forEach\(.*await/.test(content)) {
      findings.push({
        id: `perf-nplus1-${change.path}`,
        severity: 'major',
        category: 'performance',
        file: change.path,
        message: 'Potential N+1 async pattern detected (map/forEach with await)',
        suggestion: 'Use Promise.all with map, or batch the operations',
        confidence: 0.7,
      })
    }

    // Detect synchronous I/O in async context
    if (/fs\.readFileSync|fs\.writeFileSync|require\(.*\.json\)/.test(content)) {
      findings.push({
        id: `perf-sync-io-${change.path}`,
        severity: 'minor',
        category: 'performance',
        file: change.path,
        message: 'Synchronous I/O detected in what appears to be async code',
        suggestion: 'Use async fs.promises APIs',
        confidence: 0.6,
      })
    }

    return findings
  }

  private detectSecurityPatterns(change: FileChange): ReviewFinding[] {
    const findings: ReviewFinding[] = []
    const content = change.content

    // Detect eval/Function constructor
    if (/\beval\(|\bnew Function\(/.test(content)) {
      findings.push({
        id: `sec-eval-${change.path}`,
        severity: 'critical',
        category: 'security',
        file: change.path,
        message: 'Use of eval() or Function constructor detected',
        suggestion: 'Avoid dynamic code execution; use safe alternatives',
        confidence: 0.95,
      })
    }

    // Detect hardcoded secrets
    if (/(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(content)) {
      findings.push({
        id: `sec-secret-${change.path}`,
        severity: 'critical',
        category: 'security',
        file: change.path,
        message: 'Possible hardcoded secret detected',
        suggestion: 'Use environment variables or secret manager',
        confidence: 0.8,
      })
    }

    // Detect SQL injection risk
    if (/\$\{.*\}.*query|query\s*\+\s*.*input/.test(content)) {
      findings.push({
        id: `sec-sql-${change.path}`,
        severity: 'major',
        category: 'security',
        file: change.path,
        message: 'Potential SQL injection via string interpolation',
        suggestion: 'Use parameterized queries',
        confidence: 0.7,
      })
    }

    return findings
  }

  private detectDocumentationGaps(change: FileChange, symbols: SymbolInfo[]): ReviewFinding[] {
    const findings: ReviewFinding[] = []
    const fileSymbols = symbols.filter(s => s.location.file === change.path && s.isExported)

    for (const symbol of fileSymbols) {
      if (!symbol.docComment && (symbol.kind === 'function' || symbol.kind === 'class' || symbol.kind === 'interface')) {
        findings.push({
          id: `doc-${change.path}-${symbol.name}`,
          severity: 'minor',
          category: 'documentation',
          file: change.path,
          line: symbol.location.line,
          message: `Exported ${symbol.kind} "${symbol.name}" lacks JSDoc comment`,
          suggestion: 'Add JSDoc with description, params, and return value',
          relatedSymbols: [symbol.name],
          confidence: 0.9,
        })
      }
    }

    return findings
  }

  private extractChangesFromExecution(exec: ToolExecution, result: ToolExecutionResult): FileChange[] {
    // Extract file paths from tool arguments and results
    // This is a simplified version - real implementation would parse tool-specific outputs
    const changes: FileChange[] = []

    // For write/edit tools, extract file path and content
    if (exec.name === 'fs/write' || exec.name === 'fs/edit') {
      const args = exec.arguments as any
      if (args.path && args.content) {
        changes.push({
          path: args.path,
          language: this.detectLanguage(args.path),
          content: args.content,
          isNew: exec.name === 'fs/write',
          isDeleted: false,
        })
      }
    }

    return changes
  }

  private detectLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
    }
    return map[ext ?? ''] ?? 'text'
  }

  private buildReport(
    changes: FileChange[],
    findings: ReviewFinding[],
    dependencies: { nodes: SymbolInfo[]; edges: DependencyEdge[]; hotspots: string[] },
    history: ChangeHistoryEntry[],
  ): ReviewReport {
    const findingsBySeverity = findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)

    const criticalCount = findingsBySeverity['critical'] ?? 0
    const majorCount = findingsBySeverity['major'] ?? 0
    const minorCount = findingsBySeverity['minor'] ?? 0

    let overallRisk: ReviewReport['summary']['overallRisk'] = 'low'
    if (criticalCount > 0) overallRisk = 'critical'
    else if (majorCount > 2) overallRisk = 'high'
    else if (majorCount > 0 || minorCount > 5) overallRisk = 'medium'

    const estimatedReviewTimeMinutes = Math.ceil(
      changes.length * 2 + findings.length * 1.5
    )

    const recommendations = this.generateRecommendations(findings, dependencies, history)

    return {
      summary: {
        filesReviewed: changes.length,
        findingsBySeverity,
        overallRisk,
        estimatedReviewTimeMinutes,
      },
      findings,
      dependencyGraph: dependencies,
      changeHistory: history,
      recommendations,
    }
  }

  private generateRecommendations(
    findings: ReviewFinding[],
    dependencies: { nodes: SymbolInfo[]; edges: DependencyEdge[]; hotspots: string[] },
    history: ChangeHistoryEntry[],
  ): string[] {
    const recs: string[] = []

    const criticalFindings = findings.filter(f => f.severity === 'critical')
    if (criticalFindings.length > 0) {
      recs.push(`🚨 ${criticalFindings.length} critical finding(s) — review before merge`)
    }

    const testGaps = findings.filter(f => f.category === 'test-gap')
    if (testGaps.length > 0) {
      recs.push(`📝 Add tests for ${testGaps.length} untested file(s)`)
    }

    if (dependencies.hotspots.length > 0) {
      recs.push(`🔥 Dependency hotspots: ${dependencies.hotspots.slice(0, 3).join(', ')} — changes here affect many files`)
    }

    const breakingChanges = findings.filter(f => f.category === 'breaking-change')
    if (breakingChanges.length > 0) {
      recs.push(`⚠️ ${breakingChanges.length} potential breaking change(s) — verify semver compliance`)
    }

    const securityFindings = findings.filter(f => f.category === 'security')
    if (securityFindings.length > 0) {
      recs.push(`🔒 ${securityFindings.length} security concern(s) — prioritize fix`)
    }

    if (recs.length === 0) {
      recs.push('✅ No significant issues found')
    }

    return recs
  }
}