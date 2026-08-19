# Hook ↔ Tool 接缝加固报告

**日期**：2025-01-18
**基于文档**：888.md（身份接缝分析）、999.md（六条数据通路全景）
**修改包**：
- `@deepseek-ai/dsh-hook-protocol`（共享协议库）
- `@deepseek-ai/dsh-hooks-claude-code`（Claude Code Hook Bridge）

---

## 背景

888.md 与 999.md 详细记录了 Hook 与 Tool 之间的**身份接缝**（`_session.id` vs `exec.agent.id`）与**六条数据通路**。审查发现以下隐匿风险：

| 风险 | 等级 | 说明 |
|------|------|------|
| `updatedInput` / `systemMessage` / `continue:false` 静默 warn | 🔴 P0 | Hook 以为生效，实际被忽略 |
| 身份接缝无运行时守卫 | 🟠 P1 | 构造保证一旦被绕过 → 静默数据错乱 |
| `additionalContext` 注入无审计日志 | 🟠 P1 | 无法追踪什么上下文何时注入给模型 |
| Hook 输出解析失败静默降级 | 🟡 P2 | 畸形 JSON/字段缺失不报错、不留痕 |
| 子 Agent 跨层存储无显式 API | 🟡 P2 | 易误用为共享存储 |

---

## 加固清单

### P0：显式错误替代静默 warn

**文件**：`packages/hooks/hooks-claude-code/src/index.ts`

```typescript
// 之前：ctx.logger.warn(...) 继续执行
// 现在：抛出 Error，终止当前 hook 点
if (output.updatedInput !== undefined) {
  throw new Error(`${point} hook requested updatedInput, which is not honored ...`)
}
if (output.systemMessage !== undefined) {
  throw new Error(`${point} hook emitted a systemMessage, which is not surfaced ...`)
}
if (output.continue === false) {
  throw new Error(`${point} hook requested continue:false (run-level halt), which is not implemented ...`)
}
```

**效果**：Hook 开发者立即在日志/控制台看到明确报错，而非事后发现“配置没生效”。

---

### P1：身份接缝运行时断言（可配置）

**文件**：`packages/hooks/hooks-claude-code/src/index.ts`

```typescript
// 新增配置项
assertIdentitySeam?: boolean  // 默认 false

// runPoint 入口处验证
if (config.assertIdentitySeam && opts.agent) {
  const payloadSessionId = (payload as Record<string, unknown>).session_id
  const agentId = opts.agent.id
  if (payloadSessionId !== undefined && payloadSessionId !== agentId) {
    throw new Error(`identity seam violation: payload.session_id="${payloadSessionId}" !== agent.id="${agentId}"`)
  }
}
```

**开启方式**（settings.yaml 或 preset）：
```yaml
hooks-claude-code:
  config:
    assertIdentitySeam: true
```

**防御场景**：
- 恶意/缺陷 Hook 进程篡改 stdin `session_id`
- 手动构造 `ToolExecutionInput` 填入错误 agent
- `exec.agent` 引用跨 `withInitiator` 边界逃逸

---

### P1：additionalContext 注入审计日志

**新增事件类型**（`hook-protocol/src/types.ts`）：
```typescript
'hook/context-injected': {
  turn: number
  step?: number
  point: string
  dialect: HookDialect
  handlerIds: string[]
  context: string
}
```

**记录点**（`hooks-claude-code/src/index.ts`）：
| Hook 点 | turn | step | 说明 |
|--------|------|------|------|
| SessionStart | 0 | — | 会话启动前 |
| UserPromptSubmit | N | — | 用户提交提示词时 |
| PreToolUse | N | — | 工具执行前 |
| PostToolUse | N | 当前 step | 工具执行后 |
| Stop | N | — | turn 停止边界 |
| SubagentStart | 0 | — | 子 agent 启动前 |

**查询示例**：
```sql
-- 查看某 turn 注入了什么上下文
SELECT * FROM events WHERE type = 'hook/context-injected' AND turn = 5;
```

---

### P2：Hook 输出解析诊断事件

**新增事件类型**（`hook-protocol/src/types.ts`）：
```typescript
'hook/parse-diagnostic': {
  turn: number
  point: string
  dialect: HookDialect
  handlerId: string
  issue: 'json-parse-failed' | 'event-name-mismatch' | 'invalid-decision' | 'missing-field' | 'malformed-hook-specific-output'
  detail: string
  rawStdout?: string
  rawStderr?: string
}
```

**触发条件**（`hooks-claude-code/src/index.ts` 运行时）：
| 诊断类型 | 触发条件 |
|----------|----------|
| `json-parse-failed` | stdout 以 `{` 开头但解析失败或无识别字段 |
| `event-name-mismatch` | `hookEventName` 存在且 ≠ 当前 firing event |
| `invalid-decision` | 顶层 `decision` 非 `approve`/`block`（如 `allow`/`deny`/`ask`） |

**注意**：解析器 `parseHookOutput` 保持**全量容错**（不抛异常），仅在会话日志留痕。

---

### P2：子 Agent 跨层存储显式 API（设计预留）

> 文档已记录风险，实现留待后续 PR：
> - `parentSessionStore.get(key)` / `set(key, value)` 服务
> - 在 `subagent` 包中提供，避免误用 `session_id` 共享存储

---

## 变更文件清单

| 文件 | 变更类型 |
|------|----------|
| `hook-protocol/src/types.ts` | +2 event types |
| `hook-protocol/src/events.ts` | +2 append functions + types |
| `hook-protocol/src/index.ts` | +exports |
| `hooks-claude-code/src/index.ts` | +assertIdentitySeam config, +P0 throws, +audit logging, +parse diagnostics |
| `hooks-claude-code/src/config.ts` | （无需改，配置通过 plugin config 传入） |

---

## TypeScript 编译验证

```bash
pnpm run typecheck
# ✅ 通过
```

---

## 回滚/兼容性说明

| 变更 | 破坏性 | 备注 |
|------|--------|------|
| P0 throws | ✅ 是 | 故意破坏：原本静默忽略的字段现在报错，符合“显式优于隐式” |
| assertIdentitySeam | ❌ 否 | 默认关闭，需显式开启 |
| 新增事件类型 | ❌ 否 | 纯增量，不影响现有消费者 |
| parse diagnostics | ❌ 否 | 仅写日志，不改变解析行为 |

---

## 后续建议

1. **默认开启 `assertIdentitySeam`**：待生产验证无误报后，考虑在 `cordis.patch.yml` 基础配置中设为 `true`
2. **子 Agent 存储 API**：在 `dsh-subagent` 中实现 `ParentSessionStore` 服务
3. **Hook 配置校验**：在 `parseClaudeCodeConfig` 阶段拒绝包含 `updatedInput`/`systemMessage`/`continue` 的 hook 配置，提前报错
4. **诊断事件聚合告警**：接入 `runtime-diagnostics/invariants`，对高频 `json-parse-failed` 自动告警

---

## 关联文档

- [888.md](../888.md) — 身份接缝深度解析
- [999.md](../999.md) — 六条数据通路全景
- [hook-bridges Agent Note](../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md) — 原始设计备忘