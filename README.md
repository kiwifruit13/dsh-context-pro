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

### 非链模式（legacy）

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

## 装配

### 方式 A：npm 包

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
```

### 方式 B：源码路径（开发用）

```yaml
- insert:
    - id: context-pro
      name: 'file:///E:/Deepseek/DSH-Context-Pro/src/index.ts'
```

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `chains.enabled` | `false` | 开启链感知 |
| `chains.injectProtocol` | `false` | 注入五链图鉴到 System Prompt |
| `chains.maxNodesPerChain` | `20` | 每链节点上限（防演化失控） |

## 文档

| 文档 | 用途 |
|---|---|
| `docs/chain-design-final.md` | **终局设计文档**（五链图鉴/提取通道/架构/纪律） |
| `docs/chain-guide.md` | 链感知使用与架构指南 |
| `docs/Architectural-Thinking.md` | 五维认知结构图鉴（技能 `architectural-thinking`） |
| `docs/Integrated-Catalysis.md` | 链间化学反应催化酶（技能 `integrated-catalysis`） |
| `docs/AGENTS.md` | 智能体工作原则（技能 `agent-principles`） |
| `docs/CLAUDE.md` | API/接口/胶水公约（技能 `api-contract-guide`） |
| `docs/chain-tags-design.md` | 旧设计方案（已归档，仅供参考） |

## 目录结构

```
DSH-Context-Pro/
├── src/
│   ├── index.ts           入口（name/apply/inject）
│   ├── prestep.ts         agent/pre-step 拦截器（链协议模式零干预）
│   ├── config.ts          Config schema（契约先行）
│   ├── skills.ts          技能注册（architectural-thinking / integrated-catalysis 等）
│   └── chains/
│       ├── types.ts       链契约（ChainNode/ChainGraph/ChainIndex）
│       ├── graph.ts       ChainGraph 演化实现
│       ├── index.ts       ChainIndex 临时存储 + 生命周期
│       ├── hook.ts        session/event 接入（提取快照 + 剥离 JSON 行）
│       ├── snapshot.ts    快照 JSON 解析 + confidence 提取
│       ├── prompt.ts      五链图鉴提示词段（注入 System Prompt）
│       ├── guide.ts       脉络导览（GPS 坐标 / 轨道图 / 缺口探测）
│       └── candidate.ts   链节点 → SELECT 候选（仅非链模式）
├── scripts/
│   ├── verify-e2e.ts      端到端装配验证
│   ├── verify-chains.ts   链感知方案验证（36 用例）
│   └── verify-protocol.ts 图鉴协议内容完整性验证（20 用例）
├── docs/                  设计文档 / 技能源文件 / 公约
├── cordis.yml             装配示例
└── tsconfig.json          类型检查（paths 指向 harness 源包）
```

## 验证

```bash
# 类型检查（用 harness 的 tsc）
node D:/Git/github/deepseek-harness-master/node_modules/typescript/bin/tsc --noEmit

# 端到端（从 harness 根，因 tsx 在那里）
cd D:/Git/github/deepseek-harness-master
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-e2e.ts

# 链感知（36 用例）
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-chains.ts

# 图鉴协议（20 用例）
node --import tsx/esm E:/Deepseek/DSH-Context-Pro/scripts/verify-protocol.ts
```

## 设计决策

| 决策 | 理由 |
|---|---|
| CoT 放权 | 模型通过 System Prompt 内化五链图鉴，系统不干预推理过程 |
| 末尾 JSON 快照为主提取通道 | 正文自然表达，hook 自动剥离快照行（用户不可见） |
| 链图跟会话生命周期 | 删对话即删链，非长期记忆，零残留 |
| 纯 TS 无外部引擎 | 贴近 DSH 生态、HMR 友好、零依赖 |

## 发布到 npm

```bash
npm run build
npm publish
```