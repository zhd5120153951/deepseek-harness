# DSH 核心 spine 与 agent loop 研究报告
> 范围：`packages/core/{session,agent,agent-loop,tools,system-prompt,scope}` +
> `agent-default-model`、`agent-tool-presentation`，辅以 docs（architecture、agent-lifecycle、
> subsystems/{core,session,tools,system-prompt,scope,invariants}）。引用均为仓库内相对路径 + 行号。

---
## 0. 总览：spine 的六包数据流
一次模型交互穿过六个包，构成一条闭环（docs/subsystems/core.md:9）：
1. **driver**（`agent-loop`）从 **inbox** 认领输入，在 **session log**（`ctx.sessions`）上打开
   `turn/start`；
2. 通过 **system-prompt**（`ctx.systemPrompt`）组装提示词分段 + 工具 schema；
3. 从 session log **deriveMessages()** 派生出模型历史（日志即唯一事实源）；
4. 经 **LLM seam**（`ctx.llm`）流式请求，chunk 逐条回写日志；
5. 模型请求的工具调用经 **tool registry**（`ctx.tools`）执行，结果回写 `tool/result`；
6. 所有"模型可见"的事实都以 session 事件落日志，下一步再从日志派生。
`scope/` 是唯一非 Service 的库包（core.md:20）：`createScope`/`scopeOf`/`scopeTarget`
提供按 agent 的作用域注册原语，被 session、system-prompt、tools 三个注册表共同消费。
`agent-loop` 是 `Agent` 公共契约的唯一具体实现；扩展插件只依赖 `agent`（拿到 `ctx.agents`
与 initiating Agent），从不直接依赖 `agent-loop`，因此 loop 可整体替换（core.md:20）。

两个贯穿全仓库的类型模式（core.md:260-298）：**`…Map → derived union`**（接口键表 +
`keyof` 派生判别联合，插件 `declare module` 声明合并加变体，不改源码；典范 `SessionEventMap`、
`TurnEndReasonMap`）；**Branded ID**（`SessionId`、`CallId` 结构上为 string、类型上不可互换，
util/brand）。

---
## 1. Agent 对象模型
### 1.1 `Agent` 接口的关键方法
`Agent` 是插件（UI、hooks、编排器）编程的唯一表面（packages/core/agent/src/runtime-types.ts:64-144）。
字段：`id: SessionId`（与 `session` 共享同一身份）、`options: AgentOptions`（provider/model/maxTokens）、
`session: Session`、`inbox: Inbox`、`status: AgentStatus`（`'idle' | 'running'`，runtime-types.ts:50）、
`ctx: Context`（agent 作用域上下文）。

方法语义（核心是统一的 `send` + 三个固定预设别名，core.md:55）：

| 方法 | 行为 | 位置 |
|---|---|---|
| `send(message, target, wakeup)` | 路由到 inbox 边界并可唤醒 driver；取消后到达的唤醒输入会改投 `next-turn` | agent.ts:113-120（loop 实现） |
| `followup(message)` | `send(msg, 'next-turn', true)`——排队一个独立轮次并唤醒 | agent.ts:122-124 |
| `steer(message)` | `send(msg, 'next-step', true)`——就近 step 边界注入并唤醒 | agent.ts:126-128 |
| `inject(message)` | `send(msg, 'next-step', false)`——为下一次 pre-step 排队上下文，**不唤醒** | agent.ts:130-132 |
| `cancel(cause, opts?)` | 清空 inbox（除非 `keepInbox`）+ abort 活动（`cancel` 到 `AbortSignal.reason`） | agent.ts:134-140 |
| `whenIdle()` | 等到整个 agent 无活动（跟随替换性工作） | agent.ts:195-200 |
| `runMaintenance(task)` | 在真正的 idle 相运行一个非 turn 维护任务；公共状态保持 `idle` | agent.ts:142-162 |
`followup` 不返回句柄：`MessageId` 标识的是 durable inbox 插入/认领/丢弃事实，而非后来的
assistant 输出或 turn 结束（core.md:155）。`AgentCancelCause`（`user | parent | hook |
disposed`，runtime-types.ts:143-147）是类型强制的同进程输入，被拷贝进 `AbortSignal.reason`；
durable `turn/end` 只保留粗粒度 `{ kind: 'aborted' }`，记录"谁"需单独事件（core.md:203）。

### 1.2 `AgentHandle` 的职责与生命周期
`AgentHandle = { agent: Agent; dispose(): Promise<void> }`（packages/core/agent/src/index.ts:172-175）。
`dispose()` 是**能力（capability）**：只有持有者能拆掉这个 agent。顺序为：
停 loop → 等退出（`cancel({kind:'disposed'})` + `whenIdle()`）→ 注销注册表 →
从 store 移除 session → 最后 unwind 作用域世界（agent-loop/src/index.ts:497-520 的 memoized `dispose`）。
工厂 provider 也是结构性 owner（agent 依赖其服务 API），provider unload 会停并 drain
它创建的每个 handle。`ctx.agents.get(id)` 只返回裸 `Agent`；config 创建的 agent 由 loop
fiber 拥有，不需要 handle。

创建事务（`prepare` → `publish`，agent-loop/src/index.ts:459-578）：
1. 注册 memoized 反向 teardown（在**任何资源存在之前**，防泄漏）；
2. `new ReactLoopAgent(...)` 构造 driver + scope + ctx；
3. `publish(source)` 依次 `sessions.enter` → `agents.enter` → `sessions.announce` →
   `agents.announce` → `emit agent/session-start`（index.ts:556-569），中间每步 `assertLive()`；
4. 任一步 setup throw / commit throw / owner disposal 都整体回滚，不发布任何一个 id。
`AgentSetup`（index.ts:69-71）是"组合而非驱动"契约：setup 期间一切经 `agentCtx` 注册的
东西（scoped tools、prompt sections/variables、restrict、listeners、await 的子插件）
在 `agent/created` 与首次 prompt 组装之前就已存在；可返回同步 `commit()` 在发布点再校验
（index.ts:116-132）。

### 1.3 `ctx.agents` 注册表与 create/resume 工厂语义
`AgentRegistry`（packages/core/agent/src/index.ts:256-704）持有 live agent 表，并把
"创建"委托给 `AgentFactory`（由 loop 经 `setFactory` 注册，index.ts:372-388）——消费者
只依赖 `ctx.agents`，不依赖具体 loop 包。
- `create(options: CreateAgentOptions)` → `createAgent(ownerCtx, options)`：同 id 建
  session + agent，经 setup → 双 announce → 发 `agent/session-start` → 启动 loop
  （index.ts:405-415；factory 实现 index.ts:606-622）。
- `resume(options: ResumeAgentOptions)`：先经 `sessionPersistence.prepare` 加载持久化
  session，再走同样的 setup + publish（`source: 'resume'`）（index.ts:424-430；
  loop 实现 653-710）。
- `register/enter/announce`：`register` 是普通路径（construct + 注册 + 公告一体）；
  `enter`+`announce` 是高级有序生命周期原语，让 async factory 在未发布状态下完成 setup、
  把 detach 闭包装进预装的组合 teardown，再公告（index.ts:450-576）。
- `isOwnedBy(id, owner)`：运行时创建者归属，与 durable session lineage 无关（index.ts:595-597）。

**initiator scope**（core.md:207-209）：`withInitiator(agent, op)` / `withoutInitiator(op)` /
`currentInitiator()` / `requireInitiator()`（index.ts:309-358）。用两个 `AsyncLocalStorage`
传播"发起链"：driver 由 `kick()` 包在 `withInitiator` 里启动（agent.ts:192），工具调度用
`ctx.agents.requireInitiator()` 取回 agent（tool-calls.ts:67）。环境在场既不是存活证明
也不是授权；teardown 时 drain 所有返回 Promise 的边界（index.ts:619-637）。`setFactory`
只允许注册一次（重复注册抛错），agent-loop 在构造时 `ctx.effect(() => ctx.agents.setFactory(this))`
注册（agent-loop/src/index.ts:350），工厂随 loop 生命周期卸载。

### 1.5 注册表的 enter/announce 时序与回滚
`AgentRegistry` 用与 `SessionStore` 相同的"三明治"发布协议（agent/src/index.ts:450-576，
session/src/index.ts:830-996）：**`enter`**（index.ts:474-509）构造 entry、`store.set`、
装发布钩子，返回一次性 detach 闭包（`announcing` 期间 detach 置 `detachRequested`，延后到
公告 unwind 后执行，保证 disposal 恒在 creation 之后）；**`announce`**（index.ts:549-576）
先标 `announcing/announced`（防 listener 递归建第二个生命周期边），派发 `agent/created`——
**同步 throw 否决发布并回滚**（已交付部分由成对 `agent/disposed` 覆盖），async rejection
只能记录；**`detachEntered`**（index.ts:512-525）按 entry 身份删除，仅 `announced` 才发
`agent/disposed`（从未公告的插入不发，避免发明不可能的生命周期边）。

session 侧完全同构（`sessions.enter` 捕获 `scopeTarget(session, scopeOf(ctx))` 作 carrier，
index.ts:913-947）。agent factory 用 `prepare/enter/announce` 而非 `sessions.create`，是为了
把 session + agent 生命周期**折叠进同一组合 effect**（loop 的 `publish`，
agent-loop/src/index.ts:556-569），fiber unload 按序拆除，避免竞态拆掉发布钩子导致 loop
收尾事件丢失（session/src/index.ts:843-861）。

### 1.4 `agent/*` 事件分类：live vs durable
`agent/*` 事件全部声明在 packages/core/agent/src/runtime-types.ts:146-291（`declare module
'@deepseek-ai/cordis'` 的 `Events`）。分类（core.md:57-58 的三域模型 + agent 内部再分）：
- **生命周期（live emit）**：`agent/created`、`agent/disposed`、`agent/status`、`agent/session-start`。
- **inbox（live emit）**：`agent/inbox/inserted`、`agent/inbox/claimed`、`agent/inbox/discarded`。
- **机器扩展点**：`agent/pre-step`（waterfall，返回 `PreStepDecision`）、`agent/request`
  （waterfall，改写 LlmCallConfig）、`agent/request-error`（waterfall，`retry | undefined`）、
  `agent/turn-stopping`（**serial**，无 `next()`，唯一非 waterfall 的拦截点）。
- **错误通知（live emit）**：`agent/error`。

关键区分：**turn/step 边界是 durable session 事件**（`turn/*`、`step/*`），不是 agent 事件
（core.md:205）；`agent/*` 只承载 live 控制/状态。inbox 的**投影**则是 durable 的——
`agent/inbox/spliced` 事件（agent/src/types.ts:12-26）通过声明合并进入 `SessionEventMap`，
是"live 通知先行、投影后随"的规范化 splice 记录（inbox.ts:158-193）。
`agent/*` 事件的 scope 过滤：所有声明都以 `Scoped<Agent>` 为 `this`（runtime-types.ts:159
等），由 `agentEvents(ctx, agent, carrier)`（dispatch.ts:107-149）把 subject 注入 payload、
以 `scopeTarget(agent, agent)` 为 carrier 派发——subject 与 scope key 不可分离；`AgentSubjectEvent`
类型（dispatch.ts:28-34）在类型层面筛选"payload 首参带 `agent` 且 `this: Scoped<Agent>`"
的事件，让融合派发器类型安全。

---
## 2. Agent loop 驱动
### 2.1 step 与 turn 的精确定义
- **step** = 一次模型请求 + 它请求的工具执行（architecture.md:65）。
- **turn** = 零个或多个 step：在首个输入被认领**之前**打开，在"欠账"（模型回复、工具
  调用、steering）清偿后关闭；可以有零 step（拒绝/空输入/取消/失败时 `turn/start` 后直接
  `turn/end`，types.ts:238-243）。

### 2.2 驱动主循环：位置与流程
主循环在 `packages/core/agent-loop/src/agent.ts` 的 `ReactLoopAgent`（agent.ts:64）。
三个层次：
- **`kick()`**（agent.ts:210-223）：driver 边界。`while (await this.turn()) {}` 循环跑
  连续 turn，退出后 phase 归 `idle` 并回放被 latch 的唤醒。
- **`turn()`**（agent.ts:246-330）：一轮。打开 `turn/start` → 循环 step 边界：`preStep`
  → 拒绝则 `blocked` 关轮；空消息首 step 则 `completed` 关轮（不花模型调用）；否则
  `step/start` → 逐条 append `user/message` → `step()` → `step/end`。step 结束后若
  `turnEnds` 且 `nextStep` 为空 → `agent/turn-stopping`（serial），再查一次 inbox，有则
  继续下一 step（`target = 'next-step'`）；`finally` 里 append `turn/end`（agent.ts:316-323）。
  返回 `true` 表示还有 pending 工作 → 继续下一 turn。
- **`step()`**（agent.ts:332-401）：`buildRequest` 组装请求 → `llm.stream` 逐 chunk
  append `assistant/chunk` → `BlockAssembler` 收拢 → `assistant/message`（带 usage 与
  `sourceEventSeqs: chunkSeqs`）→ 若 finish 是 error/aborted 走 `agent/request-error`
  waterfall（可 `retry`）→ max-tokens 返回 sticky 结局 → 有 `tool-call` block 则
  `executeToolCalls`，返回 `{concluded}` 决定本轮是否结束。

phase 状态机（agent.ts:38-46）：`idle | maintenance | running{turn,step,abort,wakeRequested}`；
`status` getter 把 maintenance 算作 `idle`（agent.ts:99-101），`setPhase` 在翻转时发
`agent/status`（agent.ts:104-111）。每个 turn 结束换新 `AbortController`（agent.ts:325）。

### 2.3 inbox：queued vs next-step 输入
`Inbox`（packages/core/agent/src/inbox.ts:25-220）维护两个**有序 pending 列表**：
`next-turn`（排队轮次）与 `next-step`（step 边界输入），`InboxTarget`（types.ts:10）；
是 durable 投影：构造时从 `session.events` 回放 `agent/inbox/spliced`（inbox.ts:32-40）。
- `append/prepend/replace/remove/clear/splice` 都经 `mutate()` 先 `session.append('agent/inbox/spliced', …)`
  再改内存投影（inbox.ts:158-193），保证 durable 事件先于 live 投影，同步观察者能看到
  splice 前的列表以重建被移除的消息（inbox.ts:130-138）。
- **`claim(target, turn)`**（inbox.ts:71-78）：取走**全部** `next-step` 输入；若 `target ===
  'next-turn'` 再取走**一个**排队消息。纯删除 splice（不产生 discarded 通知），随后逐条发
  `agent/inbox/claimed`。这就是"一个普通 followup 成为其所在轮次的唯一普通消息"的机制
  （core.md:178）。
- 唤醒语义（agent.ts:113-120）：`wakeup=false` 的 inject 只排队；取消后到达的唤醒输入
  重分类为 `next-turn`（等中止活动收敛到 idle 再跑）；`disposed` 取消则停泊。

### 2.4 `agent/pre-step` 与 `agent/turn-stopping` 的语义差异
- **`agent/pre-step`（waterfall，runtime-types.ts:231）**：决定"模型看到什么"。payload 带
  exclusive 认领批（`messages`）、拟议 step 坐标（`turn/step`）、当前 turn 的取消信号。
  默认 `next()` 返回 `enter(messages + runtime-context 快照)`（agent.ts:234-240）；listener
  可改写消息或 `reject`。**reject 或首 enter 被改写为空 → 关闭一个不花 step 的 durable
  turn**（agent.ts:267-277，core.md:219）。它是请求派生前唯一的 serial 拦截链
  （core.md:235）。
- **`agent/turn-stopping`（serial，runtime-types.ts:278）**：turn 即将关闭、模型不再欠账
  （无 live 工具调用、无 fresh steering）时，在边界提交前**等待**（agent.ts:295-299）。
  listener 反对可 `agent.steer(...)`，机器重读 inbox：有 fresh steering 就再跑一个 step，
  没有就关轮——"数据决定"，listener 顺序无法改变结果（runtime-types.ts:263-271）。
  反向控制（提前停工具循环）也是数据：`tool/result` 带 `concludesTurn` 当步结束 turn
  （agent.ts:395-399；tool-calls.ts:157）。

### 2.5 模型请求如何组装
`buildRequest(turn, step, tools, system, boundaryMessages, signal)`（agent.ts:407-495）：
1. **seed config**：首次请求用 agent options（route + reasoningEffort/maxTokens）；之后用
   `requestProposal(persistedHeader)` 去掉 adapter 默认值字段（agent.ts:55-61, 428-437）。
2. **`agent/request` waterfall**（agent.ts:438-441）：`await next()` 得到机器本会用
   config，可整体替换（缺失 provider/model 则报错，agent.ts:443-445）。
3. `ctx.llm.prepareCall(config, signal)` 物化精确模型默认值；`NO_ADAPTER` 时降级接受
   中间件提议（agent.ts:448-455）。
4. **`canonicalHeader`** 组装 `EpochHeader{config, adapterDefaults?, system?, tools?}`
   （request-header.ts:21-31，空 system/tools 为缺省字段），与 `session.requestHeader()`
   比较：首次（或基线缺）append reason `'initial'|'resume'`，变化才 append `'change'`
   （agent.ts:458-470）。同时按需 append `request/context`（agent.ts:472-483）。
5. 请求 = `markAgentLoopRequest(deepFreeze({...config, messages, system?, tools?, sessionId, signal}))`
   （agent.ts:486-493）——`messages` 即 `session.deriveMessages()`（agent.ts:341），
   `system` 即 `renderPrompt(assembly)`（agent.ts:337），`tools` 即 assembly 的 tools。

**组装输入的三段来源**：system-prompt 分段（第 5 节）+ deriveMessages 历史
（session/surface，第 3.5 节）+ tools schema（第 4 节）。loop invariant 正是断言这个
"请求 ⟺ 日志可重建"等式（见 7.1）。

### 2.6 取消、错误收敛与 teardown
- **取消**：`cancel(cause)`（agent.ts:134-140）默认 `inbox.clear()`（durable splice 带
  `outcome:'canceled'`，inbox.ts:58-61）并 abort 当前 phase；`keepInbox` 只 abort 不丢
  工作。运行中 phase 的 `signal.throwIfAborted()` 在每个 await 边界检查（agent.ts:264, 346…）。
- **aborted 结局**：`turn()` catch 里 `signal.aborted` → `{kind:'aborted', reason}`（agent.ts:303-306）；
  流中 `finish.kind==='aborted'` 走 `agent/request-error`（agent.ts:354-371）；工具侧未启动
  调用写合成错误结果保证回放有效（tool-calls.ts:237-259）。
- **错误结构化**：非 LlmError 扁平化 `{message: errorChain(error), code:'UNKNOWN'}`（agent.ts:309-314）；
  `throwError` 先发 `agent/error` 再抛（agent.ts:203-208），`kick()` 的 catch 是 driver 边界。
- **teardown**：disposal = "`disposed` cause 取消 → `whenIdle()` → `scope.dispose()`"
  （agent-loop/src/index.ts:497-520）；`whenIdle` 乒乓等待 activity 稳定（agent.ts:195-200）。
  唤醒 latch：中止活动收敛到 idle 后回放 `wakeRequested`（agent.ts:172-193, 220）——即使
  唤醒消息已被清空也打开 turn 边界（cancel-convergence wake latch）。

---
## 3. `SessionEventMap`：事件词汇表与机制
### 3.1 事件分类
`SessionEventMap`（packages/core/session/src/types.ts:236-333）是 append-only 日志的
合并可扩展键表。分类：
- **turn/step 边界**：`turn/start`、`turn/end{reason: TurnEndReason}`、`step/start`、`step/end`。
- **模型可见消息（SurfaceEventType）**：`user/message`（直接提示 / `inject` 上下文 /
  goal 续轮，`source` 区分）、`assistant/message`（带 usage 与 sourceEventSeqs）、
  `tool/result`（message + `error?` + 工具私有 `meta?`）。
- **回放/工具配对**：`assistant/chunk`（token 级回放保真）、`tool/call`（原始 `arguments`
  JSON 串，未解析，与 `tool/result` 以 `callId` 配对）。
- **log-only 状态**：`todo/write`（整表快照，last-write-wins）、`request/header`
  （EpochHeader 全快照 + reason）、`request/context`（路由容量）、`session/end-seed`。
- **插件合并**：`agent/inbox/spliced`（agent 包）、`tool/code-dispatch(-start)`（tools 包）、
  `compaction/*`、`hook/*`、`goal/change`、`schedule/change` 等（known-event-types.ts:19-64）。
`SessionEvent<T>`（types.ts:404-436）是**真判别联合**（`switch(type)` 直接收窄 `data`），
`seq = log.length` 连续性契约是全系统依赖（index.ts:564-567）。**注意**：合并可扩展意味着
`switch` 不得用 `assertNever`（session.md:247）。

### 3.2 声明合并机制
`SessionEventMap` 是 `interface`，插件在 `declare module '@deepseek-ai/dsh-session/types'` 里
`interface SessionEventMap { 'plugin/event': Payload }` 加变体（如 agent/src/types.ts:12-26、
tools/src/types.ts:25-57）。`SessionEventType = keyof SessionEventMap` 自动包含合并结果；
`SurfaceEventType`（types.ts:343-346）是产生消息、可上 surface 的三元子集。同一模式还用于
`TurnEndReasonMap`（types.ts:155-177）、Cordis `Context`/`Events`、`AssembleContext` 等。

### 3.3 `ignorable` 标记
事件信封上的 `ignorable?: true`（types.ts:413-422）：标记"读者可安全跳过的不认识类型"。
**缺省 = 必须**——遇不认识且无标记的事件，读者必须拒绝重建整个 session。默认偏保守：
忘了加标记只会过度拒绝，不会静默恢复被掏空的日志。词汇增长靠它 + 生成的
`KNOWN_SESSION_EVENT_TYPES`（known-event-types.ts:19-64）双保险。

### 3.4 `SESSION_FORMAT_VERSION`
单单调整数、无 major/minor（types.ts:34-56），当前 `0`（未发布，无兼容承诺）。是否 bump
看 **writer 发出什么**而非 reader 能接受什么：只有结构性变化（header 形状、事件信封、
核心事件语义、surface 机制）才 bump；普通加事件类型靠 `ignorable` 覆盖。seed/load 边界
强制校验版本与形状（index.ts:96-136, 253-352），不兼容日志直接拒绝而非部分回放。

### 3.5 surface 机制与 `deriveMessages()`
- **Surface**：日志之上按 `surfaceOp` 维护的"产生消息事件的有序视图"（surface.ts:1-460）。
  `SurfaceOp = 'append' | {op:'replace',start,end}`（types.ts:372-374）。`replace` 由
  compaction 等使用，阴影掉被替换区间；`sourceEventSeqs` 必须覆盖全部被阴影节点
  （surface.ts:211-243），`tool/result` 重写只允许改 content（surface.ts:287-318）。
- **`deriveMessages()`**（index.ts:726-747）：按 surface nodes 折叠 `deriveEventMessage`
  （surface.ts:83-114）——`user/message`→user 消息原样；`assistant/message`→assistant
  （空 content 的 max-tokens 占位被跳过）；`tool/result`→含 tool-result block 的 user
  消息；其余（边界/chunk/log-only）不投影。缓存：每节点只投影一次，`replaceGeneration`
  变化时整体重建；返回新数组、消息对象共享且深冻结。
- 发送边界验证：`Session.append`（index.ts:604-655）先 `snapshotJsonValue`（lossless JSON
  单遍校验+拷贝），再 `SurfaceManager.validateNext` 预演 surface 转换，然后才入 log 并
  同步通知 `session/event` 观察者（失败逐 listener 包含，index.ts:382-399）。
- **`SurfaceManager` 增量折叠**（surface.ts:398-460）：`validateNext` 预演候选转换存
  `_pendingPlan`，`_processDelta` 在入 log 后应用——失败不部分变更 surface；外部重建用
  纯函数 `foldSurface`（surface.ts:387-395）走完全相同规则。

### 3.6 SessionStore 生命周期、fork、flush 与 repair
- **`create`**（index.ts:830-841）：`prepare`（验证 id/cwd、合成 `SessionHeader`，
  index.ts:863-889）+ 单一 effect 内 `enter`（装发布钩子，返回 detach）+ `announce`
  （发 `session/created`）；公开三步是给 agent factory 的进阶原语（见 1.5）。
- **`fork(source, boundary?, childId?)`**（index.ts:1081-1138）：以 inclusive `boundary`
  seq（默认当前最后事件）取连续前缀，**拒绝**以 open turn 结尾的前缀（`OPEN_TURN`）；
  子 session 继承 `cwd`、记 `parentSession` 与 `seedLength`。
- **`flush(session)`**（index.ts:1022-1039）：经 store 拥有的 carrier 派发 awaited parallel
  `session/flush`（持久化插件的 durability 检查点），"一个 owner、一种拼写"。
- **seed 校验**（index.ts:508-548）：seed 用与 append 相同的不变量验证（lossless JSON、
  信封形状、seq 从 0 连续、surface 转换预演），坏 seed 在进口失败；seed 后自动 append
  `session/end-seed` 标记本生命周期起点（index.ts:545-547）。
- **repair**：`repair.ts` 提供 `interruptedTurnClosers` 与 `TOOL_NOT_STARTED`/
  `TOOL_OUTCOME_UNKNOWN`（崩溃孤儿 turn 关闭标记；`interrupted` 结局仅持久化恢复合成，
  types.ts:173）。

---
## 4. 工具系统
### 4.1 `ToolDefinition` 完整字段
`ToolDefinition extends ToolSchema`（packages/core/tools/src/index.ts:222-288）：

| 字段 | 含义 |
|---|---|
| `name/description/parameters`（继承 ToolSchema） | 模型可见三字段；`schemas()` 只投影这三个（index.ts:1256-1267） |
| `output: ToolOutputDefinition` | **强制**：`{schema: JsonSchemaNode, render(args,value)→ContentBlock[], presentationMeta?}`（index.ts:212-219） |
| `execute(args, exec) → Promise<unknown>` | 返回 canonical lossless-JSON 值，受 `output.schema` 校验（index.ts:235） |
| `finalizeContent?(exec, result)` | 同步最后一英里内容变换；执行开始时快照回调、每种归一化结果恰好调用一次（含绕过 post-execute 的管道失败），在 lossless 物化前（index.ts:247, 1649-1654） |
| `timeoutMs?` | 协作式超时预算；由 `dsh-tool-call-timeout-policy`（tools/execute wrapper）执行，**绝不发模型**（index.ts:255） |
| `isConcurrencySafe?(args)` | 纯同步并发分类；仅精确 `true` 入选 parallel，其余（含异常/非法参数）exclusive（index.ts:269, 1276-1285） |
| `presentCall?(args)` / `presentResult?(args,result)` | 纯、无副作用、可重放的 UI 呈现意图（`card` 判别联合，presentation.ts） |

执行结果类型：`ToolExecutionResult = ToolExecutionSuccess{value,content,meta?,additionalContexts?,concludesTurn?} |
ToolExecutionFailure{error,content,meta?,additionalContexts?}`（index.ts:556-580）。
canonical `value` 仅执行局部，durable 事件只存 content/error/meta（tools.md:370）。

### 4.2 schema DSL（不是 zod）
作者面 schema 是**自研 JSON-value DSL**（schema.ts:1-617，运行时校验走自研
`json-schema.ts` 强制子集）：`ValueSchemaSpec` 支持 `string/number/integer/boolean/null/
array/object/json/oneOf`（schema.ts:85-94），显式 object 必须声明
`additionalProperties: true|false`；参数表是隐式开放 object 根、`required: true` 逐属性
（schema.ts:97-106）。编译：`parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema`
（schema.ts:438-458）用迭代式任务图（`runSchemaCompiler`，schema.ts:275-414，防递归爆栈 +
环检测）编译到强制 raw 子集（json-schema.ts:1-610，`assertSupportedJsonSchema`/
`validateJsonSchemaValue`）。类型推断：`InferArgs`/`InferValue` 精确到 16 层容器深度后
回退 `JsonValue`（schema.ts:153-175）。`defineTool`（schema.ts:545-617）把参数 schema
编译、执行时 `validateArgs`（不合法抛 `ToolArgsError`/`INVALID_ARGS`）、execute/render/
presentationMeta 类型绑定 `InferValue<O>`。presenter 在回放时**软校验**（老参数不匹配 →
`undefined` → 通用卡片，schema.ts:594-609）。注意仓库其他地方（cordis 配置）才用
Schemastery（`z`），工具 schema 不用。

### 4.3 `ctx.tools` 注册 API
`ToolRuntime`（index.ts:787-1863）维护 `ScopedLayers<ToolLayer>`：global 层 + 按 scope 的
agent 层（`ToolLayer`：named tools + anonymous restrictions + guards + mode，index.ts:714-754）。
- `register(def)`（index.ts:1037-1062）：校验 output/schema/timeoutMs、保留 `run_code` 名，
  经 `layers.effect`（scoped 注册阴影 global，返回精确 disposer）。
- `restrict({allow?,deny?})`（index.ts:1071-1098）：仅 scoped；过滤**继承**的工具（global +
  祖先链），自己层注册的工具豁免；空过滤器/未知名/保留名拒绝。
- `guard(fn)`（index.ts:1110-1116）单调守卫；`presentAs(mode)`（index.ts:946-974）在 scope
  上声明 `native|code|both` 呈现模式。
- `schemas(scope)` / `get(name,scope)` / `executionMode(exec)`：共享 `view(scope)`
  （index.ts:1152-1193）单次层遍历（inherited 受限制 + own 注册豁免 + 非 native 追加
  `run_code` transport）。

### 4.4 执行管线各阶段
`execute(input)`（index.ts:1342-1344）→ `prepareExecution`（index.ts:1463-1507）→ 分段：
1. **`createExecution`**（index.ts:1364-1451）：物化/冻结参数（lossless JSON 单遍）、分配
   `ToolExecutionToken`、捕获 `finalizeContent` 快照、建立 cancellation state；**mode
   collapse**（`code` 下模型直呼非 `run_code`）在策略管线**之前**确定性拒绝
   （`UNKNOWN_TOOL` + 路由提示，index.ts:1373-1444）。
2. **`tools/pre-execute` waterfall**（index.ts:1474-1478）：可重排的 allow/deny/ask 决策；
   `ask` 经 approval seam（`ctx.get('approval')`，缺失/无 agent → deny，index.ts:1689-1729）。
3. **monotonic guards**（index.ts:1486-1488）：`guardReason` 无 allow 结果，返回 reason
   只能减少权限——listener 顺序无法把 denial 翻回 allow（index.ts:1119-1128）。
4. **`tools/execute` around-dispatch waterfall**（index.ts:1573-1576）：wrapper 只能替换
   `signal`；`dispatchToolBody`（index.ts:1532-1560）把 caller signal 与 wrapper signal
   **再融合**（`fuseToolSignals`，index.ts:1889-1916），body 返回值经 `createSuccessResult`
   （index.ts:1793-1823）快照+校验+render+投影 meta。
5. **`tools/post-execute` waterfall**（index.ts:1742-1781）：`accept`（可换 content 或
   value 之一）或 `block`（反馈变 isError）；两者可附加 `additionalContexts`。
6. **`finalizeContent`**（index.ts:1649-1654）：应用快照回调；返回 undefined 保留。
7. **`tools/result` emit**（index.ts:1657-1676）：`materializeFinalResult`（lossless +
   深冻结）后，把 frozen exec + result 发给观察者（失败包含）。

调度侧（scheduler 视图，`TOOL_RUNTIME_SCHEDULER` 符号，index.ts:451-466）把管线拆成
`prepare`（有序 pre 门）/ `dispatch`（并发 body）/ `finalize|finish`（有序 post + 通知），
供 agent-loop 的并行调度器重叠执行（见 4.5）。取消语义：body 未启动 →
`ABORTED_BEFORE_DISPATCH`；已启动 → `ABORTED`（index.ts:1518-1525, 1919-1944）。

### 4.5 调度：`executeToolCalls` 与 `executionMode`
`executeToolCalls`（agent-loop/src/tool-calls.ts:59-101）把一步的 model-order tool calls
分组：每次按**当前** `executionMode` 分类——exclusive 单独成组（屏障），parallel 组成
rolling pool（上限 `maxParallelToolCalls`，默认见 constants.ts:5）。`runGroup`
（tool-calls.ts:121-246）：
- `tool/call` 事件在启动前 append（tool-calls.ts:167, 262-265）；
- 有序 pre（prepare）与并发 body 重叠；结果按 **model order** 经 head-of-line cursor
  `commitReady` 提交（tool-calls.ts:146-160），每次提交 `tool/result`（sourceEventSeqs
  引用 call seq，tool-calls.ts:268-289），`additionalContexts` 经 acceptor 进 next-step
  inbox（tool-calls.ts:156）；
- abort：已启动的 drain + 提交；未启动的逐条写合成错误结果（`TOOL_ABORTED_BEFORE_DISPATCH`，
  tool-calls.ts:237-259）保证回放有效；调度器内部失败则不伪造结果（tool-calls.ts:231-235）。

### 4.6 Code Mode（`run_code`）
`run_code` 是**保留呈现 transport**（code-mode.ts:20），从不进可过滤层，只在非 native
模式的 scope 可见（index.ts:1189-1191）。工作方式（code-mode.ts:296-530+）：
- 模型只能直呼 `run_code`（mode `code` 下其他 native 名被 collapse，index.ts:1324-1326）；
- 程序通过 SDK binding 调 `registry[TOOL_RUNTIME_SCHEDULER]` 发起**嵌套 dispatch**
  （`parent: exec.token`，subCallId `<parent>:code:<n>`，code-mode.ts:466-481），遵循与
  native 完全相同的并发契约（exclusive 屏障 + parallel 池，单 driver lane 串行有序阶段，
  code-mode.ts:344-449）；
- 程序立刻拿到结构化 value（settle 即 resolve，code-mode.ts:489-499）；`tool/code-dispatch-start`
  与 `tool/code-dispatch` 事件（types.ts:10-57）只记录子调用的运行/结果（log-only，不进
  模型历史），后者可经 `tools/code-dispatch-log` waterfall 改写 durable 副本（spill 策略
  的 preview+locator，index.ts:1296-1306）；
- 外层 `run_code` 的结果是精选的 `{logs, result?}` 摘要（render 为文本），只有它进入
  模型历史（code-mode.ts:315-329）。`dsh-agent-tool-presentation` 让 preset 在 scope 上
  `tools.presentAs(mode)`（agent-tool-presentation/src/index.ts:59-72），无 runtime 时
  挂载即报错。

### 4.7 工具呈现（快速浏览）
`presentCall`/`presentResult` 返回 `card`-tagged 渲染意图判别联合（presentation.ts:1-364），
如 `{card:'terminal',…}`、`{card:'diff', diffs, locations?}`、`{card:'search', shape,
truncated, total}`、`{card:'read', path, offset, lines}`、`{card:'web', kind}`（tools.md:461-466）。
契约：**纯且无副作用**——UI 在 live streaming 与日志回放都可调用，只依赖 `args` 与
durable 投影 `ToolResult{content,isError,meta?}`（index.ts:291-302）。`meta` 由
`output.presentationMeta` 投影、随 `tool/result` 持久化，replay 时复现同一张卡片
（types.ts:282-290）；host/client runtime 把中立词汇投影成各自视图。

---
## 5. 系统提示词组装
### 5.1 `PromptSection` 与注册
`PromptSection{name, order, text: string | ((ctx)=>string), complete?}`（system-prompt/src/index.ts:53-75）。
order 约定：`-100` harness 身份、`0` deployment persona、100-199 工具指导（index.ts:58-61）。
注册：`systemPrompt.section()`（index.ts:381-390）经 `ScopedLayers.effect` 写入调用上下文
的 scope 层；scoped section 阴影同名 global；`complete: true` 的 section 组装后**恢复为
唯一 section**（多个有效 complete section 报错，index.ts:505-508）。还有 `context()`（动态
runtime context 贡献）、`variable()`（`{{name}}` 插值）、`suppressRuntimeContext()`、
`tools(provider)`。

### 5.2 tool-provider 如何进入 assembly
`ToolRuntime` 构造时 `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`
（index.ts:832）：`wireSchemas`（index.ts:980-1001）按 scope 解析可见工具 → `native` 全量
schema；`code` 只留 `run_code`；`both` 双份。返回 `ToolProviderResult{schemas, knownNames?}`
（system-prompt/index.ts:104-109），其中 `knownNames` 是 pre-restriction 名称宇宙，用于
区分"配置拼写错误"与"已知但被隐藏"（tools 的 toolOrder 校验）。

### 5.3 `assemble()` 与 waterfall 的 `next()` 语义
`SystemPrompt.assemble(context)`（index.ts:467-542）：
1. 收集 global + scope-chain 的 variables（近者胜）、merge sections/contexts（全局 +
   链上阴影）、跑全部 tool providers（`structuredClone` 参数脱离，index.ts:493-499）；
2. `orderTools`（index.ts:164-178）：配置的 `toolOrder`（含 `TOOL_ORDER_REST` 占位，
   index.ts:140）或字典序；
3. 组 `PromptAssembly{sections, contexts, tools, variables}`；
4. `ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', assembly, context, next)`
   （index.ts:532-535）：**expert waterfall**——`await next()` 得到当前 assembly，listener
   可整体替换；`complete` section 在 waterfall 之后被恢复，所以 listener 无法增删该
   scope 的完整提示（index.ts:536-541, docs/subsystems/system-prompt.md:169）。

### 5.4 runtime context 快照
动态上下文（`PromptContext` 列表）不直接进 system 文本：agent-loop 在 preStep 里
`renderContextSections` + `joinContextSections`（index.ts:236-240）渲染成**完整快照字符串**，
经 `RuntimeContextProjection`（agent-loop/src/runtime-context.ts:25-76）与上次保留值比较，
**仅在变化时**作为 `user/message`（source `@deepseek-ai/dsh-system-prompt`，form 'snapshot'）
写入日志（agent.ts:233）。compaction `replace` 阴影掉旧快照时投影置 null
（runtime-context.ts:46-55）——"变化才落日志"，与 7.1 的"模型可见 ⟺ 已日志化"一致。

### 5.5 渲染
`renderPrompt(assembly)`（index.ts:212-217）：逐 section 做严格 `{{variable}}` 插值
（未知/未定义变量抛错，`interpolate` index.ts:258-295），丢弃空段，空行连接。loop 在
`step()` 开头 `renderPrompt(assembly)` 得 `system`（agent.ts:337）。

---
## 6. scope：作用域注册与 isolate realm
`scope` 是纯库包（scope/src/index.ts:1-204，store.ts:1-267）。

### 6.1 核心概念
- **`ScopeKey = object`**（index.ts:15）：不透明身份；shipped loop 直接用 live `Agent`
  对象当 key（scope.md:11）。
- **`Scoped<T>`**（index.ts:27）：只读路由 carrier 的编译期品牌；scope 过滤事件的
  `this` 类型。`scopeTarget(base, key)`（index.ts:170-185）构造 carrier：保留 base 的
  Cordis filter，再按 tag 判定——无 tag 的 listener 全局接收；带 tag 的 listener 在
  key 或 key 的**祖先**（`bindScopeParent` 链）命中时接收（事件只向上流，index.ts:157-165）。
- **`createScope(ctx, key)`**（index.ts:137-147）：mint 一个 Cordis 子 fiber，
  `fiber.ctx.extend({[kScope]: key})` 得到带 tag 的 scoped ctx；`rawDispose`（精确
  disposer，供组合 effect 嵌套）与 `dispose()`（共享 quiescence，幂等）双退出路径。
- **`scopeOf(ctx)`**（index.ts:154-156）读最近 tag；`bindScopeParent`/`scopeChainOf`
  （index.ts:72-102）维护父链（带环检测；rebind 是唯一重链权限，供 preset recompose）。

### 6.2 `ScopedLayers` 与 isolate realm
`ScopedLayers<L>`（store.ts:159-267）是各注册表的共享存储：**急切** global 层 + **惰性**
精确 scope 层（读不建层，store.ts:180-183）。`chainLayers`（store.ts:192-199）返回祖先优先、
本层最后的层链；`merge()`（store.ts:208-217）物化 global named entries + 链上阴影；
`effect(ctx, action, opts)`（store.ts:226-266）把同步层变更挂到调用上下文的 Cordis effect
上（scope 由 `scopeOf(ctx)` 决定、action 返回同步 undo、层整体空才回收、可发 `onChange`
——tools/change、system-prompt/change 的源头）。

"isolate realm"是 preset 系统里把服务实例隔离在组内的机制（architecture.md:112）：preset
的 service 行声明 `isolate` realm，实例对组外（含 host）不可见；`ctx.agentPresets.serviceFor
(agent, name)` 是从外部读组内实例的唯一路径（docs/subsystems/core.md:495-510）。scope 父链
让 preset 的 standing mount 覆盖其下每个 agent（`presentAs` 即声明在 mount scope 上）。

---
## 7. 设计哲学观察（从代码提炼）
### 7.1 "model-visible ⟺ logged" 不变式在代码里的落实
这是全系统第一不变式（architecture.md:92-96："Anything that reaches a model request
must be reconstructable from the log, and a runtime invariant asserts it"）。落实点：
- **结构上**：`Session.append` 对每个模型可见事实强制 `surfaceOp`（SurfaceEventType 编译期
  要求，types.ts:343-347）；`request/header` 把 system+tools+config 全快照入日志
  （agent.ts:458-470）；`deriveMessages()` 只从日志派生，无独立历史存储。
- **运行时**：`dsh-agent-loop/invariant` 在 `llm/stream` 上（agent-loop/src/invariant.ts:19-55）
  对 loop 构造的请求断言：请求必须 frozen、带 live sessionId；`options.messages` 必须
  JSON 等于 `session.deriveMessages()`（log-reconstruction desync 即 fail）；model/system/
  temperature/maxTokens/stop/tools 必须匹配 `foldRequestHeader(events)` 折叠出的 header。
  这是"编译期强制 + 运行时断言"的双保险。

### 7.2 events as extension points（三域 + 一原则）
architecture.md:53-61 明确：**Session 事件 = durable 事实；Agent 事件 = live 控制；能力事件
= seam 策略**。选择域的准则："事实要过重载就选 session 事件"。进一步的模式：
- **waterfall 决策 + monotonic guard**：可重排的扩展点（pre-step、request、request-error、
  pre-execute、execute、post-execute、code-dispatch-log、system-prompt/assemble）由 listener
  决定，`next()` 委托；不可重排的安全底线（工具 guard）设计成**无 allow 结果**的单调函数
  （tools.md:313）。
- **数据决定，顺序无关**：`agent/turn-stopping` 后机器重读 inbox，listener 顺序不能改变
  结局（runtime-types.ts:263-271）；guard 同理。

### 7.3 注册即 effect
几乎每个注册 API（`tools.register/restrict/guard/presentAs`、`systemPrompt.section/context/
variable/tools`、`agents.register`、`sessions.create`）都经 `ctx.effect`（Cordis 可逆
effect）注册并返回**精确 disposer**；组合 effect 靠 yield 精确 disposer 保持嵌套顺序
（agent/src/index.ts:441-449 明确"exact identity is load-bearing"）。`createScope` 让
"注册到 agent.ctx"自动获得"agent 卸载即撤销"的生命周期——HMR 与 teardown 零泄漏。

### 7.4 其他反复出现的哲学
- **lossless JSON + deep-freeze**：事件 data、工具参数/结果、请求全走 `snapshotJsonValue`
  （单遍校验拷贝）与 `deepFreeze`；不可序列化数据在源头拒绝（session/index.ts:614-622、
  tools/index.ts:632-639）。
- **fail-closed**：并发分类非精确 `true` 即 exclusive（tools/index.ts:1278-1284）；无
  approval 服务时 ask→deny（tools/index.ts:1694-1698）；`ignorable` 缺省即 required
  （types.ts:413-422）。
- **边界验证在"进口"**：seed/load 用与 append 相同的不变量校验（session/index.ts:508-548），
  持久化读路径拒绝未知必需事件（known-event-types.ts:8-18）。
- **包自持不变量**：每个包一个 `./invariant` companion 注册到 `ctx.invariants`
  （invariants.md:5），只断言权威事件流/可变数据，不做合成断言；agent 断言
  `agent/status` 无重复转换（agent/src/invariant.ts:15-24），session 断言 turn/step 嵌套
  与调用配对（session/src/invariant.ts:55-120+）。
- **同进程可信 + 跨边界显式**：initiator 是"因果归属"而非授权（agent/index.ts:249-254）；
  ToolExecutionToken 是同进程 opaque symbol；身份（agent/session/call）在 worker、进程、
  持久化、线协议边界各自显式。
- **"cached, incremental, frozen"**：`deriveMessages`（每节点一次）、`requestHeader`/
  `requestContext` fold（每事件一次）、surface delta——热路径都 O(新增)，快照数组不回长。
- **driver 与 registry 解耦**：loop 经 symbol 键的 scheduler 视图（`TOOL_RUNTIME_SCHEDULER`）
  调 registry 的分段管线，普通插件只见 `execute`——有序阶段与并发 body 重叠而不违反顺序
  （index.ts:451-466）；`seq = log.length` 连续性让持久化可逐字存储规范日志（session.md:603）。

---
## 附录：最重要的代码片段
### 片段 1 —— turn 驱动主循环（packages/core/agent-loop/src/agent.ts:246-330，摘录）
```ts
private async turn(): Promise<boolean> {
  const turn = phase.turn + 1
  this.session.append('turn/start', { turn })
  let turnEnds: TurnEndReason | null = null, target: InboxTarget = 'next-turn'
  try {
    while (true) {
      const step = phase.step + 1
      const decision = await this.preStep(target, { turn, step })
      if (decision.kind === 'reject') { turnEnds = { kind: 'blocked' }; return false }
      if (phase.step === 0 && decision.messages.length === 0) { turnEnds = { kind: 'completed' }; return false }
      this.session.append('step/start', { turn, step })
      try {
        for (const m of decision.messages) this.session.append('user/message', m, { surfaceOp: 'append' })
        const stepEnd = await this.step(decision.assembly)
        if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
      } finally { this.session.append('step/end', { turn, step }) }
      if (turnEnds && this.inbox.nextStep.length === 0) {
        await this.dispatch.serial('agent/turn-stopping', { turn, signal })
        if (this.inbox.nextStep.length === 0) break
      }
      target = 'next-step'
    }
  } catch { /* aborted / error 结局 */ } finally { this.session.append('turn/end', { turn, reason: turnEnds! }) }
  return this.inbox.hasPending
}
```

### 片段 2 —— Session.append：接受/发布边界（packages/core/session/src/index.ts:604-655，摘录）
```ts
append<T extends SessionEventType>(type, data, ...opts): SessionEvent<T> {
  const dataSnapshot = snapshotJsonValue(data)
  if (dataSnapshot === undefined)
    throw new Error(`session event "${type}" carries non-JSON-serializable data`)
  const entry = attachments.get(this)
  if (entry?.appending)
    throw new Error('session append cannot reenter while another append is being published')
  const event = deepFreeze({ type, seq: this.log.length, time: Date.now(), data: dataSnapshot, ...surfaceMetadataSnapshot } as unknown as SessionEvent<T>)
  this.surfaceManager.validateNext(event as SessionEvent)
  if (entry !== undefined) entry.appending = true
  try {
    let callbacks: SessionCallback[] | undefined
    if (entry !== undefined)
      callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', this, event])
    this.log.push(event as SessionEvent)
    this.eventsSnapshot = undefined
    if (callbacks !== undefined) invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, [this, event], callbacks)
    return event
  } finally { if (entry !== undefined) { entry.appending = false; if (entry.detachRequested && !entry.announcing) entry.detach() } }
}
```

### 片段 3 —— buildRequest：请求的三段组装（packages/core/agent-loop/src/agent.ts:438-494，摘录）
```ts
const proposedConfig = await this.dispatch.waterfall(
  'agent/request', { turn, step, signal },
  () => Promise.resolve(seedConfig),          // seed = options 或上一 header 提议
)
if (!proposedConfig.provider || !proposedConfig.model)
  throw new Error(`agent "${this.id}" has no provider/model: …`)
// NO_ADAPTER 时降级接受中间件提议，否则物化精确模型默认值
const preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
const header = canonicalHeader({ config: preparedCall?.config ?? proposedConfig, ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults }, ...system ? { system } : {}, ...tools.length > 0 ? { tools } : {} })
const baseline = this.session.requestHeader()
if (!this.requestHeaderLogged) {
  this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
  this.requestHeaderLogged = true
} else if (baseline === undefined || !headerEquals(baseline, header)) {
  this.session.append('request/header', { header, reason: 'change' })
}
const request = markAgentLoopRequest(deepFreeze({
  ...header.config, messages: boundaryMessages,
  ...header.system !== undefined ? { system: header.system } : {},
  ...header.tools !== undefined ? { tools: header.tools } : {},
  sessionId: this.session.id, signal,
}))
return { request, preparedCall }
```

### 片段 4 —— 工具管线门：pre-execute + guards（packages/core/tools/src/index.ts:1463-1506）
```ts
private async prepareExecution<T>(input, next): Promise<T> {
  const created = this.createExecution(input)          // 冻结参数、collapse 检查、token
  if (created.kind !== 'ready') return next(created)
  const exec = created.exec
  if (this.callerCancelled(exec))
    return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() })
  try {
    const carrier = scopeTarget(this, exec.agent)
    const gate = await this.ctx.waterfall(
      carrier, 'tools/pre-execute', exec,
      () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
    )
    const askResolution: ToolAskResolution = gate.kind === 'ask'
      ? await this.serviceAsk(exec, gate)
      : { decision: gate, approvalCancelled: false }
    const { decision } = askResolution
    if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
    const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason
    if (denialReason !== undefined) return await next({ kind: 'post-result', exec, result: this.materializeFinalResult({ content: [{ type: 'text', text: `Error: ${denialReason}` }], isError: true, error: { message: denialReason } }) })
    if (this.callerCancelled(exec)) return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
    return await next({ kind: 'dispatch', exec })
  } catch (error) { return next({ kind: 'final-result', exec, result: toolErrorResult(error) }) }
}
```

### 片段 5 —— systemPrompt.assemble 骨架（packages/core/system-prompt/src/index.ts:467-542，摘录）
```ts
async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
  const scope = context.scope
  const sectionByName = this.layers.merge(scope, layer => layer.sections)
  const contextByName = this.layers.merge(scope, layer => layer.contexts)
  const sectionDefinitions = [...sectionByName.values()].sort((a, b) => a.order - b.order)
  const completeSections = sectionDefinitions.filter(section => section.complete === true)
  if (completeSections.length > 1)
    throw new Error(`multiple complete prompt sections are active: …`)
  const assembly: PromptAssembly = {
    sections,
    contexts: runtimeContextSuppressed ? [] : /* ordered contexts */,
    tools: orderTools(collected, this.toolOrder, knownNames),
    variables,
  }
  const transformed = await this.ctx.waterfall(
    scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
    () => Promise.resolve(assembly),
  )
  if (completeSection === undefined && !runtimeContextSuppressed) return transformed
  return {
    ...transformed,
    sections: completeSection === undefined ? transformed.sections : [completeSection],
    contexts: runtimeContextSuppressed ? [] : transformed.contexts,
  }
}
```

---
## 附录：术语与事件速查
| 术语 | 含义 | 关键位置 |
|---|---|---|
| inbox（next-turn / next-step） | 排队轮次 / step 边界输入两个有序列表 | agent/src/inbox.ts:25-220 |
| surface / surfaceOp / sourceEventSeqs | 日志上产生消息事件的有序视图及其进入方式/来源引用 | session/src/surface.ts；types.ts:372-389 |
| EpochHeader | 请求信封（config+adapterDefaults+system+tools），`request/header` 全快照 | types.ts:201-210；request-header.ts |
| ToolExecutionToken | 同进程 opaque 调用身份 symbol | tools/src/index.ts:304-307 |
| Scoped\<T\> / ScopeKey / carrier | scope 过滤派发的 this 类型 / 身份 key / 路由接收器 | scope/src/index.ts:15-27, 170-185 |
| initiator | AsyncLocalStorage 传播的"发起 agent"，因果归属非授权 | agent/src/index.ts:309-358 |
| ignorable | 未知事件可跳过标记；缺省 = 必须拒绝重建 | types.ts:413-422 |
| SESSION_FORMAT_VERSION | 磁盘格式版本（单整数，当前 0） | types.ts:34-56 |
`agent/*` 事件一览（声明于 agent/src/runtime-types.ts:146-291）：

| 事件 | 模式 | 用途 |
|---|---|---|
| `agent/created` / `agent/disposed` | emit | 发布 / 离注册表（disposed 在 driver quiescence 后、session detach 前） |
| `agent/status` | emit | `idle` ⇄ `running` 转换 |
| `agent/inbox/inserted|claimed|discarded` | emit | live inbox 通知 |
| `agent/session-start` | emit | 会话生命周期开始（startup/resume/clear/compact） |
| `agent/pre-step` | waterfall | 拒绝或改写进入 step 的消息批 |
| `agent/request` | waterfall | 替换冻结的调用配置 |
| `agent/request-error` | waterfall | 模型请求失败恢复（`retry` 或终局） |
| `agent/turn-stopping` | serial | turn 关闭前终局检查点（无 next，可 steer 续轮） |
| `agent/error` | emit | step/turn 错误通知 |
`tools/*` 事件一览（tools/src/index.ts:142-207）：`tools/pre-execute`（waterfall，allow/deny/ask）、
`tools/execute`（waterfall，around-dispatch）、`tools/post-execute`（waterfall，accept/block）、
`tools/code-dispatch-log`（waterfall，改写 run_code 子调用 durable 副本）、`tools/result`
（emit，冻结终局）、`tools/change`（emit，**不过滤**的注册表变化广播）。
`session/*` 事件（session/src/index.ts:37-87）：`session/created`（emit，同步 throw 可否决）、
`session/disposed`（emit，配对拆除）、`session/event`（emit，append 后 fire-and-forget 通知）、
`session/flush`（parallel，await 的 durability 检查点）。

## 参考文档索引
- docs/architecture.md（turn flow 63-90；model-visible ⟺ logged 92-96；事件三域 53-61）
- docs/agent-lifecycle.md（turn/step 时序图）
- docs/subsystems/{core,session,tools,system-prompt,scope,invariants}.md（正文已给出关键段落与行号）
