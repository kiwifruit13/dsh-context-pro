# 洞察模块：可信度归因演进（Todo）

> **模块宪法**：洞察模块在 ChainGraph（已有信息）上，通过稳定的归因方法论（节点证据 + 边证据 + 反证 + 综合评分），让每条洞察都自带可信度档案。洞察本身千变万化，但评估洞察的方法稳定可复用——这才是"有规可依"的真正含义。

---

## 阶段总览

| 阶段 | 内容 | 风险 | 状态 |
|------|------|------|------|
| **P0** | types.ts 契约（ConfidenceProfile + attributeInsights 接口） | 零 | 🟡 进行中 |
| **P1** | 实现 attributeInsights 纯函数 | 低 | ⏳ 待启动 |
| **P2** | 6 个分析器接入归因 | 中 | ⏳ 待启动 |
| **P3** | 暴露 get_insights_with_attribution tool | 低 | ⏳ 待启动 |
| **测试** | attributeInsights 单元测试 | 低 | ⏳ 待启动 |

---

## P0：契约先行

**目标**：在 `types.ts` 中新增 `ConfidenceProfile` 接口与 `attributeInsights()` 方法签名。不写实现，只钉契约。

### 交付物

1. `ConfidenceProfile` 接口（归因档案结构）
   - 节点证据 `NodeEvidence[]` —— 第一步：收集支持该洞察的 ChainNode
   - 边证据 `EdgeEvidence[]` —— 第二步：收集支撑该洞察的结构化关系
   - 反证 `ContradictingEvidence[]` —— 第三步：识别反向证据
   - 综合评分 `attributionScore: number` —— 第四步：归因可信度 0-1
   - 可读描述 `rationale: string` —— 人类可读的归因路径

2. `InsightItem` 接口扩展
   - 加可选字段 `confidenceProfile?: ConfidenceProfile`

3. `InsightEngine` 接口扩展
   - 加方法 `attributeInsights(sessionId: string): InsightItem[]`
   - 输入：会话 ChainGraph + 已有 InsightItem 列表
   - 输出：带 ConfidenceProfile 的 InsightItem[]
   - 纯函数语义：不修改 ChainGraph，不修改 InsightStore

### 关键约束

- ✅ 归因方法论稳定（四个维度固定）
- ❌ 洞察内容不模板化（不预设"如果 X 则 Y"规则）
- ✅ 零新增存储（复用 ChainGraph + InsightStore）
- ✅ 向后兼容（confidenceProfile 是可选字段）

### Review 检查点

- [ ] 归因方法论的四个维度是否完整
- [ ] 是否避免了"洞察内容模板化"陷阱
- [ ] 是否保持了"洞察本身千变万化"的灵活性
- [ ] 契约是否最小化（不引入未使用的字段）

---

## P1：核心实现

**目标**：实现 `attributeInsights()` 纯函数。

### 算法骨架

```
attributeInsights(graph, existingInsights):
  for each insight in existingInsights:
    profile = ConfidenceProfile {
      nodeEvidence: extractNodeEvidence(insight, graph),
      edgeEvidence: extractEdgeEvidence(insight, graph),
      contradictingEvidence: findContradictions(insight, graph),
      attributionScore: computeScore(...),
      rationale: humanReadablePath(insight, graph)
    }
    return insight with profile attached
```

### 四个子函数

| 子函数 | 输入 | 输出 | 关键逻辑 |
|--------|------|------|---------|
| `extractNodeEvidence` | InsightItem + ChainGraph | NodeEvidence[] | 通过 `insight.references[].nodeIds` 或 `scopeKey` 定位 ChainNode |
| `extractEdgeEvidence` | InsightItem + ChainGraph | EdgeEvidence[] | 扫描 ChainNode 的 parent/children/revisionOf/links/divergence/convergedFrom |
| `findContradictions` | InsightItem + ChainGraph | ContradictingEvidence[] | 找 superseded 节点 + 反向 divergence + 反向 confidence 趋势 |
| `computeScore` | node + edge + contradicting | number 0-1 | 加权平均：节点证据 + 边证据 - 反证惩罚 |

### 约束

- 纯函数（无副作用）
- 不修改 ChainGraph
- 不修改输入 InsightItem（返回新对象）
- 时间复杂度 O(N + E)，N = 节点数，E = 边数

### Review 检查点

- [ ] 四个子函数是否职责清晰
- [ ] 评分公式是否合理（节点权重、边权重、反证惩罚）
- [ ] 是否处理了边界情况（空图、无证据、全反证）
- [ ] rationale 生成是否人类可读

---

## P2：分析器接入

**目标**：让 6 个分析器在产出 InsightItem 时自动附带 ConfidenceProfile。

### 改造点

每个分析器（cross-reaction / migration / confidence-trend / gap-aggregation / divergence-watch / snapshot-trend）的最后一步：

```typescript
// 之前
return [insight1, insight2, ...]

// 之后
return attributeInsightsLocally(graph, [insight1, insight2, ...])
```

或者更优雅的方式：在 `appendInsights` 之后统一调用一次 `attributeInsights()`——避免每个分析器重复实现归因逻辑。

### 决策点

- **方案 A**：每个分析器内部调用（分布归因）
- **方案 B**：InsightEngine.analyze() 末尾统一调用（集中归因）

倾向 **方案 B**：归因是横切关注点，集中处理更整洁。

### Review 检查点

- [ ] 归因时机是否合理（analyze 末尾 vs 每个分析器内部）
- [ ] 性能影响（每轮多一次归因计算，可接受）
- [ ] 是否影响现有洞察的产出顺序或内容

---

## P3：Tool 暴露

**目标**：暴露 `get_insights_with_attribution` tool，让模型按需调取归因洞察。

### 工具设计

```
名称：get_insights_with_attribution
描述：获取当前会话的归因洞察（含可信度档案）。与 get_insights 类似，
     但每条洞察附带 confidenceProfile（节点证据 + 边证据 + 反证 + 综合评分）。
     参考性质，非约束——你可以采纳也可以忽略。
参数：
  type（可选）：筛选洞察类型
    - cross-reaction / migration / confidence-trend / 
      gap-aggregation / divergence-watch / snapshot-trend
  minScore（可选）：按 attributionScore 过滤（如 0.7 = 只看高可信度洞察）
返回：
  insights: InsightItem[]    // 每条带 confidenceProfile
```

### Review 检查点

- [ ] 工具描述是否清晰（与 get_insights 的区别）
- [ ] minScore 阈值是否合理
- [ ] 输出格式是否对模型友好（render 时如何展示 ConfidenceProfile）

---

## 测试

**目标**：为 `attributeInsights()` 编写单元测试。

### 测试用例

| 用例 | 场景 | 期望 |
|------|------|------|
| T1 | 单节点证据，无边，无反证 | attributionScore 高 |
| T2 | 多节点 + 多边证据 | attributionScore 更高 |
| T3 | 有反证（superseded 节点） | attributionScore 降低 |
| T4 | 全反证（无支撑证据） | attributionScore 接近 0 |
| T5 | 空图 + 单条洞察 | 归因失败，返回空档案或低分 |
| T6 | diverged 双路径 | 边证据包含 diverged-from |
| T7 | converged 合流 | 边证据包含 converged-into |
| T8 | cross-chain-link | 边证据包含跨链引用 |

### Review 检查点

- [ ] 边界条件是否覆盖
- [ ] 评分单调性是否合理（更多证据 → 更高分，除非有反证）
- [ ] rationale 是否能反映证据链

---

## 长期目标（不纳入当前迭代）

按 AGENTS.md §5"知识边界"——以下标记为长期演进方向，不在当前版本范围：

- ❌ **跨会话模式推广**（需要跨会话存储，违反"随会话生灭"约束）
- ❌ **洞察内容模板化**（违反"洞察本身千变万化"原则）
- ✅ **方法论可复用**（当前已实现）
- ✅ **结构可识别**（ConfidenceProfile 结构稳定，便于分析）

---

## 决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-08 | 洞察模块定位：可信度归因（不是结果评价） | 用户明确："让洞察从结果评价升级为归因诊断" |
| 2026-08 | 零新增存储，图谱是 ChainGraph 自然涌现 | 用户明确："图谱如果已经在 ChainGraph 里自然涌现了" |
| 2026-08 | 归因方法论稳定可复用，洞察内容千变万化 | 用户明确："洞察可是千变万化的，套用模版真的合适吗？" |
