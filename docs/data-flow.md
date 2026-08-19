Hook ↔ Tool 数据传递全景
│
├── 身份锚点（谁在说话）
│   ├── Hook 侧
│   │   ├── 来源: bridge.base() 构造 stdin payload
│   │   ├── 字段: payload.session_id
│   │   ├── 等价: agent.session.header.id
│   │   └── 用途: Hook 用此 key 写外部存储
│   │
│   ├── Tool 侧
│   │   ├── 来源: agent-loop executeToolCalls() 绑定 exec.agent
│   │   ├── 字段: exec.agent.id
│   │   ├── 等价: ctx.agents.requireInitiator().id
│   │   └── 用途: Tool 用此 key 读外部存储
│   │
│   └── 不变式: payload.session_id === exec.agent.id
│       ├── 铸造: 工厂 CreateAgentOptions.sessionId 唯一源头
│       ├── 传播: withInitiator() → AsyncLocalStorage → requireInitiator()
│       ├── 投影: bridge 从 agent.session.header.id 读取，不信任 hook 输出
│       └── 隔离: 子 agent 独立 session，parentSession 记血统但不共享 id
│
├── 通路 1: stdin payload（Bridge → Hook）
│   ├── 构造者: bridge.base() + 事件特有字段
│   ├── 载荷字段
│   │   ├── session_id ← agent.session.header.id
│   │   ├── transcript_path ← sessionPersistence.locate()
│   │   ├── cwd ← agent.session.header.cwd
│   │   ├── hook_event_name ← 当前事件类型硬编码
│   │   ├── tool_name ← exec.name          [PreToolUse/PostToolUse]
│   │   ├── tool_input ← exec.arguments     [PreToolUse/PostToolUse]
│   │   ├── tool_use_id ← exec.callId       [PreToolUse/PostToolUse]
│   │   ├── prompt ← blocksToText(content)  [UserPromptSubmit]
│   │   ├── source ← session 启动来源       [SessionStart]
│   │   └── stop_hook_active ← false        [Stop]
│   ├── 传递方式: JSON 写入 hook 进程 stdin
│   └── 环境变量
│       ├── CLAUDE_PROJECT_DIR ← config.projectDir ?? workdir
│       └── 工作目录 ← agent.session.header.cwd
│
├── 通路 2: stdout JSON（Hook → Bridge）
│   ├── 解析: parseHookOutput(exitCode, stdout, stderr)
│   ├── 结构: HookOutput
│   │   ├── exitCode ← 进程退出码
│   │   ├── stderr ← 阻断原因文本
│   │   ├── stdout ← 原始文本（可能非 JSON）
│   │   ├── decision ∈ {approve, allow, block, deny, ask}
│   │   ├── reason ← 决策理由
│   │   ├── continue ∈ {true, false}  → false = 中断
│   │   ├── stopReason ← 中断原因
│   │   ├── additionalContext ← 额外上下文文本
│   │   ├── systemMessage ← 用户警告
│   │   ├── updatedInput ← 工具输入改写（⚠️ 当前不生效）
│   │   └── hookEventName ← 事件鉴别器
│   └── 合并: mergeHookOutputs() → MergedHookOutcome
│       ├── decision: deny > ask > allow（最严格胜）
│       ├── reason: 同 rank 的理由用 \n\n 拼接
│       ├── stop: 任一 hook continue:false 即 sticky
│       ├── additionalContext: 所有 hook 的按序累积
│       └── systemMessages: 所有 hook 的按序累积
│
├── 通路 3: additionalContext（Hook → 模型 → Tool）
│   ├── 触发: merged.additionalContext 非空
│   ├── 包装: contextFrom() → createUserMessage({ source: { kind: 'plugin' } })
│   ├── 注入路径
│   │   ├── SessionStart → agent.inject(context)  → next-step, 不唤醒
│   │   ├── UserPromptSubmit → prepend 到 downstream.messages
│   │   └── PostToolUse → prepend 到 downstream.additionalContexts
│   ├── 到达 Tool 的路径
│   │   ├── inbox → preStep() → claimed messages
│   │   │   └── 包含 additionalContext 生成的 UserMessage
│   │   ├── systemPrompt.assemble() → runtimeContext.project()
│   │   └── 模型请求 → 模型决策 → tool 调用参数
│   └── 特点: 间接传递，经模型中转，非点对点
│
├── 通路 4: Decision（Hook → 扩展点裁决）
│   ├── 映射表
│   │   ├── PreToolUse
│   │   │   ├── deny  → { kind: 'deny', reason }
│   │   │   ├── ask   → { kind: 'ask', reason }
│   │   │   └── allow → next() 放行
│   │   ├── UserPromptSubmit
│   │   │   ├── deny  → { kind: 'reject' }
│   │   │   └── allow → prepend context + next()
│   │   ├── PostToolUse
│   │   │   ├── deny  → { kind: 'block', feedback, additionalContexts }
│   │   │   └── allow → prepend context + next()
│   │   └── Stop
│   │       └── deny  → agent.steer() 强制继续
│   ├── 合并规则: mergeHookOutputs() 单调最严格
│   └── 效果: 控制流，非数据流
│
├── 通路 5: Session 事件日志（Hook/Tool → 共享真相源）
│   ├── Hook 写入
│   │   ├── hook/invoked: { turn, point, dialect, handlerId, matcher? }
│   │   └── hook/result:  { turn, point, handlerId, decision, exitCode?, durationMs }
│   ├── Tool 写入
│   │   ├── tool/call:   { turn, step, callId, name, arguments }
│   │   └── tool/result: { turn, step, callId, content, isError }
│   ├── 关联: handlerId 配对 invoked/result; callId 配对 call/result
│   └── 消费者
│       ├── 持久化: session/event → sessionPersistence
│       ├── UI 渲染: surface 事件
│       ├── Session Query: SQLite 索引 + 搜索
│       └── 不变式检查: request/header 与 deriveMessages() 一致性
│
├── 通路 6: steer / inject（Hook → Agent 行为注入）
│   ├── agent.inject(message)
│   │   ├── target: 'next-step'
│   │   ├── wakeup: false
│   │   └── 语义: "下次醒来带上，别现在动"
│   ├── agent.steer(message)
│   │   ├── target: 'next-step'
│   │   ├── wakeup: true
│   │   └── 语义: "现在就继续跑，带上这个"
│   └── 触发场景
│       ├── inject ← additionalContext 非空
│       └── steer  ← Stop hook deny（强制继续）
│
└── 不生效 / 保留通路
    ├── updatedInput
    │   ├── 语义: Hook 请求改写 tool 输入参数
    │   ├── 现状: bridge log + warn，不执行
    │   └── 原因: 输入改写延后到 interception extension-points
    │
    ├── systemMessage
    │   ├── 语义: Hook 向用户展示警告
    │   ├── 现状: bridge log + warn，不展示
    │   └── 原因: 展示机制尚未实现
    │
    └── continue:false（run-level halt）
        ├── 语义: 请求终止整个运行
        ├── 现状: merged.stop 记录但未执行
        └── 原因: 缺少 run-level halt 机制（TODO）