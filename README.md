# DSH-Context-Pro

**DSH Agent 的链感知系统**——让模型内化五维认知结构（因果/逻辑/操作/叙事/时间），在回复末尾通过一行 JSON 快照隐式标记，系统在后台提取并维护会话内链图，用户全程无感。

> 定位：不是记忆引擎，不是注入器，是**认知结构层**。
> 核心哲学：**CoT 放权**——系统只做两件事：注入图鉴到 System Prompt + 解析 JSON 快照。

## 核心机制

### 链协议模式（主模式）

```
System Prompt（已含五链图鉴 + 情绪底色 + 末尾 JSON 快照指令）
    │
    ▼
模型 CoT 自由推理 → 生成自然语言正文 + 末尾 JSON 快照行
    │
    ▼
session/event → hook.ts 解析快照 + 更新 ChainGraph + 剥离 JSON 行
    │
    ▼
用户看到纯自然语言回复
```

五链图鉴通过 `ctx.systemPrompt.section()` 注入 System Prompt，模型内化后自然运用。末尾 JSON 快照由 hook 自动剥离，**用户不可见**。

### 非链模式

当 `chains.enabled=false` 时，插件退化为简单的上下文整形器，通过 `agent/pre-step` 拦截消息流做 SELECT/INJECT/MEASURE。

## 五维认知图鉴

| 链 | 本质 | 触发 |
|---|---|---|
| 因果链《溯源者》 | 对抗混乱，寻找"第一因" | 异常/困境 + "为什么/怎么办" |
| 逻辑链《架构师》 | 对抗片面，追求"绝对理性" | 权衡/假设/"如果…那么…" |
| 操作链《手艺人》 | 对抗空谈，追求"落地执行" | 动作动词/"先…再…"/无从下手 |
| 叙事链《说书人》 | 对抗碎片，构建"意义之弧" | 具体年月/状态反转/回顾唏嘘 |
| 时间链《预言家》 | 对抗短视，建立"动态视野" | "以前/现在/以后"三段对比 |

图鉴细节见 `docs/Architectural-Thinking.md`（已注册为技能 `architectural-thinking`，模型可发现）。

### 链间化学反应

五链可相互催化：因果×时间 → 深层归因动力学，逻辑×操作 → 抗脆弱执行手册，叙事×因果 → 沉浸式深度诊断，时间×叙事 → 变革蓝图。详见 `docs/Integrated-Catalysis.md`（已注册为技能 `integrated-catalysis`）。

## 安装与装配

### 方式 A：DSH 社区标准安装（推荐）

```bash
# 一键安装并自动应用 patch
dsh plugin add @kiwifruit/dsh-context-pro
```

### 方式 B：npm 包手动装配

```bash
npm install @kiwifruit/dsh-context-pro
```

在 `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: context-pro
      name: '@kiwifruit/dsh-context-pro'
      config:
        chains:
          enabled: true
          injectProtocol: true
          maxNodesPerChain: 20
          insight:
            enabled: true
```

### 方式 C：源码路径（开发用）

```yaml
- insert:
    - id: context-pro
      name: 'file:///E:/Deepseek/DSH-Context-Pro/src/index.ts'
      config:
        chains:
          enabled: true
          injectProtocol: true
          maxNodesPerChain: 20
          insight:
            enabled: true
```

> **Windows 路径须用三斜杠**：`file:///E:/...`（裸路径报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）

## 配置完整参考

| 字段 | 默认值 | 说明 |
|---|---|---|
| `chains.enabled` | `false` | 开启链感知（五链图鉴 + JSON 快照提取） |
| `chains.injectProtocol` | `false` | 注入五链图鉴到 System Prompt |
| `chains.maxNodesPerChain` | `20` | 每链节点上限（防演化失控） |
| `chains.insight.enabled` | `true` | 启用洞察引擎（依赖 `chains.enabled`） |
| `chains.insight.similarityThreshold` | `0.15` | Jaccard 相似度阈值，去重话题 |
| `chains.insight.maxStaleRounds` | `3` | 连续未确认轮次上限，过期淘汰 |
| `chains.insight.maxInsights` | `20` | 洞察项总数上限 |
| `chains.insight.maxTopics` | `10` | 话题总数上限 |
| `chains.insight.historyWindow` | `40` | 历史累积窗口（最近 N 轮 = 2N 条消息） |
| `chains.insight.maxSessions` | `100` | 会话总数上限 |
| `chains.insight.selectiveAnalysis` | `false` | 启用选择性分析器（P1） |
| `chains.insight.auth.enabled` | `false` | API Key 鉴权 |
| `chains.insight.rateLimit.maxRequests` | `100` | 限流：窗口内最大请求数 |
| `chains.insight.rateLimit.windowMs` | `60000` | 限流：窗口毫秒数 |

## 核心能力

| 能力 | 说明 | 接入方式 |
|---|---|---|
| **五链图鉴注入** | 因果/逻辑/操作/叙事/时间 + 情绪底色 + 融合法则 | `chains.injectProtocol: true` 自动注入 System Prompt |
| **JSON 快照提取** | 末尾一行 JSON，自动解析入链图、自动剥离（用户不可见） | `hook.ts` 监听 `session/event` |
| **洞察引擎（超然层）** | 链间化学反应/迁移预测/置信度趋势/缺口聚合/分歧收敛，**仅建议不干预** | `get_insights` 工具 + HTTP API |
| **话题卡片 UI** | 输入区下方渲染可点击话题，点击复制到剪贴板 | Client 插件挂载 `conversation.input.dock` |
| **HTTP API** | `/api/context-pro/topics` `/mark-active` `/topics/stream` `/topics/batch` `/stats` | `webServer` 服务自动注册，支持鉴权/限流 |
| **项目技能注册** | `agent-principles` `api-contract-guide` `architectural-thinking` `integrated-catalysis` `chain-fusion-advanced` `insight-engine` `hook-tool-data-flow` | 启动时自动注册，模型可发现 |

## HTTP API 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/context-pro/topics` | GET | 获取指定会话的话题建议 `?sessionId=xxx` |
| `/api/context-pro/topics/stream` | GET | SSE 实时推送话题变更 `?sessionId=xxx` |
| `/api/context-pro/topics/batch` | POST | 批量查询 `{ sessionIds: string[] }` |
| `/api/context-pro/mark-active` | POST | 标记 Client 已激活 `{ sessionId }` |
| `/api/context-pro/stats` | GET | 全量可观测性指标（快照成功率/链健康度/洞察命中率） |
| `/api/context-pro/openapi.json` | GET | OpenAPI 3.1 规范文档 |

## 文档导航

| 文档 | 用途 |
|---|---|
| `docs/chain-design-final.md` | **终局设计文档**（五链图鉴/提取通道/架构/纪律） |
| `docs/chain-guide.md` | 链感知使用与架构指南 |
| `docs/Architectural-Thinking.md` | 五维认知结构图鉴（技能 `architectural-thinking`） |
| `docs/Integrated-Catalysis.md` | 链间化学反应催化酶（技能 `integrated-catalysis`） |
| `docs/AGENTS.md` | 智能体工作原则（技能 `agent-principles`） |
| `docs/CLAUDE.md` | API/接口/胶水公约（技能 `api-contract-guide`） |
| `docs/洞察引擎.md` | 洞察引擎架构与分析器详解 |

## 目录结构

```
DSH-Context-Pro/
├── src/
│   ├── index.ts           入口（name/apply/inject）
│   ├── prestep.ts         agent/pre-step 拦截器（链协议模式零干预）
│   ├── config.ts          Config schema（契约先行）
│   ├── skills.ts          技能注册（7 个技能）
│   ├── session-id.ts      统一 session ID 获取工具
│   ├── metrics.ts         可观测性指标收集
│   ├── auth.ts            HTTP 鉴权/限流中间件
│   ├── openapi.ts         OpenAPI 3.1 规范生成
│   └── chains/
│       ├── types.ts       链契约（ChainNode/ChainGraph/ChainIndex/InsightReference）
│       ├── graph.ts       ChainGraph 演化实现（upsert/prune/supersede/ended）
│       ├── index.ts       ChainIndex 临时存储 + 生命周期
│       ├── hook.ts        session/event 监听（提取快照 + 链提取 + 洞察分析 + 话题注入）
│       ├── snapshot.ts    快照 JSON 解析（容错修复 + confidence/diverged/supersede）
│       ├── prompt.ts      五链图鉴提示词段（注入 System Prompt）
│       ├── guide.ts       脉络导览（GPS/轨道图/缺口探测）
│       ├── insight.ts     洞察引擎（5 分析器 + 话题生成 + LRU 内存保护）
│       └── candidate.ts   链节点 → SELECT 候选（仅非链模式）
├── scripts/
│   ├── verify-e2e.ts      端到端装配验证
│   ├── verify-chains.ts   链感知方案验证（40 用例）
│   ├── verify-protocol.ts 图鉴协议内容完整性验证
│   └── diag-*.ts          会话日志/崩溃诊断工具链
├── docs/                  设计文档 / 技能源文件 / 公约
├── cordis.yml             装配示例（npm 包模式）
├── cordis.patch.yml       发布包自动应用的 patch
└── tsconfig.build.json    构建配置
```

## 验证

```bash
# 类型检查（用 harness 的 tsc）
cd D:/Git/github/deepseek-harness-master
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-e2e.ts

# 链感知（40 用例）
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-chains.ts

# 协议内容完整性
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-protocol.ts

# Cordis 配置校验（122 文件）
node --import tsx/esm scripts/verify-cordis-config.ts
```

## 设计决策

| 决策 | 理由 |
|---|---|
| CoT 放权 | 模型通过 System Prompt 内化五链图鉴，系统不干预推理过程 |
| 末尾 JSON 快照为主提取通道 | 正文自然表达，hook 自动剥离快照行（用户不可见） |
| 链图跟会话生命周期 | 删对话即删链，非长期记忆，零残留 |
| 纯 TS 无外部引擎 | 贴近 DSH 生态、HMR 友好、零依赖 |
| 洞察引擎超然层 | 只观察、只建议、不干预 CoT，避免污染模型推理 |
| Client UI 走 HTTP | 持久化、重启不丢失、不依赖动态插件 RPC |

## 发布到 npm

```bash
npm run build
npm publish --access public
```

---

**当前版本**：`0.3.0` | **协议**：GPL-3.0 | **仓库**：https://github.com/kiwifruit13/dsh-context-pro