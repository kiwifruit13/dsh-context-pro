# 链感知上下文：5 链标签方案设计（DSH-Context-Pro 核心扩展）

> 借鉴 agent-memory dual_track 的 5 链思想（因果/逻辑/操作/叙事/时间），
> 但用**新方法实现**：不靠事后 NLP 分析，而是在对话生成时由**模型打锚点标签**，
> 提取为**内容式链结构**，存入**会话内临时存储**，生命周期跟随对话。
>
> 设计决策确认（2026-08-16）：
> - 锚点式打标（不污染原文）
> - 内容式提取（转结构化链表述）
> - 模型唯一打标（用户对话由模型事后补标）
> - 临时存储（非长期记忆）
> - 生命周期跟会话（删对话即删链）

---

## 1. 五条链（复用 dual_track 思想，不改定义）——全部支持多级深化

| 链 | 结构（表层）| 打标触发 | 多级深化示例 |
|---|---|---|---|
| **因果链** | 问题 → 原因 → 解决方案 | "为什么/因为/导致" | 原因之下还有更关键的中间原因（`@1.1` 深化）|
| **逻辑链** | 前提 → 推理 → 结论 | "假设/因此/所以" | 推理之下有子推理/隐含前提（`@2.1`）|
| **操作链** | 动作 → 步骤 → 结果 | "怎么做/步骤/执行" | 步骤之下有子步骤/失败重试分支（`@3.1`）|
| **叙事链** | 开端 → 发展 → 转折 → 结局 | "开始/后来/但是/最后" | 发展之下有子情节/转折的转折（`@4.1`）|
| **时间链** | 过去 → 现在 → 未来 | "之前/现在/之后/计划" | 现在之下有阶段细分/未来有多条推演（`@5.1`）|

> **共性**：5 种链都是**多级深化的递归结构**，不是三层模板。表层结构只是"第一层"
> 的默认形态；任何一层之下都可继续深化、分叉、修正。

## 2. 锚点式标签（原文不污染）

模型在回复输出中就地插入锚点，格式统一：

```
[因果@seq]        [逻辑@seq]        [操作@seq]
[叙事@seq]        [时间@seq]        [/链@seq]（可选的链结束锚）
```

- `@seq` = 对话内单调递增序号（模型/DSH 侧分配），保证锚点唯一、可排序
- 锚点不包裹内容（锚点式），只标记"链在此触及"
- 示例：
  ```
  用户：为什么刚才的上下文注入没生效？
  模型：[因果@1] 因为 pre-step 的 next() 委托后返回类型被拓宽了，
        所以注入消息被类型断言忽略。[逻辑@2] 推论：需要显式展平。
  ```

## 3. 内容式提取（锚点 → 动态链节点图）

DSH-Context-Pro 监听 `session/event`（`assistant/message`），解析锚点，
把锚点附近的内容转成**链节点**。核心修正：**链不是静态模板，而是随对话演化的
动态图**——中间因果会在发展中浮现，链必须支持多级深化、分叉、修正、交织。

### 3.1 链节点（ChainNode）：图的最小单元

```ts
interface ChainNode {
  /** 节点 id：`链类型@链号.序号`（如 causal@1.2），支持多级 */
  id: string
  kind: 'causal' | 'logic' | 'operation' | 'narrative' | 'temporal'
  /** 节点在链中的角色（按链类型） */
  role:
    | 'problem' | 'cause' | 'solution'        // causal
    | 'premise' | 'reasoning' | 'conclusion'   // logic
    | 'action' | 'step' | 'result'             // operation
    | 'beginning' | 'development' | 'twist' | 'ending'  // narrative
    | 'past' | 'present' | 'future'            // temporal
  content: string
  /** 父节点（多级深化用） */
  parent?: string
  /** 子节点（分叉用：一因多果、一问题多因） */
  children: string[]
  /** 修正的旧节点（演化用：旧节点标 superseded） */
  revisionOf?: string
  /** 演化状态 */
  status: 'active' | 'superseded'
  timestamp: number
  sourceRefs: string[]
}
```

### 3.2 锚点语法（支持演化操作，5 链通用）

```
基础锚：[因果@1]            → 新建 causal 链的节点 1
追加锚：[因果@1.1]          → 节点 1 的子节点（多级深化）
分叉锚：[因果@1.2]          → 节点 1 的另一子节点（多因/多果/多分支）
修正锚：[因果@1^]           → 修正节点 1（旧节点标 superseded）
结束锚：[/因果@1]           → causal 链 1 结构完成
```

**5 链通用**：`[逻辑@2.1]`（子推理）、`[操作@3.1]`（子步骤）、`[叙事@4.1]`（子情节）、
`[时间@5.1]`（阶段细分）——锚点语法对所有链类型一致。

### 3.2.1 动态演化由打标驱动（核心机制，非提取器推断）

> **演化指令来自智能体打标签的动作本身**——模型生成回复时，若发现某链需要
> 深化/分叉/修正，直接通过锚点语法声明；提取器只忠实执行，不做演化推断。

```
模型生成时自我判断：
  "我还在同一层展开"  → 继续普通内容（同节点补全）
  "这原因更深一层"    → [链@1.1]（追加：多级深化）
  "还有另一条路径"    → [链@1.2]（分叉）
  "刚才那个结论不成立" → [链@1^]（修正：supersede）
  "这个链到此完整"    → [/链@1]（收束）
```

- **模型是演化决策者**：它生成时最清楚链的状态（刚完成推理/发现漏洞/需要展开）
- **提取器是忠实执行者**：解析锚点 → 按语法 upsert 节点，不猜测演化意图
- **演化零成本**：模型打标时顺带声明，无需额外分析环节

### 3.2.2 演化示例（因果链，发展中浮现中间因果）

```
用户：为什么注入没生效？
模型：[因果@1] 问题：上下文注入没生效
     [因果@1.1] 原因：next() 委托后返回类型被拓宽
用户：但 dsh-memory 也这样调，为什么那时没事？
模型：[因果@1.2] 原因：dsh-memory 未监听 pre-step，无类型冲突
     [因果@1^] 修正：真正原因是 scope 包装拓宽了 next 返回类型
     [操作@2] 解决：显式展平 + as 断言
     [/因果@1] [/操作@2]
```

演化结果：causal@1 含 problem + 两原因分叉（1.1 被 superseded，1.2 active）+ 修正链接到 operation@2（交织）。

### 3.3 链图（ChainGraph）：会话内演化结构

```ts
class ChainGraph {
  nodes: Map<string, ChainNode>          // 全部节点（含 superseded）
  activeRoots: Map<string, ChainNode[]>  // 每链类型的活跃根
  /** 追加/深化/分叉/修正——统一入口 */
  upsert(node: ChainNode): void
  /** 取某链类型的活跃结构（回溯用） */
  activeOf(kind: ChainKind): ChainNode[]
  /** 生命周期：会话结束/删除 → 清空 */
  dispose(): void
}
```

关键语义：
- **superseded 节点保留但降权**（可回溯"我们曾经以为…后来发现…"——这本身就是高价值上下文）
- **分叉保持多因/多果**（真实问题很少单因）
- **跨链引用**（因果链节点指向操作链）——链交织

### 3.4 提取策略（模型驱动演化，提取器忠实执行）

- **演化指令来自打标**：深化/分叉/修正由模型打锚点时声明（3.2.1），提取器只按语法 upsert
- **修正不删除**：`revisionOf` 链式保留演化史（"我们曾以为…后来发现…"可回溯）
- **角色归位**：锚点后内容的语义角色（problem/cause 等）由模型生成时声明或 extractor 按结构归位——演化（层级/分支/修正）由模型声明，角色可由 extractor 辅助

## 4. 临时存储（会话内，非长期）

```ts
class ChainIndex {
  /** sessionId → ChainGraph（会话内临时链图） */
  private store = new Map<string, ChainGraph>()

  add(sessionId: string, node: ChainNode): void
  /** 按相关度选链（SELECT 数据源，优先活跃节点） */
  select(query: string, topK: number): ChainNode[]
  /** 生命周期：会话结束/删除 → 清空该会话整个链图 */
  dispose(sessionId: string): void
}
```

- **不进 agent-memory**（那是长期记忆，有遗忘机制）
- **不落盘**（或仅会话内内存）——删对话即失效，无残留
- 生命周期绑定：`session/disposed` 事件 → `ChainIndex.dispose(sessionId)`

## 5. 生命周期跟会话（核心决策）

```
用户删除对话 X
      │
      ▼
session/disposed 触发
      │
      ▼
ChainIndex.dispose(X) → 该会话所有链片段删除
      │
      ▼
不保留：临时存储无残留，重启后不恢复
```

- 与 agent-memory 对比：agent-memory 删对话仍可能留长期记忆（有独立生命周期）；本方案**链完全跟随会话**，删即删。

## 6. 两大用途（本项目接入点）

### 用途 A：模型快速回溯前文
```
用户：刚才我们怎么解决注入问题的？
模型（推理）：需要找回因果链 → SELECT 从 ChainIndex 选 causal 片段 → INJECT 注入
```
- 链片段是**结构化摘要**，比整段原文更适合回溯
- 模型可引用 `[因果@1]` 定位原文

### 用途 B：上下文压缩时保留链结构
```
压缩前：原始对话（长）
压缩中：ChainIndex 提供结构化链 → 压缩器保留链结构（语义骨架）
压缩后：对话被压缩，但链结构仍可回溯（高密度）
```
- 链 = 压缩时的**语义锚**：即使文本被压缩，链结构（问题/原因/解决方案）仍在

## 7. 与 DSH-Context-Pro 的集成

```
现有流水线：PERCEIVE → SELECT → REFACTOR → INJECT → MEASURE
                            │
新增 ChainIndex ──► SELECT 优先选链节点（高语义价值，active 优先、superseded 降权）
                    ▲
                    │
session/event（assistant/message）→ 解析锚点 → 提取/修正节点 → ChainGraph
```

- **标签解析器**（新模块 `src/chains/parser.ts`）：从消息文本提取 `[链@seq]` / `[链@seq.x]` / `[链@seq^]` 锚点
- **链提取器**（新模块 `src/chains/extractor.ts`）：锚点 → ChainNode（5 链结构 + 演化操作）
- **ChainGraph**（新模块 `src/chains/graph.ts`）：会话内演化链图（upsert/activeOf/dispose）
- **ChainIndex**（新模块 `src/chains/index.ts`）：sessionId → ChainGraph + 生命周期
- SELECT 升级：候选优先来自 ChainIndex（高价值），再回退文本候选

## 8. 风险与边界

| 风险 | 缓解 |
|---|---|
| 模型不打标或打错标 | 标签是**软信号**：解析不到就回退原文候选；错标通过"来源可信度"降权 |
| 锚点污染输出 | 锚点式不包裹内容；生产可配置 `stripAnchors: true` 在 INJECT 前剥离 |
| 提取结构不完整（缺 cause/solution）| 节点 role 可空、children 可空；MEASURE 的密度指标会反映 |
| 模型思考不可得 | 只依赖模型**回复**打标（生成时自知），不依赖 thinking 暴露 |
| 演化失控（链无限膨胀）| ChainGraph 设节点上限（如每链 20 节点），超限按活跃度/相关度裁剪；superseded 节点可被裁剪 |
| 分叉导致回溯歧义 | active 优先 + sourceRefs 定位原文；修正链（revisionOf）保留演化史 |

## 9. 落地计划

- [ ] P1 `src/chains/parser.ts`：锚点正则（基础/追加/分叉/修正/结束）
- [ ] P1 `src/chains/graph.ts`：ChainNode + ChainGraph（upsert/activeOf/dispose）
- [ ] P1 `src/chains/extractor.ts`：锚点 → ChainNode（5 链角色 + 演化操作）
- [ ] P1 `src/chains/index.ts`：ChainIndex + session/disposed 生命周期
- [ ] P1 `src/chains/hook.ts`：session/event 监听 → 解析提取入库
- [ ] P2 SELECT 升级：链节点候选优先（active 优先、superseded 降权）
- [ ] P2 压缩保留：链结构进压缩器（语义骨架）
- [ ] P2 锚点剥离配置（stripAnchors）+ 节点上限裁剪

---

# 附录 A：完整架构与实现前提（深入构思 2026-08-16）

## A.1 完整数据流（端到端）

```
                     ┌──────────────────────────────────────────────┐
                     │              DSH Agent 循环                    │
                     │                                              │
用户 ──► agent/pre-step ──► 模型生成 ──► assistant/message           │
   ▲        │                        │                              │
   │        ▼                        ▼                              │
   │   DSH-Context-Pro          session/event（post-commit）         │
   │   （INJECT 注入链）          │                                  │
   │        │                    ▼                                  │
   │        │              ┌─ chains/hook.ts ─┐                     │
   │        │              │ 解析锚点          │                     │
   │        │              │ 提取节点          │                     │
   │        │              └────────┬─────────┘                     │
   │        │                       ▼                              │
   │        │              chains/index.ts（ChainIndex）            │
   │        │                       │ 会话内临时                     │
   │        │                       ▼                              │
   │        │              chains/graph.ts（ChainGraph）            │
   │        │              · 多级深化/分叉/修正                      │
   │        │              · active/superseded                     │
   │        │                       │                              │
   │        │                       ▼                              │
   │        └── SELECT（链节点优先）▲                                │
   │                    │ 回退文本候选                               │
   │                    ▼                                          │
   │              REFACTOR → INJECT → MEASURE                      │
   └──────────────────────────────────────────────────────────────┘
              session/disposed → ChainIndex.dispose（删对话即删链）
```

## A.2 模型打标协议（系统提示词注入）

模型需要知道"何时打什么标签"。通过 `ctx.systemPrompt.section()` 注入打标协议：

```ts
// src/chains/prompt.ts（P2：打标协议提示词段）
ctx.effect(() => ctx.systemPrompt.section({
  name: 'dsh-context-pro-chain-protocol',
  order: 30,
  content: [
    '当你的回复涉及以下推理结构时，就地插入锚点标签（不包裹内容）：',
    '  [因果@n]     问题→原因→解决方案（"为什么/因为/导致"）',
    '  [逻辑@n]     前提→推理→结论（"假设/因此/所以"）',
    '  [操作@n]     动作→步骤→结果（"怎么做/步骤/执行"）',
    '  [叙事@n]     开端→发展→转折→结局（"开始/后来/但是"）',
    '  [时间@n]     过去→现在→未来（"之前/现在/之后"）',
    '演化指令（链随对话动态生长）：',
    '  [链@n.m]     追加子节点（深化：原因之下有原因）',
    '  [链@n.2]     分叉（另一条路径/多因多果）',
    '  [链@n^]      修正（旧结论不成立，supersede）',
    '  [/链@n]      链结构完成',
    '用户对话中触及的链，由你在回复时补标（模型唯一打标）。',
  ].join('\n'),
}))
```

- **模型唯一打标**：用户不会打标，模型在回复时对"自己输出"和"用户对话中触及的链"都补标
- **锚点是软信号**：模型漏标/错标 → 解析不到就回退原文候选，错标降权

## A.3 锚点解析规则（parser 契约）

```ts
// 输入：assistant/message 的文本块
// 输出：ChainAnchor[]（保序） + 锚点间的文本段（供 extractor 归位）

parse('[因果@1] 问题X [因果@1.1] 原因Y [/因果@1]')
// → [
//     { op:'start',  kind:'causal', root:1, path:[1],     index:0 },
//     { op:'append', kind:'causal', root:1, path:[1,1],   index:… },
//     { op:'end',    kind:'causal', root:1, path:[1],     index:… },
//   ]
// 文本段：[0..start)=''  [start..append)='问题X'  [append..end)='原因Y'  [end..)=''
```

- 正则：`ANCHOR_RE`（见 src/chains/types.ts）
- **锚点间文本段** = 前一个锚点到当前锚点之间的内容，归属当前锚点的 `content`
- 锚点不包裹内容（锚点式）——文本段是锚点间的自然流

## A.4 演化算法（ChainGraph.upsert 语义）

| 操作 | 锚点 | upsert 行为 |
|---|---|---|
| **start** | `[因果@1]` | 新建根节点 `causal@1`（role 按首个角色或由 extractor 推断）|
| **append** | `[因果@1.1]` | 新建 `causal@1.1`，parent=`causal@1`，加入其 children；role 深化（cause→cause）|
| **fork** | `[因果@1.2]` | 新建 `causal@1.2`，parent=`causal@1`，加入 children（多因/多果）|
| **revise** | `[因果@1^]` | 新建 `causal@1'`（revisionOf=`causal@1`）；旧节点 status→superseded |
| **end** | `[/因果@1]` | 标记链 1 结构完成（节点可继续被后续锚点引用？——不，end 后不可再改）|

**superseded 语义**：
- 保留在 nodes（可回溯"曾以为…后来发现…"）
- `activeNodes()` 排除（SELECT 不选，除非显式回溯请求）
- 节点上限裁剪时**优先剪 superseded**（prune 策略）

**跨链交织**：节点 `links` 字段（如 `causal@1.2` links → `operation@2`）——因果的解决方案指向操作链。

## A.5 SELECT 融合（链节点 → 上下文候选）

链节点转成 `ContextCandidate`（复用现有 select 的打分）：

```ts
function nodeToCandidate(node: ChainNode): ContextCandidate {
  return {
    id: node.id,
    content: `${roleLabel(node.role)}：${node.content}`,
    source: `chain:${node.id}`,
    timestamp: node.timestamp,
    relevanceScore: 0,   // 由 select 按查询计算
  }
}
```

- **链候选优先**：SELECT 先取 `ChainIndex.select()` 的活跃节点 → 与文本候选合并 → 统一打分
- **链节点天然高价值**：结构化、有角色、有引用——密度与可回溯性优于裸文本
- **superseded 降权**：只在显式回溯（"我们之前怎么想的"）时纳入

## A.6 压缩保留（语义骨架）

```
压缩器收到：原始对话 + ChainIndex 活跃链图
压缩器输出：压缩文本 + 链骨架（每链的活跃节点浓缩）
```

- 链 = 压缩时的**语义锚**：即使对话文本被压缩，链结构（问题/原因/解决方案 等）作为
  "骨架"保留，模型可引用 `[因果@1]` 展开详情
- 与 DSH compaction 的关系：**事前整形（注入高密度）+ 压缩保留（骨架）** 双通道

## A.7 配置扩展

```ts
// config.ts 新增（P2）
export interface Config {
  // ...现有
  /** 链感知开关 */
  chains?: {
    enabled: boolean          // 默认 false（首版关闭，逐步启用）
    stripAnchors: boolean     // INJECT 前剥离锚点（默认 true）
    maxNodesPerChain: number  // 每链节点上限（默认 20）
    injectProtocol: boolean   // 注入打标协议提示词段（默认 false）
  }
}
```

## A.8 验证方案（P1 验收）

```ts
// scripts/verify-chains.ts
// 输入：模拟带锚点的多轮对话（含深化/分叉/修正）
// 断言：
//  1. parse 正确解析 5 类锚点（start/append/fork/revise/end）
//  2. extract 生成 ChainNode 树（层级/父/子正确）
//  3. revise 后旧节点 superseded、新节点 active
//  4. ChainIndex.dispose 清空该会话
//  5. SELECT 优先返回活跃链节点
```
