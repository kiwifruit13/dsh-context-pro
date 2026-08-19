/**
 * Integration tests for the full plugin
 * 
 * Note: These tests require the DSH-specific Cordis version (from vendor/cordis)
 * which has the Fiber-based plugin API. The npm cordis@1.6.0 has a different API.
 * For now, we test the plugin structure and capability logic in isolation.
 */

import { describe, it, expect } from 'vitest'
import { CodeReviewCapability, FileChange } from '../src/capability.js'

// Mock context for testing plugin structure
const createMockContext = () => ({
  logger: (name: string) => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  provide: vi.fn(),
  on: vi.fn(() => () => {}),
  events: {
    emit: vi.fn(),
    listeners: vi.fn(() => []),
  },
  registry: {
    plugin: vi.fn(() => ({ await: vi.fn() })),
  },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vi = await import('vitest').then(m => (m as any).vi ?? (m as any).default?.vi)

describe('dsh-context-code-review plugin structure', () => {
  let capability: CodeReviewCapability
  let mockCtx: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mockCtx = createMockContext()
    capability = new CodeReviewCapability(mockCtx as any, {
      maxFiles: 20,
      includeDependencies: true,
      includeHistory: true,
    })
  })

  it('instantiates capability with config', () => {
    expect(capability).toBeInstanceOf(CodeReviewCapability)
  })

  it('provides reviewChanges method', async () => {
    expect(typeof capability.reviewChanges).toBe('function')
    
    const changes: FileChange[] = [{
      path: 'test.ts',
      language: 'typescript',
      content: 'export function add(a: number, b: number) { return a + b }',
      isNew: true,
      isDeleted: false,
    }]
    
    const report = await capability.reviewChanges(changes)
    expect(report.summary.filesReviewed).toBe(1)
    expect(report.findings).toBeDefined()
  })

  it('provides generateReviewHint method', () => {
    expect(typeof capability.generateReviewHint).toBe('function')
  })

  it('handles empty changes', async () => {
    const report = await capability.reviewChanges([])
    expect(report.summary.filesReviewed).toBe(0)
  })

  it('produces valid report structure', async () => {
    const changes: FileChange[] = [{
      path: 'src/api.ts',
      language: 'typescript',
      content: `
export function getUser(id: string) { return db.users.find(id) }
export class UserService {
  async findAll() { return [] }
}
      `.trim(),
      isNew: true,
      isDeleted: false,
    }]

    const report = await capability.reviewChanges(changes)

    expect(report.summary).toEqual(expect.objectContaining({
      filesReviewed: 1,
      findingsBySeverity: expect.any(Object),
      overallRisk: expect.stringMatching(/^(low|medium|high|critical)$/),
      estimatedReviewTimeMinutes: expect.any(Number),
    }))
    expect(report.findings).toBeInstanceOf(Array)
    expect(report.dependencyGraph).toEqual(expect.objectContaining({
      nodes: expect.any(Array),
      edges: expect.any(Array),
      hotspots: expect.any(Array),
    }))
    expect(report.changeHistory).toBeInstanceOf(Array)
    expect(report.recommendations).toBeInstanceOf(Array)
  })
})

describe('plugin exports', () => {
  it('exports plugin and types', async () => {
    const mod = await import('../src/index.js')
    expect(mod.plugin).toBeDefined()
    expect(mod.CodeReviewCapability).toBeDefined()
    expect(mod.defaultConfig).toBeDefined()
  })
})