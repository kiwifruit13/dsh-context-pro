# 洞察引擎架构文档（终局版）

> **本文档定位**：洞察引擎的**架构视角终局设计**——定义模块边界、协作关系、生命周期与对外契约。
>
> 与本文档相关：
>
> - [`docs/insight-engine-design.md`](./insight-engine-design.md) —— **实现规格**：归因算法细节、话题生成模板、配置项、测试用例。本文档的"怎么做"对应它的"是什么"。
> - [`docs/chain-design-final.md`](./chain-design-final.md) —— **数据基础**：五链图鉴、链感知机制、ChainGraph 演化、末尾 JSON 快照。洞察引擎的输入源。
> - [`docs/CLAUDE.md`](./CLAUDE.md) —— **项目架构公约**：胶水轻薄、契约优先、三者边界（API/接口/胶水）。
>
> **核心关系（三层塔）**：
> ```
> 第 3 层：模型 CoT（内化五链图鉴，自由推理，末尾输出 JSON 快照）
>     ↓ 提取
> 第 2 层：ChainGraph（会话内链演化索引，零残留）
>     ↓ 观察
> 第 1 层：洞察引擎（超然层——只看、只建议、不干预 CoT）
> ```

---

## 一、定位与边界

### 1.1 一句话定位

> **洞察引擎是链感知系统之上的"超然层"——它在 ChainGraph（已有信息）上，通过稳定的归因方法论（节点证据 + 边证据 + 反证 + 综合评分），让每条洞察都自带可信度档案。洞察本身千变万化，但评估洞察的方法稳定可复用——这才是"有规可依"的真正含义。**

### 1.2 边界声明（做什么 / 不做什么）

| 在边界内（做） | 在边界外（不做） |
|---|---|
| 接收 ChainGraph + ChainGuide 全量状态 | 修改 ChainGraph、干预模型推理 |
| 运行 6 个分析器产出 InsightItem[] | 持久化任何跨会话数据 |
| 执行 `attributeInsightsPure()` 附加 ConfidenceProfile | 参与 CoT 推理过程 |
| 基于归因档案生成推荐话题 | 决定模型"怎么回答" |
| 暴露 `get_insights` tool / HTTP API / SSE | 替代 agent-memory 做长期记忆 |
| 管理会话级 InsightStore（随会话生灭） | 存储用户画像、偏好、长期偏好 |

### 1.3 与 ChainGraph 的关系（CLAUDE.md §4 三者边界）

```
ChainGraph（数据层：节点/边/快照/导览）
       │
       ├─► hook.ts（胶水层：session/event → ChainGraph 演化）
       │
       └─► InsightEngine（观察层：analyze() 读取图 → 产出洞察 + 话题）
```

- **ChainGraph** 是"是什么"——会话内链的演化真相
- **InsightEngine** 是"意味着什么"——在图之上做归因诊断
- 两者**解耦**：InsightEngine 通过 `analyze(sessionId, graph, guide, snapshot, changeContext)` 读取图，不持有图引用

---

## 二、超然层原则

### 2.1 核心公理

| 原则 | 含义 | 代码落地 |
|---|---|---|
| **只观察** | 只读 ChainGraph，不写入 | `analyze()` 接收 `graph: ChainGraph` 只读参数 |
| **只建议** | 产出 `InsightItem[]` + `RecommendationTopic[]`，模型可采纳可忽略 | `get_insights` tool 描述明确 "参考性质，非约束" |
| **不干预 CoT** | 归因档案是"档案"，不参与模型推理 | `confidenceProfile` 仅随返回值流转，**零新增存储**（不写入 ChainGraph、不写入 session） |
| **方法论稳定 / 内容多变** | 四步法结构固定，洞察内容由图实时生成 | `attributeInsightsPure()` 纯函数，输入图+洞察 → 输出带 profile 的洞察 |

### 2.2 为什么叫"超然层"？

```
模型 CoT（主角，负责想）
      ↓
ChainGraph（记录员，负责记）
      ↓
洞察引擎（旁观者，负责看）
```

- 模型是**认知主体**，在黑盒里完成推理
- ChainGraph 是**结构化记录**，忠实还原模型已确认的结论
- 洞察引擎是**元认知旁观者**——它不参与推理，只在推理结束后，站在全局视角做诊断

> 这对应 AGENTS.md §1「先思后行」的系统级体现：推理与诊断分离，诊断不污染推理。

---

## 三、六大分析器协作图

### 3.1 分析器全景

| # | 分析器 | 产出类型 | 核心判据 | 选择性触发条件 |
|---|---|---|---|---|
| ① | `analyzeCrossReaction` | `cross-reaction` | 四大经典反应对的 Jaccard 相似度 ≥ 0.15 | `chain-added / chain-removed / chain-type-changed / structure-changed` |
| ② | `analyzeMigration` | `migration` | 主链进度 ≥ 2/3 且末尾空 + 存在其他活跃链 | 同上 |
| ③ | `analyzeConfidenceTrend` | `confidence-trend` | 历史快照重建置信度序列，斜率 ≤ -0.15 | `confidence-shift / supersede-detected` |
| ④ | `analyzeGapAggregation` | `gap-aggregation` | 多链终结角色同时空缺 | `terminal-filled / terminal-emptied / structure-changed` |
| ⑤ | `analyzeDivergence` | `divergence-watch` | 同根同角色出现 ai/user 双路径且未合流 | `divergence-detected / structure-changed` |
| ⑥ | `analyzeSnapshotTrend` | 基于快照的趋势 | 当前快照节点置信度与历史对比 | `supersede-detected / confidence-shift / chain-type-changed` |

### 3.2 选择性触发机制（P1）

```typescript
// insight.ts:1493-1512
const shouldRun = (triggers: ChainChangeType[]): boolean => {
  if (runAll || isFirstRound) return true
  return triggers.some((t) => changes.has(t))
}
```

- **首轮全跑**：建立基线
- **后续按需**：`ChangeContext.changes` 只包含本轮真正发生的结构变更
- **可配置关闭**：`insight.selectiveAnalysis: false` → 每轮全跑（调试用）

### 3.3 协作流程

```
analyze(sessionId, graph, guide, snapshot, changeContext)
       │
       ▼
┌────────────────────────────────────────┐
│ 1. 计算 ChangeContext（hook.ts 对比上轮）   │
│    - terminal-filled/emptied             │
│    - divergence-detected                 │
│    - confidence-shift                    │
│    - structure-changed (节点数变化 > 2)   │
└────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────┐
│ 2. shouldRun() 筛选 → 仅跑被触发的分析器   │
│    6 个分析器互不依赖，纯函数并行可跑     │
└────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────┐
│ 3. allInsights = concat(各分析器产出)      │
│    attributeInsightsPure(allInsights)   │
│    → 每条洞察附加 ConfidenceProfile     │
└────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────┐
│ 4. appendInsights() 池管理              │
│    - 过期淘汰（3 轮未确认）              │
│    - 优先级淘汰（>20 条按 severity+evidence）│
│    - 同 scopeKey 合并/替换              │
└────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────┐
│ 5. store.insights = attributeInsightsPure()│
│    （全量重归因，保证 getInsights 返回最新） │
└────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────┐
│ 6. generateTopics(graph, guide, 本轮洞察) │
│    → 6 类话题，每条带 basedOn 归因档案   │
│    rebuildTopics() 替换 store.topics    │
│    emit('topics-changed') → SSE 推送     │
└────────────────────────────────────────┘
```

---

## 四、归因档案四步法（架构视角）

### 4.1 为什么是这四步？

| 步骤 | 问题 | 方法论地位 |
|---|---|---|
| ① 节点证据 | "支撑这个洞察的具体 ChainNode 是哪些？" | **基础**——没有节点就没有洞察 |
| ② 边证据 | "这些节点之间有什么结构化关系？" | **加强**——结构化关系（父子/修正/跨链/分叉/合流）提升可信度 |
| ③ 反证 | "有什么证据反驳这个洞察？" | **校准**——superseded/未合流分叉/confidence 为 0/完全无支撑 |
| ④ 综合评分 | "综合可信度 0-1 是多少？" | **决策**——base + edgeBoost - contradictionPenalty |

### 4.2 评分公式（极简可解释）

```
base = Σ(node.weight × node.confidence) / Σ(node.weight)
       其中 weight: primary=1.0, supporting=0.5, contradicting=0.1
       confidence 缺失按 0.5 处理；contradicting 不参与正向加分

edgeBoost = min(edgeEvidences.length × 0.1, 0.3)

contradictionPenalty = Σ(contradiction.strength) × 0.2

attributionScore = clamp(base + edgeBoost - contradictionPenalty, 0, 1)
```

**设计意图**：
- 可解释：`rationale` 字段直接输出 "节点证据 N 条（base=0.72）；边证据 3 条（+0.15）；反证 1 条（-0.16）；综合可信度 0.71"
- 可调：权重常量集中在 `NODE_WEIGHT`，无魔数散落
- 可测：`verify-attribution.ts` 23 个断言直接验证契约

### 4.3 零新增存储

```
归因档案生命周期：
  attributeInsightsPure() 创建
       │
       ▼
  随 InsightItem 存入 InsightStore.insights[]
       │
       ▼
  getInsights() / getAttributedInsights() 返回
       │
       ▼
  会话结束 → dispose() → 全部销毁
```

- **不写入 ChainGraph**
- **不写入 session**
- **不持久化到磁盘**
- 这保证了"超然层"的纯粹性：归因是**即时计算的视图**，不是持久化的状态

---

## 五、话题生成范式

### 5.1 核心范式转变（v0.3.5 以前 vs 以后）

| 维度 | v0.2.0（旧） | v0.3+（新） |
|---|---|---|
| **生成依据** | 洞察 type 套固定模板 | **归因档案**动态生成 |
| **话术来源** | 预写死的字符串模板 | **引用真实 ChainNode 内容** |
| **用户感知** | "AI 在推荐话题" | "AI 真的懂我们在聊什么" |

### 5.2 generateTopics() 契约

```typescript
function generateTopics(
  graph: ChainGraph,
  guide: ChainGuide,
  insights: InsightItem[],  // 本轮刚归因的洞察
): RecommendationTopic[]
```

**输入仅三样**：全局图、导览、本轮洞察（已带 ConfidenceProfile）。**无额外状态**。

### 5.3 六类话题 × 触发条件 × 话术来源

| kind | 触发洞察 | 话术关键引用 |
|---|---|---|
| `extension` | cross-reaction | `keyContents[0]` + `keyContents[1]` + 是否有 `cross-chain-link` |
| `extension` | confidence-trend (warn+) | 置信度下降的具体内容 + `attributionScore` |
| `extension` | divergence-watch (warn) | 分歧双路径的具体内容（`keyContents[0]` vs `keyContents[1]`） |
| `extension` | gap-aggregation | `firstFilledContent` + 主链缺口角色标签 |
| `convergence` | 主链完整且置信度 ≥ 0.6 | 终结角色内容 + 置信度百分比 |
| `convergence` | 链已收束 + 存在其他活跃链 | 已收束链起始内容 + 活跃链起始内容 |

### 5.4 RecommendationTopic.basedOn 档案

```typescript
basedOn: {
  insightTitle: string,           // 依据的洞察标题
  attributionScore: number,       // 归因评分
  keyNodeContents: string[],      // 让话术能引用真实节点内容
  keyEdgeKinds: AttributionEdgeKind[]  // 让话术能引用结构化关系
}
```

> 这实现了 AGENTS.md §1「简单第一」——不搞复杂的模板引擎，直接把归因档案里最关键的内容拼进自然语言话术。

---

## 六、生命周期与内存保护

### 6.1 会话级生命周期

```
新会话首轮 assistant/message
       │
       ▼
hook.ts: ingestEvent() → FilterSelector 累积历史
       │
       ▼
hook.ts: 链提取 + analyze() → InsightEngine 创建 store
       │
       ▼
后续每轮 → analyze() 更新 store.insights + store.topics
       │
       ▼
session/disposed → index.dispose() + insightEngine.dispose()
       │
       ▼
store / filterSelector.history / clientActive 全部删除
```

**关键点**：洞察引擎**完全随会话生灭**，无跨会话残留。这是"零残留"架构承诺。

### 6.2 三层内存保护（8.7 规格）

| 层级 | 保护对象 | 机制 | 默认阈值 |
|---|---|---|---|
| L1 | FilterSelector 历史 | FIFO 窗口淘汰 | `historyWindow = 40`（最近 20 轮） |
| L2 | InsightStore.insights | 过期淘汰 + 优先级淘汰 | `maxStaleRounds = 3` / `maxInsights = 20` |
| L3 | InsightEngine.stores | LRU 淘汰最旧不活跃会话 | `maxSessions = 100` |

```typescript
// insight.ts:1463-1485 evictIfNeeded()
if (stores.size > MAX_SESSIONS) {
  // 找最旧的非活跃会话（无 clientActive、无近期 round）
  // 删除 store + filterSelector.history + clientActive 标记
}
```

---

## 七、对外暴露面（三条通道）

### 7.1 通道对比

| 通道 | 适用场景 | 延迟 | 持久化 |
|---|---|---|---|
| **get_insights tool** | 模型主动调取、深度分析时 | 同步（模型等待） | 否（会话内存） |
| **HTTP API** (`/topics`, `/topics/stream`, `/topics/batch`, `/mark-active`) | Client UI 渲染、外部集成 | 异步（REST/SSE） | 否（会话内存） |
| **话题便条** (`agent.inject`) | 无 Client UI 场景、回退兜底 | 同步（注入 user 消息） | 否（会话内存） |

### 7.2 HTTP 端点清单

| 端点 | 方法 | 用途 | 关键参数 |
|---|---|---|---|
| `/api/context-pro/topics` | GET | 单会话话题 | `?sessionId=xxx` |
| `/api/context-pro/topics/stream` | GET | SSE 实时推送 | `?sessionId=xxx` |
| `/api/context-pro/topics/batch` | POST | 批量查询（≤50） | `{ sessionIds: string[] }` |
| `/api/context-pro/mark-active` | POST | 标记 Client 激活 | `{ sessionId }` |
| `/api/context-pro/stats` | GET | 可观测性指标 | 无 |
| `/api/context-pro/openapi.json` | GET | OpenAPI 3.1 规范 | 无 |

### 7.3 鉴权与限流（可选）

```yaml
chains:
  insight:
    auth:
      enabled: false
      keys: []              # 明文 key（仅开发用）
      keyHashes: []         # 生产用 SHA-256
      headerName: x-api-key
      queryParam: api_key
    rateLimit:
      maxRequests: 100
      windowMs: 60000
```

---

## 八、验证矩阵

| 脚本 | 验证目标 | 断言数 | 关键覆盖 |
|---|---|---|---|
| `verify-chains.ts` | 链感知全链路 | 67 | 生命周期 / 快照通道 / 数据模型 / 导览 |
| `verify-attribution.ts` | **归因四步法契约** | **23** | 节点证据/边证据/反证/评分/rationale |
| `verify-topics.ts` | **话题生成范式** | **13** | 6 类话题 / basedOn 档案 / 引用真实内容 |
| `verify-protocol.ts` | 图鉴内容完整性 | 19 | 五链/融合法则/纪律/快照协议 |
| `verify-bugfixes.ts` | 回归修复 | 动态 | 历史已知 bug 回归防线 |
| `verify-e2e.ts` | 端到端装配 | 1 | 插件加载 → tool 注册 → HTTP 路由 |

**运行方式**：
```bash
# 在 harness 根目录
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-chains.ts
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-attribution.ts
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-topics.ts
```

---

## 九、架构决策记录

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-08-17 | 洞察引擎作为独立模块（insight.ts） | 单一职责：ChainGraph 负责演化，InsightEngine 负责诊断 |
| 2026-08-17 | FilterSelector 作为独立工厂 | 可被 InsightEngine 之外的测试单独 mock（P0 可配置化） |
| 2026-08-17 | 归因档案零新增存储 | 超然层纯粹性——归因是视图不是状态 |
| 2026-08-19 | 选择性分析器（ChangeContext） | 避免每轮全量跑 6 个分析器，按结构变更按需触发 |
| 2026-08-20 | 话题基于归因档案生成 | 解决 v0.2.0 "套模板" 问题，让用户感受到"AI 真的懂我" |
| 2026-08-20 | SSE 事件总线替代轮询 | `on('topics-changed')` 仅变更时推送，降低 Client 开销 |
| 2026-08-21 | LRU 会话淘汰（maxSessions=100） | 防止长时间运行内存泄漏 |
| 2026-08-21 | `getLatestTopics()` 返回 `{evicted: boolean}` | 消除"空话题=无话题/空话题=已淘汰"歧义 |

---

## 十、延伸阅读

| 文档 | 读它能获得什么 |
|---|---|
| `insight-engine-design.md` | 归因算法完整实现、话题生成模板细节、配置项全表、测试用例 |
| `chain-design-final.md` | 五链图鉴、JSON 快照协议、ChainGraph 演化算法、链协议模式 |
| `Architectural-Thinking.md` | 五维认知结构本体论（技能 `architectural-thinking`） |
| `Integrated-Catalysis.md` | 链间化学反应四大催化方程（技能 `integrated-catalysis`） |

---

> **文档版本**：v0.4.0 对齐
> **最后更新**：2026-08-21
> **维护原则**：架构变更（模块边界/协作流程/对外契约）同步更新本文档；实现细节变更仅更新 `insight-engine-design.md`。