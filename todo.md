# DSH-Context-Pro 项目进展（TODO）

> 目标：DSH Agent 的「上下文整形器」——每轮推理前把上下文塑造成高密度注入块。
> 首版聚焦 SELECT / INJECT / MEASURE，纯 TS、无外部引擎。

## 阶段 1：项目骨架

- [x] 1.1 package.json / tsconfig（paths 指向 harness 源包，避免类型分裂）
- [x] 1.2 src/types.ts 契约（数据模型 + 流水线接口 + 注入工具）
- [x] 1.3 src/config.ts Config schema（schemastery）
- [x] 1.4 类型检查通过（含 dsh-agent Events 声明合并的副作用导入）

## 阶段 2：核心流水线

- [x] 2.1 select.ts：SELECT（相关×时效×来源加权打分，纯函数）
- [x] 2.2 inject.ts：REFACTOR（重组 + token 估算/截断）
- [x] 2.3 measure.ts：MEASURE（密度/相关/时效/可回溯）
- [x] 2.4 prestep.ts：agent/pre-step 拦截器（waterfall 注入）
- [x] 2.5 index.ts 装配（name/apply/inject）

## 阶段 3：验证

- [x] 3.1 tsc --noEmit 通过
- [x] 3.2 verify-e2e.ts：装配 + SELECT + REFACTOR + INJECT + MEASURE + pre-step 分发 全 PASS

## 阶段 4：收尾

- [x] 4.1 cordis.yml 装配示例
- [x] 4.2 README.md / todo.md
- [x] 4.3 pipeline 单元测试（16 用例全绿：空候选/权重/截断/中文相关性）
- [x] 4.4 MEMORY.md 项目记忆（12 坑 + 4 方法论 + 决策记录）
- [x] 4.5 装配进 DSH profile 实测（pre-step 真实注入；2026-08-17 验证通过）

## 阶段 5：链感知上下文（终局设计见 docs/chain-design-final.md）

> 终局共识：CoT 放权——从"指令驱动"降级为"上下文浸泡"（五维认知图鉴 + 情绪底色 + 末尾 JSON 快照）。
> 锚点语法已下线，解析器保留为遗留兼容。`chain-tags-design.md` 为旧设计，已归档仅供回溯。

- [x] 5.0 `src/chains/types.ts`：核心契约（ChainKind/ChainNode/ChainGraph/ChainIndex/ANCHOR_RE）
- [x] 5.1 `src/chains/parser.ts`：锚点正则解析（start/append/fork/revise/end + 文本段归属）
- [x] 5.2 `src/chains/graph.ts`：ChainGraph 实现（upsert 演化算法/activeOf/dispose/prune）
- [x] 5.3 `src/chains/extractor.ts`：锚点 → ChainNode（角色归位 + 演化操作执行）
- [x] 5.4 `src/chains/index.ts`：ChainIndex 实现（ingest/select/dispose）
- [x] 5.5 `src/chains/hook.ts`：session/event 监听 → ingest + session/disposed 清理
- [x] 5.6 SELECT 融合：nodeToCandidate + 链候选优先（prestep 接入 chainIndex）
- [x] 5.7 verify-chains.ts：24 用例全绿（深化/分叉/修正/生命周期/角色归位）
- [x] 5.8 `src/chains/prompt.ts`：图鉴提示词段（五链定义/情绪底色/末尾快照/认知豁免权/示例/纪律）
- [x] 5.9 index.ts 接入 injectProtocol（ctx.effect 托管 disposer）+ verify-protocol.ts（19 用例全绿）
- [x] 5.10 `docs/chain-guide.md`：链感知使用与架构指南（配置/五链/快照协议/最佳实践/边界）
- [x] 5.11 `src/skills.ts`：AGENTS.md + CLAUDE.md + Architectural-Thinking.md 注册为技能（`agent-principles` / `api-contract-guide` / `architectural-thinking`）
- [x] 5.12 装配进 DSH web profile：`cordis.patch.yml` 写入 chains.enabled=true + injectProtocol=true，HMR 热加载生效
- [ ] P2 装配进 DSH profile 实测（chains.enabled + injectProtocol 真实循环）

## 阶段 6：终局对齐（依据 `设计方案与规划.md` 终局共识 → `docs/chain-design-final.md`）

> 终局共识：CoT 放权——从指令驱动降级为上下文浸泡（五维认知图鉴 + 情绪底色 + 末尾 JSON 快照），
> 置信度/漂移/辩论等机制降维为"认知养料"而非机械规则。
> 2026-08-17：锚点语法下线，改为正文自然表达 + 末尾 JSON 快照为主提取通道。

- [x] 6.0 P0 打底：修 #18–#21 四 bug（候选打分回退/sourceRef 去重/stripAnchors+prune 接线/自注入阻断）
- [x] 6.0.1 verify-chains 增 P0 回归 6 用例（共 30 全绿）+ tsc 干净 + e2e PASS
- [x] 6.1 P1 图鉴化：prompt.ts 重写为五维图鉴式（情绪底色序言 + 五链人格/DNA/触发/口吻/边界反面例 + 融合法则 + 末尾快照 + 认知豁免权 + 示例 + 纪律）
- [x] 6.2 P1 验证：verify-protocol 重写断言（20 用例全绿：完整性 + 图鉴要素 + 解析一致性）
- [x] 6.3 P2 末尾 JSON 快照通道：snapshot.ts（parseSnapshot 容错丢弃/stripSnapshotLine/mergeSnapshotIntoGraph 锚点为主快照补漏）+ ingest 双通道接线 + prompt.ts 一行指令落地 + prestep 防御剥离（45+21 用例全绿）
- [x] 6.4 P3 数据模型：ChainNode +confidence/divergence/convergedFrom/supersededReason + ChainGraph.supersedeRoot + 快照三形态（字符串/分叉/合流）+ supersede 显式回溯 + 负向锚点 SELECT 通道（58+23 用例全绿）
- [x] 6.5 P4 脉络导览元数据层：guide.ts（buildGuide 进度/缺口/置信度/分叉合流扫描 + headline GPS 单行 + track 轨道图）+ ChainIndex.guide() + ChainGraph.endedRoots 暴露 + prestep MEASURE 可观测输出（67+23 用例全绿）
- [x] 6.6 **bug #23 修复（2026-08-17）**：pre-step 返回扁平 messages——`appendContextToMessages(messages, injected)` 直接返回整数组，消除嵌套（旧代码 `[...messages, appendContextToMessages([], injected)]` 把数组当单元素嵌套，agent-loop 不展平逐条 append → session 写入数组"消息" → LLM 请求畸形 → 模型无法应答）；e2e 断言去 flatDeep 假阳性；诊断脚本 `scripts/diag-nested-array.ts` + `diag-session-append.ts` 复现/回归；装配复原 `- insert:`
- [x] 6.7 **bug #24 修复（2026-08-17）**：`registerChainProtocol` 传 `content` 而非 `text` 导致 `section.text=undefined` → `systemPrompt.assemble()` 每轮 `interpolate()` 里 `text.indexOf('{{')` 崩溃；MEMORY.md 沉淀方法论 #11
- [x] 6.8 **锚点语法下线并删除（2026-08-17）**：prompt.ts 删除锚点语法段和 [因果@1] 示例，改为正文自然表达 + 末尾 JSON 快照为主提取通道；hook.ts 提取后自动剥离 JSON 行（用户不可见）；chain-guide.md 全面重写；parser.ts/extractor.ts 已删除；新增 `docs/chain-design-final.md` 终局设计文档

## 阶段 7：npm 发布部署

- [x] 7.1 `tsconfig.build.json`：构建配置（tsc 编译 src → lib）
- [x] 7.2 `package.json`：build 脚本 + peerDependencies + files 声明
- [x] 7.3 `cordis.yml`：更新为 npm 包名 `@kiwifruit/dsh-context-pro`
- [x] 7.4 `.gitignore`：排除 lib/ 构建输出
- [x] 7.5 `lib/` 构建验证通过（index.js + types 完整）
- [x] 7.6 `architectural-thinking` 技能注册
- [ ] 7.7 首次发布：`npm publish --access public`

## 可选对齐项（终局策略：抗氧化涂层，2026-08-17 定稿）

> 共识：核心认知引擎（五链图鉴 + 情绪底色 + CoT 放权）已定型，O.1–O.4 **绝对不碰核心架构**。
> 原则 = 轻量化包裹：能借力的借力，能透传的透传，绝不为对齐项重写底层逻辑。
> 上线初期**全部 Mock/关闭**，先跑通"图鉴+JSON 提取"，拿到第一波真实数据后按痛点定向对齐。

- [ ] O.1 Session 历史模式【哨兵】确保快照在模型"黄金视野区"
  - 极简方案：**显性快照锚定注入**——新一轮输入前，把上一轮末尾 JSON 快照以系统级消息重插本轮最前方
  - 禁忌：不做摘要树/滑动窗口重算（污染 CoT 连续性）
  - 效果：顶部（历史锚点）+ 底部（上一轮快照）双视野，省 Token 防遗忘
- [ ] O.2 可替换 Selector【备胎】旁路评分器，非主宰者
  - 极简方案：主路 = 现有图鉴 Prompt（保底宪法）；旁路只做置信度修正——>90% 且与主路冲突才发轻量纠偏 Hint
  - 禁忌：不做复杂路由网关；旁路挂了/延迟主路完全不受影响
- [ ] O.3 可观测仪表【裁判】只看用户的"脚"，不听模型的"嘴"
  - 首版已落地：prestep MEASURE 日志（GPS/缺口/轨道图，6.5 P4）
  - 仪表期方案：只画两条曲线——**脉络纠正率**（用户说"不对/不是这个意思/我是说…"频率↓=识别变准）+ **快照闭环轮次**（链锁定→最后 null 填满的轮次数↓=密度变高）
  - 禁忌：不监听 CoT 内部黑盒推理（贵且无意义）
- [ ] O.4 Compaction 协同【保镖】压缩时死保 JSON 快照
  - 极简方案：**结构化文件头保留**——压缩发生时硬拼接：`[当前锁定链完整 JSON 快照] + [LLM 极简闲聊摘要]`，并告知压缩模型"JSON 是骨架优先，摘要只是血肉氛围"
  - 禁忌：绝不让 Compaction 压缩 JSON 快照区域（金身不破）

## 决策记录

| 日期 | 决策 |
|------|------|
| 2026-08-16 | 纯 TS 引擎（贴近 DSH/HMR 友好/零依赖）；重活后续换 seam |
| 2026-08-16 | 首版 SELECT 用词重叠（Jaccard 变体），不引向量库 |
| 2026-08-16 | 注入走 agent/pre-step（原生事件通道），非工具调用 |
| 2026-08-16 | tsconfig paths 指向 harness 源包；副作用 import dsh-agent 触发 Events 合并 |
| 2026-08-17 | P0 修复 #18–#21：链候选统一打分 + SOURCE_TRUST chain:0.8；prune 重塑为按链裁剪；查询/候选分离阻断自注入 |
| 2026-08-17 | P1 图鉴化：协议从指令式升级为浸泡式（图鉴养料 + 锚点语法唯一硬契约）；末尾 JSON 快照指令**随 6.3 解析通道同批落地**（避免无通道时污染正文） |
| 2026-08-17 | P2 快照通道：双通道融合策略=锚点为主（演化决策者）、快照补漏（终态便签纸）；冲突不覆盖留 6.4 置信度观测；ended 链快照丢弃（忠实 end 语义） |
| 2026-08-17 | P3 数据模型：diverged 走 fork 节点对并行（不二选一）；supersede 缺 reason 整体丢弃（防误作废）；负向锚点 SELECT 打折 ×0.6（废链是对比论证配角）；confidence 内容无损 + 结构化副本 |
| 2026-08-17 | P4 脉络导览：三层记录法第一层落地（headline GPS + track 轨道图 + gaps 缺口）；废链/收束链不报缺口（无闭环义务）不选主链；O.3 首版落点 = prestep MEASURE 日志 |
| 2026-08-17 | **O.1–O.4 终局策略定稿"抗氧化涂层"**：不碰核心架构，轻量化包裹；上线初期全 Mock/关闭，先通后优；各对齐项角色=哨兵/备胎/裁判/保镖；实测出痛点再定向对齐（工程"先通后优"，认知"先简后深"） |
| 2026-08-17 | **bug #22 修复**：inject 服务名 `agent-loop`→`agents`（混淆 cordis.yml 条目 id 与 `super(ctx,'agentLoop')` 服务名致 fiber 永久 PENDING）；e2e 重做诚实断言（真实 AgentRegistry 供服务 + 注入块存在性校验），真实 boot `dsh web` 验证通过 |
