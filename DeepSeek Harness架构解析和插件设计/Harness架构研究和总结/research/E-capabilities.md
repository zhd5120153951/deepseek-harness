# DeepSeek Harness（DSH）Agent 级能力层研究报告

> 研究范围：`ctx.subagents`（子代理）、`ctx.workflowEngine`（工作流）、`ctx.goals`（目标）、plan mode、todo、skill、jobs、compaction、spill、session-query、context、schedule、feedback、attachment、mcp 等 Agent 级能力。
> 仓库根目录：`E:\WorkSpace\LLM_Projects\deepseek-harness`。所有引用均为仓库内相对路径（`packages/.../src/index.ts:行号`）。
> 本文档是代码分析产物，行号以阅读时的源码为准。

---

## 0. 总览：能力层地图与"seam + tool consumer"模式

DSH 的所有 Agent 级能力都遵循同一套**能力 seam（capability seam）**架构，在 `docs/subsystems/*.md` 中反复被表述为三角色分工：

- **Service Definition（服务定义）**：一个 `ctx.<name>` 上的抽象/具体 Service，只定义"做什么"（契约、请求/结果类型、事件），不含实现；
- **Service Provider（服务提供者）**：同一个 seam 的兄弟包，实现具体后端（进程内、进程外、SQLite、本地文件系统……），以插件方式注册；
- **Consumer（模型面向消费者）**：通常是 `tool-*` 包，把 seam 的 API 包装成模型可见的工具（`defineTool`），并在 `systemPrompt.section()` 里注册使用策略。

各 seam 一览（Service Definition → Provider → Consumer）：

| 能力 | ctx seam | Service Definition | Provider | 模型工具 |
|---|---|---|---|---|
| 子代理 | `ctx.subagents` | `packages/subagent/subagent` | spawn/fork/acp/codex/claude-code/dsh-sdk | tool-subagent、tool-subagent-control、tool-subagent-report |
| 工作流 | `ctx.workflowEngine` | `packages/workflow/workflow` | workflow-worker-thread | tool-workflow、tool-ralph |
| 目标 | `ctx.goals` | `packages/goal/goal` | goal-round-driver（驱动） | tool-goal、command-goal |
| 计划模式 | `ctx.planMode` | `packages/plan/plan-mode` | —（自带） | `exit_plan_mode` 工具 + `/plan` 命令 |
| 技能 | `ctx.skills` | `packages/skill/skill` | skill-filesystem、skill-badge、runtime | tool-skill |
| 后台任务 | `ctx.jobs` | `packages/jobs/jobs` | jobs-local | tool-jobs |
| 压缩 | `ctx.compaction` | `packages/compaction/compaction` | compaction-basic、compaction-tool-result-pruner | command-compact（人类命令） |
| 溢出存储 | `ctx.spillStore` | `packages/spill/spill` | spill-local | spill-policy（tools/post-execute 变换器） |
| 会话查询 | `ctx.sessionQuery` | `packages/session-query/session-query` | session-query-sqlite | tool-session-query |

贯穿全部能力层的两条核心设计纪律：

1. **fail loud, no silent degradation（响亮失败，绝不静默降级）**：请求需要的能力若 provider 不支持，在 start/mount 时即抛类型化错误，而不是"接受后忽略"。例：`subagent/index.ts:481-496` 的 `assertCapabilities`、`workflow-worker-thread/src/runtime.ts:369-373` 的 `UNSUPPORTED_OPTION`。
2. **模型可见 ⟺ 可重放（model-visible iff replayable）**：所有模型看到的状态都以**会话日志事件（session events）**为唯一权威来源，UI 与恢复端从日志 fold 出来，没有"活镜像"。例：goal 的 `goal/change`、plan 的 `plan/mode`、todo 的 `todo/write`、compaction 的 `compaction/*`、workflow 的 `tool-workflow/*` 记录、subagent 的 `subagent/descriptor`。

---

## 1. 子代理体系（ctx.subagents）

### 1.1 seam 模型与 provider 注册

- Service Definition：`packages/subagent/subagent/src/index.ts`（`SubagentRuntime extends Service`，`index.ts:171`）。与 bash 的"一 context 一执行器"不同，subagent seam 是**命名 provider 注册表**（`index.ts:172` `providers = new Map<string, SubagentProvider>()`），一个 context 可同时存在多个后端，按名字选用；文档 `docs/subsystems/subagent.md:5` 明确它仿照 LLM adapter registry，而非 bash 的单服务模型。
- 注册：`registerProvider(provider)`（`index.ts:369-385`）effect 作用域、HMR 安全；重复名抛 `DUPLICATE_PROVIDER`。生命周期事件：`subagent/provider-added` / `subagent/provider-removed`（`index.ts:140-146`）。
- Provider 契约：`packages/subagent/subagent/src/types.ts:285-323`：

```ts
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities        // outputSchema | depthLimit | toolFilter | persona
  readonly inheritsParentContext: boolean            // 描述性标志，供工具措辞使用
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>  // 方法存在即能力
}
```

- 能力校验：`SubagentRuntime.start()`（`index.ts:414-426`）先 `expectProvider` → `assertCapabilities`（`index.ts:481-496`，逐项对照请求选项与 `SubagentCapabilities`，缺一即抛 `UNSUPPORTED_CAPABILITY`）→ `assertSubagentMaxDepth` → `assertObjectJsonSchema(outputSchema)` → 快照不可变 descriptor（`snapshotSubagentDescriptor`，`descriptor.ts:259-294`）→ 交给 provider 并挂上生命周期观测（`observeRun`）。
- 一次性请求类型 `SubagentStartRequest`（`types.ts:100-149`）：`label/prompt/parent/signal/agentOptions/outputSchema/maxDepth/toolFilter/persona`。`parent: Agent` 是必需的——进程内后端从它的持久会话状态派生 cwd、谱系、委托深度；ACP 只读它的 cwd（`types.ts:106-110`）。
- 运行结果：`SubagentRun`（`types.ts:249-275`）——`id`（本地运行必须等于子会话 id）、`localAgent?`（仅进程内）、`result: Promise<SubagentResult>`（**永不 reject**，子级失败以 `stopReason` 表达）、`dispose()`。`SubagentResult.output` 的选取规则是"最后一个非空 assistant 消息的 content"（`assistant-output.ts`），部分答案在 cancel/截断下仍可存活。

### 1.2 生命周期事件对（subagent/start、subagent/end）

`packages/subagent/subagent/src/lifecycle.ts`：

- `observeRun`（`lifecycle.ts:133-162`）：一次性 run 发布时发射 `subagent/start`（携带 `SubagentRunInfo`），`run.result` 落定时发射配对的 `subagent/end`（携带 `SubagentRunEndInfo`），runId 随机生成作为配对键。
- `createActivationObserver`（`lifecycle.ts:175-217`）：可续子代理的每次 **residency epoch**（一次激活期）也发射同样的 start/end 对——观察者看到相同词汇，不需要知道子代理是被 materialize、wake 还是 cold-resume。epoch 的终止原因由 `epochStopReason`（`lifecycle.ts:235-260`）从"本 epoch 自己的事件后缀"推导（借助 `foldConsumedWork`），因此不会把之前 epoch 的答案算作本次的输出。
- 事件按**委托父代理**做 scope 过滤分发（`index.ts:157`，`@dshScopeScan unsupported`），父作用域监听者只看到自己的委托；每个监听者被独立 containment（`lifecycle.ts:100-123`），抛错/拒绝不会饿死兄弟监听者。
- 会话投影：注册 `subagent` 身份/时序投影单元（`index.ts:197-200`），供 `listChildren`/`listDescendants` 从 session store + 可选持久化做只读枚举（`index.ts:339-360`），**不加载/不恢复 Agent**，是"不可见可重放"原则的又一例。

### 1.3 一次性 run 的完整流程（进程内）

`packages/subagent/subagent-in-process-driver/src/index.ts` 是 spawn/fork 共享的驱动：

- `startInProcessRun`（`in-process-driver/index.ts:102-148`）：校验深度 → `SessionId(randomUUID())` 保留子 id → 捕获委托策略（`captureDelegatedPolicyOverrides`，父的 sandbox override + approval 钉死为 `'never'`，`child-agent.ts:199-204`）→ 在子 agent 的 creation window 内执行 setup（追加委托策略事件、`applyChildComposition` 组装 preset/persona/toolFilter、可选挂结构化运行时、`attachDescriptorAppend` 在首轮前把 `subagent/descriptor` 追加进子日志）→ `parent.ctx.agents.create(...)` 创建子 Agent（`childSessionMeta` 记录 cwd/parentSession/origin/delegationDepth/seedLength，`child-agent.ts:102-120`）。
- `drivePublishedRun`（`in-process-driver/index.ts:154-205`）：把已发布的孩子包装成一个 run——signal 桥接（abort → `child.cancel({kind:'parent'})`）、一次 `followup` + `whenIdle()`、结果读取、幂等 dispose。
- `readResult`（`in-process-driver/index.ts:208-233`）：从 activation boundary 之后的事件后缀读最终 assistant 输出，`toStopReason`（`48-65`）把 `TurnEndReason` 映射为 seam 词汇（`blocked`→`refusal`，`aborted`→`aborted` 等）；有 `outputSchema` 时要求 `structured_output` 工具成功捕获（见下）。

结构化输出（`in-process-driver/src/structured.ts`）：

- 子作用域内注册一个 `structured_output` 捕获工具 + 尾部提示指令（`structured.ts:19, 26-29`），并要求模型"必须以该工具调用作为最终结果"。
- 两阶段提交：工具体把校验通过的值暂存进 `WeakMap<ToolExecution, {value}>`（`structured.ts:59`）并 `concludeTurn()`，真正的提交发生在权威的 `tools/result` 通知（`structured.ts:116-139`）——只有 pipeline 完整成功后才落 `captured`；后续任何工具调用被 `tools.guard` 单调拦截（`structured.ts:109-111`）。child 作用域注册保证并发运行互不干扰、dispose 无残留。

### 1.4 spawn vs fork：新会话 vs 继承会话

`packages/subagent/subagent-spawn-in-process/src/index.ts`：

```ts
class SpawnInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  readonly inheritsParentContext = false      // 全新子代理：零父上下文
  start(request) { return startInProcessRun(request, {}) }   // 无 seed
  prepareContinuable() { return Promise.resolve({}) }        // 无 seed 的可续贡献
}
```
（`spawn-in-process/index.ts:41-60`；默认注册名 `spawn`，`index.ts:31`）

`packages/subagent/subagent-fork-in-process/src/index.ts`：

- `completedTurnPrefix(parent)`（`fork-in-process/index.ts:48-54`）：取父日志**到最后一个 `turn/end` 为止**的平衡前缀作为 seed——正在进行的工具调用轮是"不平衡"的，不能作为合法子会话重放；`seq === 数组下标`（append 契约），所以 `slice(0, lastEnd.seq+1)` 天然是从 seq 0 开始的合法 seed。
- `ForkInProcessProvider`（`fork-in-process/index.ts:61-89`）：`inheritsParentContext = true`；`start()` 用该 seed 调 `startInProcessRun`；`prepareContinuable` 也在创建时捕获一次该前缀（成为子日志不可变部分，后续 cold-resume 重放该前缀而不是重新 fork 父的更新历史）。
- fork 的 continuable 存在一个已知取舍（`fork-in-process/index.ts:77-82` 的 TODO 注释）：可续子的 `report` 工具与提示节会排在继承历史之前，破坏 fork 前缀复用，因此现有组合把 fork 绑定为 `backgroundMode: 'one-shot'`。

共享的子组装逻辑集中在 `packages/subagent/subagent/src/child-agent.ts`：深度预算（`resolveChildDepth`，`48-57`，以持久化的父 header 为单调下界）、子 `AgentOptions` 解析（`68-83`）、子会话 meta（`102-120`）、以及"固定委托声明"上下文（`SUBAGENT_DELEGATION_CONTEXT`，`135-139`：子代理权限范围固定、不可加宽）。二者（一次性驱动与 continuation manager）共用这一套，所以深度核算、谱系盖章、委托策略只有一个实现。

### 1.5 可续对话（continuable）与 continuation manager

`packages/subagent/subagent/src/continuation.ts` 是内部编排服务（工具 schema 与宿主适配器只消费这一个契约；前台一次性委托永远不进入这个生命周期）：

- **模型**：一个可续子 = 一个持久 Session + **至多一个进程内 Activation**（residency epoch，`continuation.ts:8-13, 191-240`）。Activation 不是 request/result/cancel/Task 边界：它执行很多 FIFO 轮，并在它创建的后代仍运行时保持驻留。Agent inbox 是唯一队列，所以消息顺序唯一；没有一条可续路径创建 Task 或中间 result 包装。
- **状态推导**：`stateOf`（`continuation.ts:870-874`）从 Agent 静止性与 owned-children 集合推导 `running | waiting | settled`——不维护第二套状态机。`Agent.status` 单独不够（waking send 与 admission 微任务之间仍是 `idle`），因此用 `activation.accepted` 集合（manager 已接收但尚未离开 inbox 的 id）补足。
- **startContinuable**（`continuation.ts:403-457`）：保留稳定子 id → 快照 `continuable` 模式 descriptor（含 agentProvider/agentModel/persona/toolFilter，供 cold resume）→ 捕获委托策略 → `host.prepareContinuable` 取 provider 的分离创建 spec → `materialize`（`966-1076`：通过私有 activation-owner scope `ctx.agents.create`，注册 ownership、inbox claimed/discarded 监听、发布 start 边）→ `submitMaterialized` 提交初始 prompt。返回 `{childId, messageId}`，**inbox 接收即成功**，不等待轮开始或消息进日志；之前任何失败都不返回 id 并整体回滚。
- **followup**（`continuation.ts:476-505`）：按 Activation 驻留性路由——`running` 入队、`waiting` 唤醒同一 Agent、无 Activation 则 `coldResume`（`883-932`：`persistence.inspect` → 授权持久化 header 的直接父 → 只 fold 子日志自己的后缀得到 descriptor（fork seed 会重放祖先的 descriptor，故用 `seedLength` 截断，`905`）→ `ctx.agents.resume` 重建 → 提交轮）。**授权**：`authorizeLineage`（`1211-1225`）要求"registry 中精确的活父 Agent"且持久 parentSession 匹配；`MessageSource` 只记录来源，不授予权威。
- **interrupt**（`continuation.ts:528-568`）：同步授权（`user`：直接父地址；`ancestor`：精确活祖先，先拒绝过期/自指）后发出 `Agent.cancel({keepInbox:true})` 即返回；缺失目标为接受的 no-op。
- **reportFrom**（`continuation.ts:583-593`）：子显式 `report` 的投递通道，子本身是授权凭证；`deliverReport`（`630-653`）把内容包成 `subagent-report` relay 源的消息，按 `quiet | wakeup` 策略 `inject` 或 `followup` 给父。
- **settlement 通知**：`watchSettlement`（`1233-1268`）等待静止 + 子全部 dispose 后在 child lock 内打开 disposal 事务；`finishDisposal`（`1297-1380`）自上而下传播 cancel、子优先释放、`flushFinalState` 尽力 flush、`observer.capture/settle` 收尾；**在释放 ownership 之前**（父此时仍计数这个孩子、不会被判静止）调用 `notifySettlement`（`1400-1449`）给父投递 `subagent-settled` notice（含 stopReason 对应文案，`291-312`），父静止则 `followup`、忙则 `steer`、自身 teardown 中则 `inject`（不唤醒）。
- 生命周期终点由 manager 独占：外部 `subagent/end` 监听器无法正确完成"告知父"（payload 不命名父、handle 已 dispose、唤醒父 settlement watcher 的 release 已发生），这是 `continuation.ts:15-19` 明说的设计理由。
- 部署能力注入：`registerContinuableSetup`（`index.ts:286-292`）+ `activation-setup-registry.ts`——`tool-subagent-report` 正是通过它把 `report` 工具装进每个可续子的未发布创建上下文（见 1.7）。

### 1.6 tool-subagent：一次性 vs 可续的模型语义

`packages/subagent/tool-subagent/src/index.ts` 是 provider 绑定的委托工具（每个实例绑定一个 provider 名）：

- 配置（`index.ts:29-99`）：`provider`（必填）、`backgroundMode: 'one-shot' | 'continuable'`（默认 one-shot）、`maxDepth`（默认 3，`'provider-managed'` 表示交给进程外后端）、`persona`、`toolFilter`、`agentOptions`。**挂载时**（provider-added 时 `mount`，`283-434`）就校验能力：数值型 maxDepth 需要 `depthLimit`、continuable 需要 `prepareContinuable`——配置错误在挂载失败，不在首次委托失败。
- 工具措辞来自 `provider.inheritsParentContext`（`providerWording`，`213-238`）：fork 型描述为"继承本会话已完成轮次"（并要求 prompt 只写增量），spawn 型描述为"完全独立的子代理"。这保证模型不会对 fork 孩子重复整个会话。
- 执行路由（`resolveDelegationRun`，`249-267`）：
  - **前台**：`ctx.subagents.start(...)` 后 `settleForegroundRun`（`169-199`）收集并总是 dispose；非 `completed` stopReason 映射为 `isError` 工具结果（`stopReasonError`，`125-142`），但把部分输出拼进错误文本（`withPartialText`，`151-157`）。
  - **one-shot 后台**：经 `ctx.jobs.start({kind:'subagent', ...})` 变成任务（`402-424`），返回 `{kind:'background', jobId}`；job 的 cancel 桥到 AbortController，`settleStart`（`112-122`）用 `settleRun` 落定。
  - **continuable 后台（默认）**：`ctx.subagents.startContinuable(...)`（`391-400`）返回 `{kind:'continuable', subagentId}`；工具描述明确"后台默认、返回持久子 id、settle 时运行时给父发 notice、`send_message` 在同一子会话续谈"。同时注册一个 prompt 节（`457-468`）指导模型"并行启动独立委托并继续有用工作"。
- 一次性 vs 可续的本质区别写在 `types.ts:243-247`：一次性的 run 是一次可 dispose 的前台委托、一个结果；可续对话没有 run——continuation manager 直接持有子 `AgentHandle`，通过子自己的 inbox 编排每一轮。

### 1.7 控制与回报工具（tool-subagent-control / tool-subagent-report）

- `packages/subagent/tool-subagent-control/src/index.ts`：全局命名的 `send_message`（`26-77`）与 `interrupt_agent`（`79-119`），是 `ctx.subagents.followup()` / `interrupt()` 的薄适配器，不做生命周期路由；`send_message` 用 `CoordinatorMessageSource`（`continuation.ts:58-64`，`relay` 形式）记录来源；`interrupt_agent` 用 `{kind:'ancestor', agent: caller}` 授权（工具不加自己的权威，权威在服务）。此外还有 `list-agents.ts` 的 `list_agents`。
- `packages/subagent/tool-subagent-report/src/index.ts`：`installReportTool`（`49-129`）把子作用域的 `report` 工具与指导节（`117` 顺序）装进每个可续子；`apply`（`136-142`）通过 `ctx.subagents.registerContinuableSetup` 注册。它正是本会话中报告工具的实现（"reporting never ends your turn"等措辞即来自 `57-61`）。

### 1.8 外部后端：ACP / Codex / Claude Code / DSH SDK

进程外后端的共同骨架在 `packages/subagent/subagent/src/out-of-process.ts`：

- `NO_START_CAPABILITIES`（`out-of-process.ts:25-30`）：进程外孩子无法兑现父强制的 start 特性，因此**全部声明为 false**，服务在 start 前拒绝任何需要它们的请求——绝不接受后忽略。
- `settleRunResult`（`156-175`）：seam 契约要求 `result` 发布后**永不 reject**——取消获胜则 `aborted`，传输失败被压平为 `stopReason:'error'`（经 `onError` 诊断槽）。
- `subprocessRunHandle`（`201-215`）：发布进程外 run 句柄（`localAgent: undefined`），`dispose()` 幂等：移除 abort 监听、settle 本地取消、await 后端 teardown 到实际退出。
- cwd 解析纪律（`resolveChildCwd`，`114-120`）：配置覆盖优先，否则继承父会话 workspace cwd，两者皆无则 fail loud——绝不回退到服务器进程的启动目录（一个服务器进程服务多个会话，各有各的 cwd）。

`packages/subagent/subagent-acp/src/index.ts`：

- `AcpProvider`（`index.ts:146-171`）：`capabilities` 全 false、`inheritsParentContext = false`；`start()` 构造 `AcpRunSpec` 并**把 spawn 委托给 `ctx.subprocess.spawn(spec)`**（`index.ts:162`），子失败经 `onError` 压平为 stop reason（`163-167`）。
- 进程机制（spawn、env scrub、树作用域 teardown）属于 `dsh-subprocess` seam（`index.ts:8-9` 注释）；ACP 后端只负责 wire 驱动（`run.ts`）。`run.ts` 细节：`spec.spawn({argv:[command,...args], cwd, stdio:{stdin:'pipe',stdout:'pipe',stderr:'inherit'}, graceMs, env})`（`run.ts:209-215`）；传输为 ACP 协议 NDJSON over stdio（`@agentclientprotocol/sdk` 的 `ClientSideConnection` + `ndJsonStream` 包住 child stdin/stdout，`run.ts:266-272`）；流程 `initialize → newSession({cwd}) → conn.prompt(...)`（`run.ts:295-331`），`sessionUpdate` 里只取 `agent_message_chunk` 文本累积（`run.ts:242-251`），`requestPermission` 按 `PermissionPolicy(allow/reject)` 自动应答（`run.ts:252-263`）；收尾分层 quiesce——stdin EOF（`disposeEofGraceMs` 内等整树退出）→ `terminate()`（SIGTERM→grace→SIGKILL）→ `waitForExit`（`run.ts:114-127`）。`permission` 策略默认 `reject` 所有 `session/request_permission` 提示（`index.ts:47`），env 在父环境"凭据擦除副本"上显式叠加（`index.ts:50-54`）。

其余三个外部后端的传输方式（源码摘要）：

- **subagent-claude-code**（`packages/subagent/subagent-claude-code/src/run.ts` + `process.ts`）：官方 `@anthropic-ai/claude-agent-sdk` 后端。DSH 挂 `spawnClaudeCodeProcess` 钩子，把 SDK 的 `SpawnOptions` 翻译成 `ctx.subprocess.spawn` 的 `SubprocessSpawnSpec`（`process.ts:51-74`；Windows 下 `.cmd/.bat` 走 `cmd.exe /d /v:off /s /c` shim，`process.ts:60-65`），`ManagedClaudeCodeProcess`（`process.ts:80-109`）把共享 handle 的 stdin/stdout/exit 事件投影成 SDK 的 `SpawnedProcess`。结果只消费 SDK 流中 `type==='result' && subtype==='success' && !is_error` 的消息（`run.ts:92-104`）；任务仅允许纯文本块；收尾 `query.close()` + `child.terminate()` + `waitForExit`。
- **subagent-codex**（`packages/subagent/subagent-codex/src/run.ts` + `wire.ts`）：spawn 固定的 `codex app-server --stdio`（win32 走 `cmd.exe /d /s /c` shim，`run.ts:36-42`）经 `spec.spawn`（stdio pipe + stderr inherit，`run.ts:125-131`）；wire 是共享 `JsonRpcLineTransport`（`@deepseek-ai/dsh-sdk-protocol`，逐行 JSON-RPC，`wire.ts:1-13`）上的 `initialize` / `startThread(cwd)` / `runTurn(texts)`，无人值守审批应答（cancel/decline，`wire.ts:31-39`）；取消经 `wire.interrupt()`（`run.ts:150-190`）。
- **subagent-dsh-sdk**（`packages/subagent/subagent-dsh-sdk/src/run.ts`）：**例外**——子进程由 `@deepseek-ai/dsh-sdk-client` 的 `DeepSeekHarness` 自己 spawn（`launch:{command,args,cwd,env,shutdownTimeoutMs,...}`），不经 `ctx.subprocess.spawn`；驱动自行用 `scrubbedParentEnv()` 清洗环境（`run.ts:118-132`）。`harness.start()` 握手 → `harness.session(childSessionId).run(prompt,{onNotification})`，订阅 `session.event` 通知喂给 `AssistantOutputFold`，最后从 `turn/end` 的 reason 映射停止原因（`run.ts:78-92, 165-194`）；dispose 走有界 `shutdown` 交换 + `harness.close()`（`run.ts:196-205`）。

四个后端都从 `request.parent` 只读 cwd（配置覆盖优先），因此天然是"全新会话"（`inheritsParentContext = false`），并全部复用 `out-of-process.ts` 的发布/落定/teardown 骨架（`settleRunResult`/`subprocessRunHandle`）。交叉衔接要点：**只有 ACP/Claude Code/Codex 走 `ctx.subprocess.spawn`**（共享 env 擦除、树级 teardown、`graceMs` 分级宽限），DSH SDK 与 MCP 的 stdio 传输各自用 SDK 自 spawn 并自行清洗。

### 1.9 持久描述符（descriptor）

`packages/subagent/subagent/src/descriptor.ts`：每个会话后端子在其初始轮内追加一次 `subagent/descriptor` 事件（`descriptor.ts:28-39`，log-only、不进 surface、抗压缩），`SUBAGENT_DESCRIPTOR_VERSION = 2`（`47`）。one-shot 只记 `{version, mode:'one-shot', provider, label?}`；continuable 额外记 `agentProvider/agentModel/persona/toolFilter`（`71-83`）供 cold resume 重建组成。`foldSubagentDescriptor`（`308-314`）从持久日志取第一个 descriptor 作为权威；版本不匹配返回 undefined（该孩子本运行时无法分类，`NOT_RESUMABLE`）。

---

## 2. 工作流引擎（ctx.workflowEngine）

### 2.1 seam 与脚本模型

- Service Definition：`packages/workflow/workflow/src/index.ts`。与 bash 一样**每 context 一个引擎实现**（`docs/subsystems/workflow.md:5`——没有命名 provider 注册表，第二个引擎通过插件配置替换第一个，而不是并存）。`WorkflowEngine.start(request): WorkflowRun`（`index.ts:168`）。
- 请求/句柄：`WorkflowStartRequest`（`runtime-types.ts:19-34`）：`script`（纯 JS 体，允许顶层 await，以 `return <json-value>` 结尾）、`meta`（**纯 JSON 数据**，绝不被求值）、`args`、`subagentProvider`（引擎级覆盖，脚本不可观察/不可改）、`maxTotalAgents`、必填 `parent`（脚本起的每个孩子都归属它；cwd/谱系/深度经 subagent seam 传递）、`signal`。`WorkflowRun`（`40-49`）：`result` 永不 reject，`cancel(reason?)`、幂等 `dispose()`。
- meta/脚本分离：`WorkflowMeta`（`types.ts:46-55`：`name/description/whenToUse/phases`，词汇对齐 Claude Code dynamic-workflows）。`meta` 是工具的 `meta` 参数，**脚本体禁止** `export const meta`——worker-thread 引擎在解析前显式拒绝该写法（`workflow-worker-thread/src/index.ts:54-67`）。
- 生命周期事件（`index.ts:36-91`）：`workflow/start`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`（按 `agent.seq` 配对，每个 stop path 恰好一次）、`workflow/end`（**刻意不含结果值**，`WorkflowResultInfo`，`types.ts:118-131`——观察者不得拿到调用方结果值的可变别名）。
- 错误分类：`WorkflowError` + `fatal` 标志（`index.ts:130-139`）+ `isFatalWorkflowError`（`146-148`）驱动组合子纪律：`parallel()`/`pipeline()` 遇到 fatal 错误**必须**杀死脚本（选项拼错、超 cap），而子失败/普通 stage 抛错只把该项化为 `null`。错误码全集 `WorkflowErrorCode`（`108-119`：SCRIPT_PARSE/META_INVALID/AGENT_CAP/ITEM_CAP/RESULT_UNSERIALIZABLE/CANCELLED…）。

### 2.2 worker 侧 hooks：agent()/pipeline()/parallel()/phase()/log()

`packages/workflow/workflow-worker-thread/src/runtime.ts`（`WorkflowExecution`）：

- 构造（`64-114`）：先把 `(async () => { body })()` 包装编译进 `vm.Script`（`lineOffset:-1` 让栈回溯带脚本自身行号），`vm.createContext` 建隔离 realm，再把 hooks 以冻结函数安装为全局（`100-113`）：`agent/parallel/pipeline/phase/log` + 数据全局 `args`。
- **取消语义**：`cancel(reason)`（`146-151`）置 `cancelReason`、拒绝所有等待中的并发槽；此后**每个 hook 入口** `throwIfCancelled`（`133-135`）抛 `CANCELLED`——取消是"下一个 hook 边界"而非仅下一个 `agent()`，脚本在下一次 await 处死亡。
- **agent(prompt, opts)**（`250-345`）：参数校验 → 总 agent 上限（`maxTotalAgents`，`256-261`）→ 计数并 `acquireSlot()`（FIFO 并发槽，`227-247`）→ 经 `children.startAgent` 向 host 发起子 RPC（携带 schema/provider/model 覆盖）→ 拿到 `ChildHandle` 后 `observer.agentStart(info)` → `await run.result`（**reject 视为基础设施故障，AGENT_RESULT fatal**，`303-316`）→ 完成则：有 schema 且 `structured` 缺失 = 子失败返回 null；有 schema 返回 `result.structured`；无 schema 返回 `outputText(result.output)`；非 completed 返回 null（`317-338`）→ `finally` 总是 `await run.dispose()`。每个已开始调用都发射配对 `agentEnd`（含 outcome `completed|failed|cancelled`）。
- **选项白名单**（`readAgentOptions`，`348-398`）：`SUPPORTED_AGENT_OPTIONS = {label, phase, schema, provider, model}`（`39`）；`effort/isolation/agentType` 等 Claude Code 延期选项被**点名拒绝**（`40-41, 370-372`）；`schema` 经 `assertObjectJsonSchema` 收紧到受支持子集（`380-390`，`UNSUPPORTED_SCHEMA`）。
- **parallel(thunks)**（`401-425`）：并发执行所有 thunk 并等待全部（屏障）；thunk 抛错 → `null`，fatal → 整个脚本死。
- **pipeline(items, ...stages)**（`428-458`）：每项独立依次跑完所有 stage（**stage 之间无屏障**），stage 收到 `(prev, item, index)`；普通 stage 抛错把该项丢为 `null` 并跳过其余 stage，fatal 杀死脚本。
- 结果物化：`materializeResult`（`208-220`）把脚本返回值经 `materializeFromRealm`（`realm.ts`）转成**纯 host JSON**，不可序列化 → `RESULT_UNSERIALIZABLE`。`drive()`（`162-187`）永不 reject：任何失败映射为 `cancelled`/`error` 结果。
- 一个"误用即死"的强约定被写进工具描述：`tool-workflow` 的 DESCRIPTION（`tool-workflow/src/index.ts:138-150`）逐条列出 hooks 语义与"Misused hooks … ALWAYS kill the script — they never dissolve into a per-item null"。

### 2.3 worker-thread 后端：每 run 一 worker 的隔离

`packages/workflow/workflow-worker-thread/src/index.ts` + `host.ts`：

- `start()`（`index.ts:143-202`）同步校验（`validateMeta`，`meta.ts:76-82`；`assertBodyParses` 用与 worker 相同的包装做宿主侧解析，保住 `SCRIPT_PARSE` 的同步抛出）→ 解析 provider 路由与 caps → 构造 `WorkerRun`。**关键细节**（`index.ts:170-171` 注释）：在引擎 HMR 卸载前捕获 `runCtx.subagents` 句柄，已返回的 run 仍能起/清子代理（holder-owned 生命周期）。
- `WorkerRun`（`host.ts:102-169`）持有 `Worker`、子注册表、settlement 状态机；`workerSpawnEnv`（`45-57`）给 worker 一个**擦除凭据**的环境（Windows 显式注入 `TMP/TEMP`，未构建形态转发 `TSX_TSCONFIG_PATH`）。
- 双向协议 `protocol.ts`：worker→host（`Ready/Phase/Log/AgentStart/AgentEnd/ChildStart/ChildDispose/Result`）与 host→worker（`Go/Cancel/ChildStarted/ChildStartError/ChildSettled/ChildFailed/ChildDisposed`），payload 全部纯 JSON（structured clone 直达）。`ChildStartRequest` 携带 prompt/schema/provider/model；host 侧 `startChild`（`host.ts:349-412`）调用 `subagents.start(provider, …)`，结果经 `snapshotJsonValue` 无损 JSON 投影后才发回（`390-411`）。
- 结算竞态：`onResult`（`486-516`）"首个终点获胜"；取消跨线程竞速时脚本已 settle 也报 `cancelled`（`507-514`）。worker 死亡（error/messageerror/exit）关闭消息准入（`519-551`），用 `liveAgents` 账本 + `endStrandedAgents`（`578-582`）**合成缺失的 agent-end（outcome 'cancelled'）**，保证"每 started child 恰好一个 end"在每条 stop path 都成立。`cancel()`（`180-204`）armed 一个 unref 的宽限定时器：宽限内未 settle 则强制 settle `cancelled` 并 `worker.terminate()`。`dispose()`（`221-252`）在宽限内等待 result + child 静止，然后无条件 terminate（线程绝不比 run 活得久）。
- 本质隔离：worker 线程防止脚本的同步计算阻塞宿主、允许强制终止；vm context 是"containment 而非安全边界"（`index.ts:3-5` 注释）。脚本内**没有**文件系统/网络/定时器/Node API——"agents do the work, the script only coordinates"。

### 2.4 tool-workflow：模型面向消费者与持久记录

`packages/workflow/tool-workflow/src/index.ts`：

- 注册 `workflow` 工具（`217-334`）与"显式 ask 才用"的 prompt 节（`212-216`）。execute：`ctx.workflowEngine.start({script, meta, args, parent, signal})` → 对顶层调用（`exec.parent === undefined`）用 `createWorkflowRecorder`（`73-131`）把 `workflow/*` 事件投影为父会话的 `tool-workflow/run-start|agent-start|agent-end|run-end` **log-only 事件**（`types.ts:41-63`），UI 与重放从日志读；abort 桥接 `run.cancel('parent step aborted')`；非 completed → `isError`；`finally` 总是 `run.dispose()`。
- 输出渲染封顶：`maxResultChars`（默认 50000）截断 JSON 并注明（`196-203`）。

### 2.5 tool-ralph：fresh-agent 迭代循环（与 tool-workflow 的区别）

`packages/workflow/tool-ralph/src/index.ts`：

- 与普通 workflow 工具的关键区别（工具描述 `179-184`、prompt 节 `407-411`）：**只在直接人类明确要求 Ralph 或 fresh-agent 迭代时用**；每轮打开**无父会话、无先前子会话**的全新子代理；共享 workspace 是长期记忆；只有**有界结构化报告**跨轮；目标**不可变**。
- 实现方式：不是让模型写脚本，而是**部署方固定的一段 `RALPH_SCRIPT`**（`90-177`）——模型只提供 `objective`（和可选的 `maxRounds`）。固定脚本内 `reportSchema` 定义 `{status: 'continue'|'complete'|'blocked', summary, evidence[], nextSteps[], blocker}`（`91-102`），`validateReport` 做规范化校验（continue 必须有 nextSteps 且 blocker 为空；complete 必须有 evidence 且无 nextSteps；blocked 必须有具体 blocker；序列化后 ≤ maxHandoffChars，`112-149`）。循环：`for round…` 每次 `agent(prompt, {label, phase, schema: reportSchema})`，把上一份报告 JSON 作为"Previous structured handoff"注入下一轮 prompt（`154-162`）；`complete`/`blocked`/轮数上限三种终局（`168-176`）。
- `requireFreshProvider`（`220-232`）：Ralph 要求 provider 支持 `outputSchema` **且不继承父上下文**（`inheritsParentContext` 为 false）——fork 型 provider 被拒绝，从结构上保证"fresh"。
- 结果解码是防御性的：`readReport`/`readRunResult`（`247-333`）对跨 provider 边界回来的值做键集合精确匹配 + 规范化复验 + 大小封顶；`round-failed`（子未产出结构化报告）携带最近一次 handoff 呈现（`386-392`）。`maxTotalAgents: maxRounds`（`452`）把循环预算钉进引擎 cap。

---

## 3. 目标体系（ctx.goals）

### 3.1 数据模型与持久化

- 类型（`packages/goal/goal/src/types.ts`）：`GoalId`（branded，`16`）、`GoalRef {id, revision}`（CAS 标识，`19-24`）、`GoalPhase = 'active'|'paused'|'blocked'|'complete'`（`44-48`）、`GoalBlockReason {code, message}`（`51-56`，code 为小写 kebab-case 稳定分类）、`GoalSnapshot extends GoalRef {objective, phase, blockedReason?, maxGoalRounds}`（`59-68`）、`GoalActivation = 'armed'|'disarmed'`（`71`，**进程本地**、从不持久化）、`GoalView extends GoalSnapshot {roundsStarted, createdAt, updatedAt, activation}`（`74-83`）、`GoalProjection`（`91-100`，投影值**刻意不含 activation**——投影只反映持久 phase）。
- 持久化：每次变更 = 一个 `goal/change` 会话事件（`domain.ts:61-68`），载荷是完整 post-change 快照或 clear tombstone（`GoalSnapshotChangeMeta`/`GoalClearChangeMeta`，`domain.ts:24-41`）。严格重放 fold（`fold.ts:134-150+`）逐字段校验（版本、键集合精确匹配、相位合法、轮次正整数）；投影单元（`index.ts:66-113`）是"last-wins 全量值"折叠，供持久化缓存与客户端读取。文档 `docs/subsystems/goal.md:7-9` 确认：CAS 变异精确到 revision，**每次接受的持久变异都递增 revision**；"inbox 变异不影响 goal 状态"（`goal.md:74`）。
- 服务：`GoalService`（`index.ts:183-590`，`TypertRemoteService`，提供远端边界 `@Remote('create')` 等）。每个会话一个 WeakMap 缓存（`191`），`sync`（`437-447`）增量消费事件并用 `pendingActivation` 在**同步 append 边界**上把"意图激活"与持久事件配对：`commit`（`542-558`）先记 `cache.pendingActivation = {seq, activation}`，append 后 sync 时若事件 seq 匹配则采纳该激活意图，否则回退 `'disarmed'`——因此激活状态是进程本地的、可由 session-start 重置（`198-200`），重启后默认 disarmed（符合"resume 需人类再授权"的语义）。

### 3.2 变异与 CAS

- `create`（`index.ts:251-267`）：仅当无当前目标或当前为 `complete` 时允许（否则 `GOAL_ALREADY_EXISTS`）；revision 1、phase `active`、armed。
- `edit/pause/resume/complete/block/clear`（`276-390`）：全部先 `prepareMutation`（assertLive + sync）再 `expectCurrent(cache, ref)`（`401-411`）——ref 不匹配抛 `GOAL_STALE_REVISION`。`resume`（`310-328`）允许 `active|paused|blocked` 三态，但若已 `armed` 或 `roundsStarted >= maxGoalRounds` 则拒绝（轮次预算耗尽必须 `edit` 提高上限再续）。`block` 仅 `active` 可入（`355-368`），记录 `blockedReason` 并 disarm。`clear` 写 tombstone（`376-390`）。
- 事件通知：`goal/changed`（`domain.ts:104-115`）agent-scope 分发，监听者被 containment。

### 3.3 goal-round-driver：自动续跑

`packages/goal/goal-round-driver/src/index.ts`（在公开的 agents/goals/sessions 服务之上实现，不碰内部）：

- 状态：每 Agent 一个 `DriverState`（`38-46`：attempt/competingQueued/needsCheckpoint/requested/run/stopping）。`drive`（`138-205`）的准入 `readyToDrive`（`103-109`）：fiber ACTIVE、未停止、Agent 精确存活且 `idle`、无竞争消息。若需 checkpoint 先 `sessions.flush`（`142-154`）。
- **轮次保留与提交**：`drive` 读 `ctx.goals.get`，要求 `phase==='active' && activation==='armed'` 且 `roundsStarted < maxGoalRounds`（`164-172`；到顶自动 `block('round-limit')`）→ 构造 `<goal_round>` prompt（`prompt.ts:12-26`，带 objective、round/max 与"以 workspace/工具结果/持久会话状态为准"的指示）→ 用 `GoalMessageSource {kind:'goal', goalId, revision, round}`（`domain.ts:47-53`）创建用户消息并 `agent.followup`（`176-204`；排队失败按同一精确状态再 `block('queue-failed')`）。
- **入场防护**（这是"轮次归因"的核心）：`agent/pre-step` 监听器（`349-414`）在下一轮真正进入 step 前用 `validReservation`（`334-347`）核对六项：fiber ACTIVE、attempt 处于 claimed、非 stale、内容/来源与保留记录相同、goal id/revision 与当前一致、phase active 且 armed、`round === roundsStarted+1`。任何不符 → 恢复其它 claimed 消息（`restoreOtherClaimed`，`127-135`）、`{kind:'reject'}` 拒绝该轮；`roundsStarted` 只在被接受的 `user/message`（带 goal 来源）落地时递增——文档 `goal.md:100` 明说"只有这些被接受的 user/message 推进 roundsStarted；重放拒绝非正轮次、缺口、陈旧 revision、停止态、超额"。
- 其它边缘：`agent/status idle` 时若 attempt 被丢弃/取消则 `pause` 该目标（`259-277`）；`agent/error`/`max-tokens` 时 disarm（`246-249, 318-321`）；`goal/changed` 触发重驱动（`278-282`）；teardown 时停止所有 state、disarm、等待 in-flight（`425-443`）。

### 3.4 tool-goal 与执行权威

`packages/goal/tool-goal/src/index.ts` 注册 `get_goal` / `create_goal` / `update_goal` 三个工具（`195-337`）+ 策略 prompt 节（`189-193`，`guidance` 在 `113-123`：get 先于 update、copy 精确 goal_id/revision、resume 需人类措辞等）。权威在 `authority.ts`：

- `goalToolExecution`（`authority.ts:50-63`）：工具必须由**精确活 Agent 在其活动驱动内**调用（registry 身份 + `currentInitiator` 校验）。
- `requireDirectHuman`（`90-93`）：`edit/pause/resume` 要求当前根代理轮内有 `user` 来源消息（`hasDirectHumanInput`，`70-74`）。
- `completionAuthority`（`101-108`）：`complete/blocked` 要么直接人类，要么**当前 goal 的精确已接受轮**（`isMatchingGoalRound`，`77-83`：轮内存在 goal 来源、id/revision/round 全匹配）。`blocked` 在 goal-round 权威下还要求 `roundsStarted >= blockedAfterConsecutiveRounds`（`index.ts:299-306`，默认 3）。命令侧 `command-goal` 提供 `/goal` 人类命令。

---

## 4. Plan mode（ctx.planMode）

`packages/plan/plan-mode/src/index.ts`：

- **状态以 log-only 事件持久化**：`plan/mode {active: boolean}`（`index.ts:53-54`），whole-value replace、绝不进模型 transcript；`foldPlanMode(events, end?)`（`129-138`）"最后一个 wins、无则 false"——resume/fork/compaction 从日志恢复，**无活镜像**；UI 通过 `session/event` 观察已提交翻转（`index.ts:182` 注释）。文档 `docs/subsystems/plan.md:11`。
- **pending 选择与 pre-step append**：`set(agent, active)`（`425-445`）——轮间直接 append；**轮内**（`hasOpenTurn`，`158-165`）则记入 `pendingIntents`（WeakMap，`195`）等待下一个**被接受的 in-turn pre-step**（`205-222`：先 `next()` 拿到决策，`decision.kind==='reject'`/aborted 不动，否则 `onBoundary` append 并可选注入"用户切换模式"的 notice 消息，`448-474`）。append 失败不阻塞轮，选择保留可重试。这是"所有会话事件 turn-enclosed"约束的直接后果。
- **`plan` 投影**（`244-266`）：`{active, pending}` 双事件折叠——`command/run`(plan) 记选择、`plan/mode` 落定并清空，pending 是纯重放量（host 重启/其它 tab/冷读都能从日志恢复）。
- **`/plan [off|message]` 命令**（`269-303`）：bare 进入、`off` 离开、非空消息先进入再 `agent.steer` 提交为下轮普通用户消息。
- **exit_plan_mode 审查弧**（`305-393`）：工具**常驻注册**（plan mode 开关只改 prompt 节，不改工具目录，`67`）；执行要求当前 fold 为 active 且 plan 以 `# ` 开头（`324-329`）；经 **user-questions seam** 发起 `plan-review` 审查（`334-362`，intent `{kind:'plan-review', approve}` 让能渲染决策的 UI 直接呈现；`ASK_CANCELLED` 被转成"用户取回话语权，留在 plan mode 等待"）；`Approve` → 记录**静默**（不叙述）pending exit，`{approved: true}` 返回，plan 指导在本次工具批次剩余部分仍生效，下一被接受 pre-step 落定退出；`Keep planning`/自定义反馈 → 抛错携带反馈（模型修订后再呈现）。审查期间插件被 HMR 卸载则失败并继续 planning（`365-367`）。

---

## 5. 压缩（ctx.compaction）与溢出（ctx.spillStore）

### 5.1 compaction seam 与 compaction/* 事件

- Service Definition：`packages/compaction/compaction/src/index.ts`。`CompactionEngine`（`index.ts:96-171`）三个抽象动词：`compactIfNeeded(agent, trigger, signal)`（自动，trigger 为 `'pressure' | 'context-overflow'`，`index.ts:24-25`）、`compactNow`（显式空闲压缩，`ManualCompactAgentContext.runMaintenance`，`70-79`）、`compactRegion(start, end, agent, signal)`（强制一段）。`CompactionAgentContext` 只依赖 `session` + `options{provider,model}`（`60-63`）——"接口必依赖 session/llm 词汇"是文档 `docs/subsystems/compaction.md:5` 明说的例外。
- 会话事件（`compaction/src/types.ts:16-90`，全部 **log-only、不进 surface**）：
  - `compaction/start {compactionId, sourceCommandId?, turn}`：取锁；`turn` 为数字 = 自动（被该开轮严格包围），`null` = 轮间的独立手工事务；
  - `compaction/summary {…, summary, rawOutput?, llmStreamCall?, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens?, usage?}`：摘要输入/产出/调用信封全部记录，"日志+代码可重构该一次性请求"；
  - `compaction/end {compactionId, turn, error?}`：释放锁，`error` 记录失败尝试；
  - `compaction/prune {shadowedRange, shadowedSeqs, shadowedTokenCount}`：model-free prune 的"影子价格"。
- 锁语义（`compaction-basic/src/region.ts:152-254`）：先 append `compaction/start`（同步相邻），再摘要、`compaction/summary`、随后的 `user/message` 替换（`surfaceOp: {op:'replace', start, end}`，`region.ts:462-465`），最后 `compaction/end`；崩溃留下"无配对的 start"作为可检测孤儿锁（文档 `compaction.md:19`）。稳定性双规则：`assertWholeSurfaceUnchanged` / `assertSelectedSpanStable`（`region.ts:387-424`），摘要后 surface 变了就抛 `SurfaceChangedError`（手工路径归类为 `changed`）。替换的 `user/message` 使用 `compactCheckpointSource`（`checkpoint.ts:19-42`，`{kind:'plugin', plugin:'compact', compactionId}`），消费端可跨后端识别。
- 摘要必须**严格变小**：`summarizeCompaction`（`region.ts:360-384`）用 token meter 估算 framing 后的摘要，不小于被遮蔽内容则拒绝（`374-378`）；`selectCompactableRange`（`98-134`）保留定价尾部 `retainTokens` 且**绝不劈开 assistant 工具调用/结果对**（`toolPairingBalancedBefore`，`124`）。

### 5.2 compaction-basic 的触发时机

`packages/compaction/compaction-basic/src/index.ts`（`BasicCompactionEngine`，`103`）：

- **pre-step 压力**（`_registerAutomaticCompaction`，`147-165`）：每次 `agent/pre-step` 未被 abort 时调 `compactIfNeeded(agent, 'pressure', signal)`，失败仅告警并继续轮（`160-162`）。
- **request-error 溢出恢复**（`179-223`）：`agent/request-error` 且 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE`（`183`）时进入溢出恢复：先跑 model-free prune（若装了 `toolResultPruner`，`281-291`）再选范围压缩；成功（且 surface replaceGeneration 前进）则返回 `{kind:'retry'}` 重试请求（`222`）；按 `maxOverflowRetries` 封顶，`assistant/message` 成功后重置计数（`173-177`）。
- `compactIfNeeded`（`258-332`）：pressure 路径用 `ctx.llm.resolveModelInfo` 拿路由模型 contextWindow 计算 `thresholdTokens`（`293-304`），超阈值 → prune → 重测 → 循环压缩直到低于阈值或 `compactionRetries` 耗尽（`314-326`）。`compactNow`（`368-420`）经 `agent.runMaintenance` 在空闲代理上执行（busy 同步抛 `ManualCompactionError('busy')`）。
- 摘要通过 `summarizeWithLlm`（`summarizer.ts`）直接一次 `ctx.llm.stream()`，前缀复用会话自己的 system/tools/messages（`index.ts:226-246` 注释：不失效 provider KV cache）；`summarize` 是唯一子类定制钩子（`index.ts:95-102`）。

### 5.3 tool-result pruner（单节点替换）

`packages/compaction/compaction-tool-result-pruner/src/index.ts`：`ToolResultPruner`（`44-185`）。`pruneContent`（`83-122`）按 **Unicode code point**（非 UTF-16 单元）做 head/middle/tail 修剪（不劈 surrogate pair），超 `thresholdChars` 才动；`pruneSession`（`136-184`）扫描当前 surface 快照中每个 `tool/result` 节点，超预算者：先 append `compaction/prune` 影子价格事件（`162-166`，用 token meter 估被遮蔽节点），再 `surfaceOp: {op:'replace', start:seq, end:seq}` 追加精简替换（`167-173`）——"计量事件与其替换同步相邻，纯消费端无需逐节点状态即可扣减"（协议注释 `159-161`）。它被 compaction-basic 的 pressure/overflow 两条路径作为**可选先遣 pass** 组合（见 5.2）。

### 5.4 spill：大输出溢出存储

- Service Definition：`packages/spill/spill/src/index.ts`：`SpillStore.saveText(input): Promise<SpillRef>`（`index.ts:45-56`）——**只有这一个动词**；不含保留策略（属 `dsh-output-retention`）、不含替换决策（属 spill-policy）、不含检索 API。类型（`types.ts`）：`SpillOwner {sessionId}`（`37-39`，fork 继承 locator 但不复制/不重新归属）、`SpillSource {toolName, callId, label}`（`46-53`，纯描述性）、`SaveTextSpill`（`56-66`，`suggestedName` 只是提示，后端清洗为单个安全路径段）、`SpillRef {locator, bytes, retrievalHint}`（`69-73`，locator 不透明，消费端按 `retrievalHint` 渲染）。
- 策略：`packages/spill/spill-policy/src/index.ts`：`tools/post-execute` 变换器（`190-209`，prepend 委托 `next()` 后对最终纯文本结果按 `maxInlineBytes` 判定；`read` 工具跳过模型面 arm 防 `read→spill→read` 循环，`196`）+ 持久日志 arm（`tools/code-dispatch-log`，`217-231`，把 `run_code` 子调用的超大副本也压成预览+定位符）。替换 = 头/尾预览 + `TextRetainer` 统计 + spill notice（`spillNotice`，`105-108`），notice 字节预留在 cap 内（`163-187`）保证替换永不超过 cap；**best-effort**：无 owner/无后端/存储失败 → 记日志并保留原内联结果，spill 失败绝不把成功工具调用变成 isError（`157-160`）。
- 本地实现：`packages/spill/spill-local/src/index.ts` 的 `LocalSpillStore` 把内容写到 `<root>/session-<hash>/<random>-<safeName>`（0700 私有根、0600 独占写防符号链接，`index.ts:37-62`），`retrievalHint` 指向 `read`/`grep` 用法。

---

## 6. 技能、任务、会话查询简述

### 6.1 技能（ctx.skills + tool-skill）

- `packages/skill/skill/src/index.ts`：`SkillRegistry`（`357-661`）是"provider 注册表 + 分层合并"的 Service Definition。`SkillProvider {name, list(), get()}`（`248-268`）；注册按**调用 context 的 scope** 分层（`registerProvider`，`391-429`；`ScopedLayers`），读取合并 global 层与视图 scope 链，"最近层同名直胜、rank 只决同层内部"（`557-565`，tools registry 的 shadowing 规则）。`list/snapshot/get`（`471-518`）带 cwd 选择 + abort 传播 + 完成度缓存（`collectCache`，`520-550`）。
- 渲染：`renderSkillContent`（`171-184`）产出统一 `<skill_content>` 块，skill 工具结果与人类显式调用注入共用同一形状；注入上下文带 `skill-invocation` 源（`147-153`）。`tool-skill`（`packages/skill/tool-skill/src/index.ts`）注册 `skill` 加载工具 + 持久会话目录（`skill-catalog` catalog-form 上下文，`index.ts:34-47`——目录条目与模型散文并存，展示端不重解析；模型目录只含可调用 name/description，绝不含 body 或绝对路径）。`skill-filesystem`（`packages/skill/skill-filesystem/src/index.ts`：`ctx.skills.registerProvider` 注册 `FileSystemSkillProvider`，从 bundled/project/custom/user 根发现目录包与扁平 Markdown skill、解析 YAML frontmatter，chokidar 监听 + `fs/observed` 失效，`index.ts:130-143`）、`skill-badge`（`packages/skill/skill-badge/src/index.ts`：内置 provider `'dsh-badge'`，正文打包在 `assets/dsh-badge.md`，`index.ts:23-34`）是具体 provider。

### 6.2 后台任务（ctx.jobs + tool-jobs）

- `packages/jobs/jobs/src/index.ts`：抽象 `JobRegistry`（`62-177`），契约要点：注册/访问按 owner session id 围栏（**授权而非保密**，`index.ts:47-48`）、settlement 首胜（`49-60`）、`start` 拒绝"无 controller 服务的 owner"（`55-60`）、completion 监听 owner 相对、按 scope 分层。`jobs-local`（`packages/jobs/jobs-local/src/index.ts:91+`）是进程内实现（每 owner 并发上限默认 10，`24-27`），记录永不外泄（快照新鲜对象，`index.ts:39`）。类型：`JobStatus = running|stopping|completed|killed|failed`（`types.ts:17`）、`JobStart.run(): JobHooks {cancel, done, readOutput?}`（`46-91`）、`JobSnapshot`（`97-128`，含 `reported` 标记抑制重复完成通知）。
- `tool-jobs`（`packages/jobs/tool-jobs/src/index.ts`）：`job_output/job_list/job_kill` 工具 + 未报告完成通知投递（`wakeup` 唤醒 idle owner 开一轮、`quiet` 注入，`maxConsecutiveWakes` 默认 3 防自激链，`index.ts:29-53, 279-300`）；`job_output` 有界等待，超时返回 `[status: running]` 而非 TOOL_TIMEOUT（`index.ts:330-334`），输出经 `TextRetainer` 截尾/截头。tool-subagent 的 one-shot 后台正是经它实现的（1.6）。

### 6.3 会话查询（ctx.sessionQuery + tool-session-query）

- `packages/session-query/session-query/src/index.ts`：`SessionQueryEngine`（`81-105`，抽象）——精确读/过滤/追踪是后端无关的确定性行为，全文检索由后端实现（`74-79` 注释）；`searchSessions`/`searchEvents`/`readEvents`/`traceEvents` 等（`113-120+`）。`session-query-sqlite`（`packages/session-query/session-query-sqlite/src/query.ts`）提供 SQLite 后端：请求规范化 + 参数化 SQL 谓词构建（`query.ts:100-193`）+ FTS5 全文检索（高亮标记 `\uFDD0/\uFDD1`，绑定数上限 32766，`query.ts:19-56`）。`tool-session-query`（`packages/session-query/tool-session-query/src/index.ts`）注册 `session_search / session_event_search / session_trace / session_event_trace / session_event_read` 模型工具（`index.ts:66-120`），带工作区授权、30s 合作截止、最多 100 条命中与 order 113 的引导段（`index.ts:23-26, 60-64`）。

### 6.4 其它快速浏览项

- context 包：`agent-instructions`（AGENTS.md 兼容工作区指令注入：baseline 指令在首个请求前进入持久上下文，`read/write/edit` 等 fs 工具执行后把新增/变更投影进 inbox，`agent-instructions/src/index.ts:70, 105-120`）；`session-reference`（跨会话快照服务 `ctx.sessionReferenceResolver`，依赖 `ctx.sessionQuery`，把其它会话渲染为 `<referenced-sessions>` 只读不可信 JSON，按 cwd 亲和排序，`session-reference/src/index.ts:42-70`）；`time-context`（可选时钟上下文：`agent/pre-step` 按 `refreshIntervalMs` 追加带来源的时间读数，`time-context/src/index.ts:20-38`）；`tmux-context`（每次 turn 第一步经 `ctx.shell` 跑 `tmux display-message`，并用 `ps -o tty=` 对照 `#{pane_tty}` 确认真实位于 pane 内防 `$TMUX_PANE` 误报，`tmux-context/src/index.ts:49-58, 115-120`）。全部走"prompt section / 会话事件"注入。
- `schedule`（`packages/schedule/schedule/src/index.ts:40-77`）：**无 ctx seam**；只给 `agent/created` 后的根代理装 `ScheduleRuntime`（`index.ts:46`），全部状态来自 `schedule/change` 会话事件——`foldScheduleEvents` 从 `events.slice(seedLength)` 严格重放（重复 id/删不存在 id 抛 `ScheduleLogError`，`domain.ts:575-621`）；到期工作等 Agent 完全空闲后 `queue` 一次 `followup()`，绝不 steer/中断当前轮（best-effort at-least-once，`runtime.ts:35-69`）。
- `message-feedback`（`packages/feedback/message-feedback/src/index.ts` + `spec.ts`）：ctx seam `ctx.messageFeedback`（Service，`index.ts:54-58`），对已定稿 assistant 消息做持久化、生命周期绑定的反馈（rating/note/版本冲突），域定义 `defineDomain({name:'message_feedback', tables:{sessions}})`（`spec.ts:84-90`）。
- `attachment`（`packages/attachment/attachment/src/index.ts` + `attachment-local`）：抽象 seam `ctx.attachments`（`AttachmentStore`，`index.ts:24-34`）——`validateImage/saveImage/saveImages/readImage`，内容寻址 `ImageAttachmentRef`；`attachment-local` 落盘 `<DSH_HOME>/attachments/v1` 并校验 png/jpeg/webp/gif 与像素/字节限额（`attachment-local/src/index.ts:38-73`）。
- `mcp-client`（`packages/mcp/mcp-client/src/index.ts` + `tools.ts`/`transport.ts`/`connection.ts`）：把外部 MCP 服务器的工具注册进 `ctx.tools`，公开名 `mcp__<serverName>__<rawName>`（超长/非法时追加 12 位 SHA-256，`tools.ts:111-117`）；stdio 走官方 SDK `StdioClientTransport`（SDK 自 spawn，**不经 ctx.subprocess**，`transport.ts:31-34`），图片 content 经 `ctx.attachments` 持久化（`tools.ts:21-22`）；`connection.ts` 提供指数退避重连 supervisor（`connection.ts:114+`）。

---

## 7. 设计哲学观察

1. **一切能力都是"seam + tool consumer"**：每个能力都有一个 Service Definition 包定义契约与事件、1..N 个 Provider 包实现、1..N 个 `tool-*`/`command-*` 消费者包把它变成模型/人类可调用的表面。文档页（`docs/subsystems/subagent.md:7`、`workflow.md:7`、`compaction.md:5`）都显式列这三类角色。收益：引擎可整体替换（worker-thread workflow 换掉只动 Provider）、能力可选加载（`plan-mode` 可选、`tool-skill` 可选）、HMR 安全（注册都 effect 作用域）。
2. **子代理与工作流复用同一套 `ctx.subagents` + `ctx.subprocess`**：workflow 的 worker 侧不直接碰 Agent——host 侧 `startChild` 调 `ctx.subagents.start`（`host.ts:352`），每个 `agent()` 就是一个子代理 run；外部后端（ACP/Codex/Claude Code/DSH SDK）复用 `ctx.subprocess` 的 spawn/env 擦除/树 teardown。深度、谱系、策略种子都在 `child-agent.ts` 一处。
3. **"模型可见 ⟺ 可重放"原则的例证**（可逐条举例）：
   - plan 状态 `plan/mode` 纯日志折叠，UI 无活镜像（`plan-mode/index.ts:129-138`）；
   - todo 列表 `todo/write` 整表替换 + `todos` 投影（`tool-todo/index.ts:135-148`，`turn/start` 清空显示）；
   - goal 全部状态来自 `goal/change` 严格重放（`fold.ts`），激活是进程本地附加量（`types.ts:71`）；
   - compaction 的锁/摘要/影子价格都是 log-only 事件，崩溃后靠"未配对 start"检测（`region.ts:152-254`）；
   - workflow 的运行记录是父会话的 `tool-workflow/*` log-only 事件（`tool-workflow/types.ts:41-63`）；
   - subagent 的持久身份是子日志里的 `subagent/descriptor`（`descriptor.ts`），cold resume 只需日志 + 代码。
4. **fail loud 的多个层次**：能力校验在 start/mount 就做（subagent `assertCapabilities`）、脚本误用在 worker 内"必死"（workflow fatal）、配置错误在加载失败而非首次调用失败（spill-policy 的 cap 校验 `spill-policy/index.ts:116-119`、tool-subagent 挂载期能力检查）、跨 realm 边界回来的数据被防御性复验（ralph 的 `readReport`、workflow 的 `materializeFromRealm`）。
5. **所有权与取消纪律**：run/job/goal/worker 都有明确的 holder-owned 生命周期：`result` 永不 reject、dispose 幂等、信号只拥有到"接收/发布"边界（subagent inbox acceptance、job start preflight、goal commit 的同步 append）。worker 线程"绝不比 run 活得久"（`host.ts:244`）。
6. **文档自述的设计原句**（可直接引用）：
   - `docs/subsystems/subagent.md:19-21`："a request that needs a capability the chosen provider lacks is rejected with a typed error rather than accepted-then-ignored (the 'fail loud, no silent degradation' rule)"——响亮失败、绝不静默降级；
   - `docs/subsystems/jobs.md:176`："Owned-job access is fenced by the owner's session id. Ids are predictable, so authorization — not secrecy — is the boundary"——授权而非保密是边界；
   - `docs/subsystems/workflow.md:116`："a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure"——拼错选项必须响亮杀死脚本，绝不消融为普通子失败；
   - `docs/subsystems/plan.md:11`："the state in force is always a pure fold of the session log, so resume, fork, and compaction recover it with no live mirror"——生效状态永远是日志纯折叠，无活镜像即可恢复；
   - `docs/subsystems/goal.md:21`："The durable phase answers what happened to the objective. Process-local activation separately answers whether a continuation consumer may start another round"——持久 phase 与进程内激活分离；
   - `docs/subsystems/subagent.md:268-271`：`ContinuableCreateSpec` "is DATA, never a capability… because the continuation manager owns the child's whole lifecycle after preparation"——Provider 的创建规格只是数据而非能力。

---

## 8. 关键代码摘录（5 段）

### 摘录 1：SubagentProvider 契约 + start 能力校验（一次性委托的门禁）

`packages/subagent/subagent/src/types.ts:285-307` 与 `packages/subagent/subagent/src/index.ts:481-496`：

```ts
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}

// index.ts:481-496 —— 请求需要而 provider 不支持的，start 前响亮拒绝
private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
  const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
    { when: request.outputSchema !== undefined, cap: 'outputSchema' },
    { when: request.maxDepth !== undefined, cap: 'depthLimit' },
    { when: request.toolFilter !== undefined, cap: 'toolFilter' },
    { when: request.persona !== undefined, cap: 'persona' },
  ]
  for (const { when, cap } of needs) {
    if (when && !provider.capabilities[cap]) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support the "${cap}" capability`,
        'UNSUPPORTED_CAPABILITY',
      )
    }
  }
}
```

### 摘录 2：followup 的驻留路由与 cold resume（可续对话的核心）

`packages/subagent/subagent/src/continuation.ts:476-505`（路由）与 `883-912`（冷恢复授权/折叠）：

```ts
async followup(parent, childId, content, options): Promise<MessageId> {
  this.assertAdmitting(parent)
  while (true) {
    const live = await this.locks.run(childId, async () => {
      const activation = this.activations.get(childId)
      if (activation === undefined) return this.coldResume(parent, childId, content, options)
      if (activation.disposal !== undefined) {
        return activation.disposal.then(() => undefined, () => undefined)
      }
      return this.submitAdmitted(activation, content, options.source, parent, options.signal)
    })
    if (live !== undefined) return live
    this.assertAdmitting(parent)
    options.signal.throwIfAborted()
  }
}
// coldResume：inspect → 授权持久化 header 的直接父 → 只 fold 子自己的后缀 → agents.resume
const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))
if (descriptor === undefined || descriptor.mode !== 'continuable') {
  throw new SubagentError(/* NOT_RESUMABLE */)
}
activation = await this.materialize({ childId, provider: descriptor.provider, parent, ... })
return this.submitMaterialized(activation, content, options.source, parent, options.signal)
```

### 摘录 3：workflow worker 的 agent() hook 与组合子纪律

`packages/workflow/workflow-worker-thread/src/runtime.ts:250-262, 317-341`（agent 结算）与 `401-425`（parallel）：

```ts
if (result.stopReason === 'completed') {
  if (opts.schema !== undefined) {
    if (result.structured === undefined) {
      this.observer.agentEnd({ ...info, outcome: 'failed' }); return null
    }
    this.observer.agentEnd({ ...info, outcome: 'completed' })
    return result.structured
  }
  this.observer.agentEnd({ ...info, outcome: 'completed' })
  return outputText(result.output)
}
if (this.isCancelled()) {
  this.observer.agentEnd({ ...info, outcome: 'cancelled' })
  throw this.cancelledError()
}
this.observer.agentEnd({ ...info, outcome: 'failed' })
return null

// parallel：thunk 抛错 → null；fatal → 整个脚本死
return Promise.all(rawThunks.map(async (thunk) => {
  try { return await thunk() } catch (error) {
    if (isFatalWorkflowError(error)) throw error
    return null
  }
}))
```

### 摘录 4：compaction 事务（锁 → 摘要 → 替换 → 解锁）

`packages/compaction/compaction-basic/src/region.ts:189-229`：

```ts
const startEvent = session.append('compaction/start', lifecycle)
try {
  const prepared = prepareCompaction(dependencies, session, selection)
  const summarized = await summarizeCompaction(dependencies, prepared, agent, compactionId, options.sourceCommandId, signal)
  assertStable(dependencies, session, summarized)
  stage = 'commit'
  const pending = commitCompactionBody(session, startEvent, summarized)   // compaction/summary + user/message replace
  closing = true
  const endEvent = session.append('compaction/end', lifecycle)
  closed = true
  result = completeCompaction(pending, endEvent)
} catch (error) {
  failure = { error, stage: closing ? 'commit' : stage }
  if (!closing) {
    closing = true
    try { session.append('compaction/end', { ...lifecycle, error: errorChain(error) }); closed = true }
    catch (closeError) { failure = { error: closeError, stage: 'commit' } }
  }
}
if (closed && options.flush !== undefined) { try { await options.flush() } catch (e) { flushFailure = e } }
```

### 摘录 5：goal 的同步 append 边界 + round driver 的轮次保留

`packages/goal/goal/src/index.ts:542-558`（提交）与 `packages/goal/goal-round-driver/src/index.ts:164-192`（轮次保留）：

```ts
// GoalService.commit：append 前记录"意图激活"，sync 时按 seq 配对
cache.pendingActivation = { seq: agent.session.seq, activation }
try { agent.session.append('goal/change', change); this.sync(agent.session, cache) }
finally { cache.pendingActivation = undefined }
// agentEvents(this.ctx, agent).emit('goal/changed', { change: notification })

// goal-round-driver.drive：armed + active + 预算内才保留下一轮
const goal = currentGoal(state)
if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
if (goal.roundsStarted >= goal.maxGoalRounds) {
  ctx.goals.block(agent, goalRef(goal), { code: 'round-limit', message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.` })
  return
}
const round = goal.roundsStarted + 1
const message = createUserMessage({ content: renderGoalRoundPrompt(goal, round),
  source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round } })
state.attempt = { goalId: goal.id, revision: goal.revision, round, messageId: message.id, content, phase: 'queued', cancelled: false, stale: false }
agent.followup(message)
```

---

## 附：阅读索引（主要源码文件）

- 子代理核心：`packages/subagent/subagent/src/{index,types,continuation,lifecycle,child-agent,descriptor,out-of-process}.ts`
- 进程内后端：`packages/subagent/subagent-{spawn,fork}-in-process/src/index.ts`、`packages/subagent/subagent-in-process-driver/src/{index,structured}.ts`
- 进程外后端：`packages/subagent/subagent-{acp,codex,claude-code,dsh-sdk}/src/`
- 子代理工具：`packages/subagent/tool-subagent/src/index.ts`、`tool-subagent-{control,report}/src/index.ts`
- 工作流：`packages/workflow/workflow/src/{index,types,runtime-types}.ts`、`workflow-worker-thread/src/{index,host,runtime,protocol,meta,realm,worker,session,types}.ts`、`packages/workflow/{tool-workflow,tool-ralph}/src/index.ts`
- 目标：`packages/goal/goal/src/{index,types,domain,fold,runtime,projection}.ts`、`goal-round-driver/src/{index,prompt}.ts`、`tool-goal/src/{index,authority,wrapup}.ts`、`command-goal/src/index.ts`
- Plan：`packages/plan/plan-mode/src/{index,types,client}.ts`
- Todo：`packages/todo/tool-todo/src/index.ts`
- 技能：`packages/skill/{skill,tool-skill,skill-filesystem,skill-badge}/src/`
- 任务：`packages/jobs/{jobs,jobs-local,tool-jobs}/src/`
- 压缩：`packages/compaction/{compaction,compaction-basic,compaction-tool-result-pruner,command-compact}/src/`
- 溢出：`packages/spill/{spill,spill-local,spill-policy}/src/`
- 会话查询：`packages/session-query/{session-query,session-query-sqlite,tool-session-query}/src/`
- 上下文/杂项：`packages/context/*/src/`、`packages/schedule/schedule/src/`、`packages/feedback/message-feedback/src/`、`packages/attachment/{attachment,attachment-local}/src/`、`packages/mcp/mcp-client/src/`
- 文档：`docs/subsystems/{subagent,workflow,goal,plan,skills,jobs,compaction,spill,session-query,schedule}.md`
