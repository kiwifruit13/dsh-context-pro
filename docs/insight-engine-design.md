# 洞察引擎设计文档（v0.3+ 归因版本）

> **本文档定位**：洞察模块的完整设计规格 + 决策记录。
>
> 与本文档相关：
>
> - [`docs/洞察引擎.md`](./洞察引擎.md) —— **v0.2.0 历史版本**（仅 6 个分析器，无归因档案）。本文档是其演进版。
> - [`docs/chain-design-final.md`](./chain-design-final.md) —— 五链图鉴终局规格（洞察模块的数据基础）
> - [`docs/融合进阶.md`](./融合进阶.md) —— 链间化学反应（模型侧 CoT 指导）
> - [`docs/CLAUDE.md`](./CLAUDE.md) —— 项目架构公约
>
> **核心关系**：图鉴（`prompt.ts`）让模型**内化**认知结构；快照（`snapshot.ts`）让系统**记录**链演化；洞察引擎（`insight.ts`）让系统**理解**链演化的全局含义。模型负责"想"，快照负责"记"，洞察负责"看"。

---

## 〇、模块宪法（一句话定位）

> **洞察模块在 ChainGraph（已有信息）上，通过稳定的归因方法论（节点证据 + 边证据 + 反证 + 综合评分），让每条洞察都自带可信度档案。洞察本身千变万化，但评估洞察的方法稳定可复用——这才是"有规可依"的真正含义。**

**关键约束**：

| 维度 | 约束 |
|------|------|
| 数据基础 | ChainGraph（已有信息，零新增存储） |
| 评估方法 | 节点证据 + 边证据 + 反证 + 综合评分（稳定结构） |
| 洞察内容 | 千变万化，不预设模板 |
| 生命周期 | 随会话生灭，无跨会话污染 |
| 干预边界 | 只观察、只建议，不干预 CoT |

---

## 一、为什么需要归因（从 v0.2.0 到 v0.3+ 的演进）

### v0.2.0 的局限

v0.2.0 版本的洞察引擎只做一件事：**从 ChainGraph 全局状态中检测现象**。

```
ChainGraph → 6 个分析器 → InsightItem[]（仅含 type/severity/title/detail）
```

**结构性盲区**：每条洞察只说"我看到了什么"（现象报告），不说"我为什么这样判断"（归因诊断）。模型调取 `get_insights` 时拿到的是**结论**，不是**推理过程**。

### v0.3+ 的改进

新增归因层，让每条洞察自带**归因档案**：

```
ChainGraph → 6 个分析器 → InsightItem[] 
                              ↓
                          attributeInsightsPure()
                              ↓
                          带 ConfidenceProfile 的 InsightItem[]
                              ↓
                          ┌─────────────┐
                          │ 节点证据     │ → "基于哪些 ChainNode"
                          │ 边证据       │ → "基于哪些结构化关系"
                          │ 反证         │ → "有哪些反向证据"
                          │ 综合评分     │ → "attributionScore 0-1"
                          │ rationale    │ → "人类可读的归因路径"
                          └─────────────┘
```

**核心飞跃**：洞察从"**结果评价**"升级为"**归因诊断**"。

### 设计哲学的对话演进

| 阶段 | 认知 | 决策 |
|------|------|------|
| 初始 | 洞察需要图谱作为新数据结构 | 引入 VariableGraph、GraphAdapter 等 |
| 中期 | 图谱不需要"建"——ChainGraph 本身就是图谱 | 取消独立图谱数据结构 |
| 后期 | 归因方法论稳定可复用，洞察内容千变万化 | 不预设洞察模板，归因档案结构固定但内容动态 |
| 最终 | "懂我"是涌现的，不需要刻意构造 | 只要归因真实、话题引用真实内容，用户的"被理解"感自然涌现 |

---

## 二、核心契约：ConfidenceProfile

### 2.1 接口定义

```typescript
export interface ConfidenceProfile {
  /** 节点级证据（第一步：收集支撑该洞察的 ChainNode） */
  nodeEvidence: NodeEvidence[]
  /** 边级证据（第二步：收集支撑该洞察的结构化关系） */
  edgeEvidence: EdgeEvidence[]
  /** 反证（第三步：识别反向证据；可为空） */
  contradictingEvidence: ContradictingEvidence[]
  /** 综合评分（第四步：归因可信度 0-1） */
  attributionScore: number
  /** 归因路径（人类可读） */
  rationale: string
}

export interface NodeEvidence {
  nodeId: string                                    // ChainNode.id
  role: 'primary' | 'supporting' | 'contradicting' // 证据角色
  weight: number                                     // 0-1（primary=1.0, supporting=0.6, contradicting=0.4）
  confidence?: number                                // 节点 confidence
}

export interface EdgeEvidence {
  kind: 'parent-child' | 'revision' | 'supersede'    // 6 种 ChainGraph 内置关系
      | 'diverged-from' | 'converged-into' 
      | 'cross-chain-link'
  fromNodeId: string
  toNodeId: string
  strength: number                                   // 0-1（结构化边通常 1.0）
}

export interface ContradictingEvidence {
  kind: 'superseded' | 'reverse-divergence'         // 4 种反证类型
      | 'confidence-decay' | 'no-support'
  refId: string
  strength: number                                   // 0-1
  note?: string                                      // 人类可读说明
}
```

### 2.2 归因评分公式

按 CLAUDE.md"简单第一"原则，保持可解释：

```
base = Σ(nodeEvidence.weight × confidence) / Σ(nodeEvidence.weight)
edgeBoost = min(edgeEvidence.length × 0.1, 0.3)               // 边证据加成，上限 0.3
contradictionPenalty = Σ(contradiction.strength) × 0.2         // 反证惩罚
attributionScore = clamp(base + edgeBoost - penalty, 0, 1)
```

**评分语义**：
- 节点证据是基础（决定 base）
- 边证据是加成（结构化关系越多越可信）
- 反证是惩罚（强度越大扣分越多）
- 整体保持 0-1 区间，可解释

### 2.3 设计原则（按 AGENTS.md §1）

- ✅ **方法论稳定可复用**：四步法（节点→边→反证→评分）结构固定
- ❌ **洞察内容不模板化**：档案不含任何"如果 X 则 Y"规则
- ✅ **零新增存储**：归因档案随返回值流转
- ✅ **向后兼容**：`confidenceProfile` 是可选字段，旧代码不受影响

---

## 三、归因算法详解（4 个子函数）

### 3.1 extractNodeEvidence（步骤 ①）

**输入**：InsightItem + ChainGraph

**提取路径**：
- **路径 A**：通过 `InsightReference.nodeIds`（如 `['causal@1.1', 'causal@1.2']`）精确匹配 → 适合 divergence 双路径
- **路径 B**：通过 `InsightReference.scopeKey`（如 `'causal:cause'`）+ chain/root/role 模糊匹配 → 找最新活跃节点

**输出**：NodeEvidence[]，按时间戳倒序，第一个为 primary，后续为 supporting

### 3.2 extractEdgeEvidence（步骤 ②）

**输入**：nodeEvidences + ChainGraph

**扫描每个节点证据的 6 种结构化关系**：

| 边类型 | 来源字段 | 含义 |
|--------|---------|------|
| `parent-child` | `node.parent` / `node.children` | 父子演化 |
| `revision` | `node.revisionOf` | 修正 |
| `supersede` | `node.status === 'superseded'` | 作废 |
| `diverged-from` | `node.divergence='ai'/'user'` 配对 | 分叉（共享根） |
| `converged-into` | `node.convergedFrom` 非空 | 合流 |
| `cross-chain-link` | `node.links` | 跨链引用 |

### 3.3 findContradictions（步骤 ③）

**4 种反证类型**：

| 类型 | 触发条件 | 强度 |
|------|---------|------|
| `superseded` | 节点证据中的某个节点被 superseded | 由具体节点决定 |
| `reverse-divergence` | 节点证据里有 diverged 双路径但无合流边 | 由具体节点决定 |
| `confidence-decay` | 节点 confidence=0 或 undefined | 0.7 / 0.3 |
| `no-support` | 节点证据和边证据都为空 | 1.0（最强） |

### 3.4 computeScore（步骤 ④）

按 §2.2 公式计算评分，并生成人类可读的 rationale：

```
"节点证据 N 条（base=X.XX）；边证据 M 条（+X.XX）；反证 K 条（-X.XX）；综合可信度 X.XX"
```

---

## 四、数据流全景

### 4.1 Analyze 流程

```
session/event (assistant/message)
        ↓
hook.ts 监听器 ② ──→ ChainIndex.ingest
                          ↓
                   ChainGraph 更新
                          ↓
                   insightEngine.analyze(sessionId, graph, guide, snapshot, changeContext)
                          ↓
              ┌──────────┴──────────┐
              ↓                     ↓
        6 个分析器跑                appendInsights(store, allInsights)
        （产生 InsightItem[]）              ↓
              ↓                     attributeInsightsPure()
        allInsights: InsightItem[]        ↓
                                   store.insights（带归因档案）
                                          ↓
                                   thisRoundInsights（lastSeenRound === round）
                                          ↓
                                   generateTopics(graph, guide, attributedInsights)
                                          ↓
                                   store.topics（每轮重建）
                                          ↓
                                   emit('topics-changed')
```

### 4.2 关键执行顺序

```
1. 6 个分析器产出未归因的 allInsights
2. attributeInsightsPure(allInsights, graph) → attributedFresh（带归因）
3. appendInsights(store, attributedFresh, round)
4. attributeInsightsPure(store.insights, graph) → 整体归因（保证 getInsights 返回带 profile）
5. generateTopics(graph, guide, store.insights.filter(lastSeenRound === round))
6. rebuildTopics(store, topics)
```

---

## 五、6 个分析器（保持 v0.2.0 行为）

> 本节简述，详细说明见 [`docs/洞察引擎.md`](./洞察引擎.md)。

| 分析器 | 检测目标 | 产出 InsightType |
|--------|---------|------------------|
| ① 链间化学反应 | 跨链节点内容重叠 | `cross-reaction` |
| ② 链迁移预测 | 主链进度 + 其他链状态 | `migration` |
| ③ 置信度趋势 | 跨轮 confidence 变化 | `confidence-trend` |
| ④ 脉络缺口聚合 | 多链 gaps 交叉 | `gap-aggregation` |
| ⑤ 分歧收敛预测 | diverged 节点状态 | `divergence-watch` |
| ⑥ 快照实时趋势 | 当前快照 + 历史趋势 | `snapshot-trend` |

**分析器是纯函数**：只读 ChainGraph + ChainGuide + FilterSelector，产出 InsightItem[]。互不依赖，可并行。

---

## 六、推荐话题生成（基于归因档案）

### 6.1 设计意图

**话题必须依据洞察产生**——让用户感到"AI 真的越来越懂我"。

**关键边界**：
- ✅ 话题依据洞察（不是凭空生成）
- ✅ 话题话术引用真实 ChainNode 内容（不是模板）
- ❌ 话题**不**按"洞察 type 套死话术"（避免你之前提醒的"洞察千变万化"陷阱）

### 6.2 6 条规则

| 规则 | 触发条件 | 话术来源 |
|------|---------|---------|
| 1. 化学反应苗头 | `cross-reaction` insight | 从 `confidenceProfile.nodeEvidence` 取 ChainNode 内容拼接 |
| 2. 置信度下降 | `confidence-trend` + severity ≠ info | 引用具体节点内容 + 归因评分 |
| 3. 分歧悬而未决 | `divergence-watch` + warn | 引用双路径的具体内容 |
| 4. 多链终结缺口 | `gap-aggregation` + 主链有 gaps | 引用已填充内容 + 主链缺口角色 |
| 5. 主链完整 + 置信稳定 | guide 状态（非洞察） | 引用终结角色内容 |
| 6. 链已收束 | guide 状态（非洞察） | 引用收束链 + 活跃链内容 |

### 6.3 basedOn 字段（话题的依据档案）

```typescript
export interface RecommendationTopic {
  kind: 'extension' | 'convergence'
  question: string
  rationale: string
  relatedChain?: ChainKind
  timestamp: number
  /**
   * 话题的依据档案
   * - 规则 1-4：基于洞察，basedOn 有值
   * - 规则 5-6：基于 guide 状态，basedOn 为 undefined
   */
  basedOn?: {
    insightTitle: string
    attributionScore: number
    keyNodeContents: string[]
    keyEdgeKinds: AttributionEdgeKind[]
  }
}
```

### 6.4 关键边界说明

**规则 5 和规则 6 不挂洞察**，因为"主链完整"和"链已收束"是 ChainGuide 的结构状态，不是洞察现象。这是有意为之——避免把"结构状态触发"硬凑成"洞察触发"。

---

## 七、工具暴露：get_insights

### 7.1 工具定义

```typescript
{
  name: 'get_insights',
  description: '获取当前会话的认知洞察建议（含归因档案）...',
  parameters: {
    type?: InsightType,        // 按类型筛选
    minScore?: number,          // 按 attributionScore 过滤
  },
  output: {
    insights: InsightItem[],    // 每条带 confidenceProfile
  }
}
```

### 7.2 与 v0.2.0 的差异

| 维度 | v0.2.0 | v0.3+ |
|------|--------|-------|
| 工具名称 | `get_insights` | `get_insights`（合并） |
| 返回字段 | `type/severity/title/detail` | 同上 + `confidenceProfile` |
| 归因档案 | ❌ 无 | ✅ 始终包含 |
| minScore 过滤 | ❌ 无 | ✅ 可选 |

**v0.3 早期版本**曾有独立的 `get_insights_with_attribution` tool——v0.3+ 合并为单一 `get_insights`，避免双轨造成模型困惑。

### 7.3 渲染格式

`get_insights` 的 `output.render` 把结构化 JSON 渲染成人类可读的 Markdown：

```markdown
## 认知洞察（带归因档案，建议，非约束）
- [warn] 因果链问题置信度下降：置信度连续 2 轮下降（最新 62%），趋势需关注。
  - 归因：节点证据 1 条（base=0.62）；综合可信度 0.62（attributionScore=0.62）
- [info] 深层归因动力学苗头：因果链的原因与时间链的过去内容重叠...
  - 归因：节点证据 2 条（base=0.78）；边证据 2 条（+0.20）；综合可信度 0.98（attributionScore=0.98）
```

---

## 八、生命周期与会话绑定

### 8.1 存储

```
InsightStore = {
  insights: InsightItem[],       // 带归因档案，上限 20 条
  topics: RecommendationTopic[], // 每轮重建，上限 10 条
  round: number,                 // 轮次计数
}
```

### 8.2 上限与淘汰

| 存储项 | 上限 | 淘汰策略 |
|--------|------|---------|
| insights | 20 | 过期淘汰 + 优先级淘汰（evidence + severity） |
| topics | 10 | FIFO + 去重 |
| 会话总数 | 100 | LRU 淘汰最旧不活跃 |

### 8.3 销毁

`session/disposed` 事件触发：
```typescript
hook.ts 监听器：
  index.dispose(sessionId)            // 清空 ChainGraph
  insightEngine.dispose(sessionId)    // 清空 InsightStore + FilterSelector + access tracker
```

销毁在同一个监听器内顺序调用，保证原子性。

---

## 九、配置

### 9.1 InsightConfig 接口

```typescript
export interface InsightConfig {
  similarityThreshold?: number      // Jaccard >= 此值视为重复（默认 0.15）
  maxStaleRounds?: number           // 连续未确认轮次上限（默认 3）
  maxInsights?: number              // 洞察项总数上限（默认 20）
  maxTopics?: number                // 话题总数上限（默认 10）
  historyWindow?: number            // 历史累积窗口（默认 40）
  maxSessions?: number              // 会话总数上限（默认 100）
  selectiveAnalysis?: boolean       // 选择性分析器（默认 false）
  auth?: {...}                      // API Key 鉴权
  rateLimit?: {...}                 // 限流配置
}
```

### 9.2 启用开关

```yaml
chains:
  enabled: true           # 链感知总开关（洞察引擎的前置依赖）
  injectProtocol: true    # 打标协议提示词段注入
  insight:
    enabled: true         # 洞察引擎开关（默认 false）
```

### 9.3 版本兼容性

洞察引擎是纯增量功能：
- 不修改 ChainGraph 的任何行为（只读）
- 不修改快照解析协议
- 不修改 prompt.ts 的图鉴内容
- `insight.enabled = false` 时，系统行为与 v0.2.0 完全一致

---

## 十、测试验证

### 10.1 归因验证（`scripts/verify-attribution.ts`）

9 个测试场景，23 个断言，全部通过：

| 场景 | 验证目标 |
|------|---------|
| T1 | 单节点证据 → attributionScore 高 |
| T2 | 多节点 + 多边证据 → attributionScore 更高 |
| T3 | confidence=0 → 触发 confidence-decay 反证 |
| T4 | 无支撑证据 → attributionScore = 0 + no-support 反证 |
| T5 | 空图 → no-support 反证 |
| T6 | diverged 双路径 → 边证据包含 diverged-from |
| T7 | converged 合流 → 边证据包含 converged-into |
| T8 | cross-chain-link → 边证据包含 cross-chain-link |
| T9 | 纯函数性（不修改输入） |

### 10.2 话题验证（`scripts/verify-topics.ts`）

6 个测试场景，13 个断言，全部通过：

| 场景 | 验证目标 |
|------|---------|
| T1 | 归因档案含具体 ChainNode 内容 |
| T2 | 归因评分传递合理（区分度） |
| T3 | 向后兼容（无 references 也生成档案） |
| T4 | 不同洞察类型产生不同归因档案 |
| T5 | 评分与节点证据丰富度正相关 |
| T6 | 反证（confidence=0）→ 低分 |

---

## 十一、设计哲学（按用户决策记录）

### 11.1 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 图谱数据结构 | **不引入** | ChainGraph 本身就是图谱 |
| 归因档案存储 | **不持久化** | 随返回值流转 |
| 洞察模板化 | **不预设** | 洞察千变万化，方法论稳定 |
| 话题模板化 | **不按 type 套死话术** | 话术从归因档案动态生成 |
| 工具双轨 | **合并为单一 get_insights** | 避免模型困惑 |
| 时间感 | **不加新机制** | ChainGraph 跨轮累积自然涌现 |
| 演化感 | **不加新机制** | 归因评分 + 话题重建自然涌现 |
| 懂我 | **自然涌现** | 不刻意构造，让归因真实 + 引用真实自然产生 |

### 11.2 设计边界

**洞察模块的"全部价值" = 在 ChainGraph 上做归因评估 + 让归因档案可见 + 让基于洞察的话题引用真实内容。**

没有第四件事。

---

## 十二、文件职责

| 文件 | 职责 |
|------|------|
| `src/chains/insight.ts` | 归因算法 + 6 个分析器 + 话题生成器 + 会话内存储 |
| `src/chains/types.ts` | 类型契约：ConfidenceProfile、NodeEvidence、EdgeEvidence、ContradictingEvidence |
| `src/chains/hook.ts` | 接入点：analyze + session/disposed 联动销毁 |
| `src/index.ts` | 生命周期管理：get_insights tool 注册 |
| `src/config.ts` | 配置：chains.insight.enabled |
| `scripts/verify-attribution.ts` | 归因验证（23 断言） |
| `scripts/verify-topics.ts` | 话题验证（13 断言） |
| `todo.md` | 路线图 + 决策记录 |

---

## 十三、未来演进方向（不纳入当前版本）

按 AGENTS.md §5"知识边界"——以下标记为长期方向：

- ❌ **跨会话模式推广**（需跨会话存储，违反"随会话生灭"约束）
- ❌ **洞察内容模板化**（违反"洞察本身千变万化"原则）
- ✅ **方法论可复用**（已实现，归因四步法稳定）
- ✅ **结构可识别**（ConfidenceProfile 结构稳定，便于分析）

---

**文档结束。任务完成 ✅**
