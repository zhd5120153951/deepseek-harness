# DeepSeek Harness `141eb6fef83422698aef7a981029e843e8161534`：代码阅读手册

> 分析基线：commit `141eb6fef83422698aef7a981029e843e8161534`（`dsh@0.1.0-rc.8`）。
>
> 本手册把官方仓库在该 commit 的架构文档、Capability Seams、Tool Execution Pipeline、生成的 Module Graph、Package README 与可直接访问的源码目录树统一整理。GitHub 页面确认该 commit 对应 release PR `#2783` / `dsh@0.1.0-rc.8`，当时涉及 229 个文件变更。
>
> **重要范围说明**：该仓库规模较大。当前环境无法把 GitHub 的完整 blob 历史一次性克隆到本地，因此本手册以“精确 commit + 官方生成依赖图 + 包/目录树 + 核心源码目录”为基础，做到核心链路的文件级分析和全包级分析；对无法直接打开的超多叶子测试/辅助文件，采用“目录级索引 + 作用边界”而不虚构具体函数实现。

## 0. 这份手册如何阅读

建议按以下顺序阅读：

1. **先读 AgentLoop → Session → Tool → LLM 的主链**。
2. 再读 Cordis Context / Capability Seam，理解为什么这些模块可以替换。
3. 再读 `packages/*` 的 Service Definition / Provider / Consumer 三层。
4. 最后读 Host / Client / SDK / ACP / Workflow / Subagent 等外围产品能力。

## 1. 精确 commit 结论

该 commit 位于 `dsh@0.1.0-rc.8` release merge，GitHub 页面显示 commit `141eb6f`，父提交为 `b862725` 与 `f1f7dc3`。仓库当时已经形成高度模块化的 `packages/<group>/<package>` 体系。

顶层组织包括：`.agents/`、`.claude/`、`.github/`、`apps/`、`docs/`、`examples/`、`native/`、`packages/`、`patches/`、`python/`、`scripts/`、`vendor/`、`website/`。

仓库 README 在这一版本明确将 Harness 定位为：**Everything is a Plugin**；同时标注为 Developer Preview，并警告未来可能存在兼容性破坏变更。

## 2. 顶层架构

```text
                   Cordis Root Context
                           │
        ┌──────────────────┼───────────────────┐
        │                  │                   │
      Service            Event              Effect
        │                  │                   │
        ▼                  ▼                   ▼
  Capability Seam      Waterfall          Scoped Fiber
        │
        ├── ctx.agents
        ├── ctx.sessions
        ├── ctx.llm
        ├── ctx.tools
        ├── ctx.systemPrompt
        ├── ctx.fs
        ├── ctx.sandbox
        ├── ctx.jobs
        ├── ctx.workflowEngine
        ├── ctx.clientModules
        └── ...
```

## 3. 最重要的设计原则

- Service Definition 与 Concrete Provider 解耦。
- Agent Loop 本身也是插件，不是硬编码在全局 main 里的核心。
- Session 是事件溯源事实源，模型消息历史从 Session 派生。
- Tool 执行有独立流水线：pre-execute → guard → approval → execute → post-execute → finalize → result。
- Scoped Context/Fiber 用于让 Agent 实例拥有局部注册和精确 teardown。
- Provider 通过 `ctx.effect()`、`ctx.on()`、`ctx.waterfall()` 等机制注册能力，卸载时自动反向清理。
- 前端 Client 也采用插件化：Shell / Modules / UI plugins / Slots。
- 生产能力依赖 Service Definition，而不是依赖某一个 provider 的内部类。

## 4. 完整调用链：AgentLoop → Session → Tool → LLM → Context/Cordis → Plugin

### 4.1 入口

```text
CLI / Web / SDK / ACP
        │
        ▼
boot / host / api / sdk / acp
        │
        ▼
Cordis root Context
        │
        ├── load bundles/profiles
        ├── mount plugins
        └── enter service graph
        │
        ▼
ctx.agents.create / ctx.agentLoop.create
        │
        ▼
AgentLoop
        │
        ├── Session 创建/恢复
        ├── System Prompt 组装
        ├── LLM prepareCall
        ├── llm/stream
        ├── 解析 assistant content + tool calls
        ├── Tool pipeline
        ├── 写回 Session
        └── 下一 step / 下一 turn
```

### 4.2 Agent 创建阶段

- caller 通过 `ctx.agents.create({sessionId, ...})` 或 `ctx.agentLoop.create()` 发起创建。
- AgentLoop provider 构造私有 Session、具体 Agent Driver 和 scoped Context。
- setup 在对象尚未公开前运行，因此 setup 不能驱动一个尚未发布的 Agent。
- Session 与 Agent 共享同一个调用方决定的 SessionId。
- 注册过程通过 enter() 进行仲裁；同 ID 并发创建失败的一方必须回滚自己的私有资源。
- 发布顺序包含 `session/created`、`agent/created`、`agent/session-start`，随后才开始 driver。
- teardown 顺序遵循 stop/drain → scope unwind → agent detach → session detach。

### 4.3 一次 request / turn / step

```text
Agent.send / request
      │
      ▼
打开/恢复 Turn
      │
      ▼
claim next-step + next-turn input
      │
      ▼
agent/pre-step
      │
      ▼
assembleContextFor(agent)
      │
      ├── systemPrompt
      ├── session-derived history
      ├── tools schema
      └── contextual plugins
      │
      ▼
ctx.llm.prepareCall()
      │
      ▼
llm/stream
      │
      ├── assistant chunks
      ├── reasoning chunks
      └── tool-call blocks
      │
      ├───────────────┐
      │               │
      ▼               ▼
message stream     tool call
                      │
                      ▼
               ctx.tools pipeline
                      │
                      ▼
                 tool result
                      │
                      └────→ next step
      │
      ▼
assistant/message completion anchor
      │
      ▼
Session append
```

### 4.4 Tool 执行完整链

```text
assistant tool-call block
        │
        ▼
Session: tool/call
        │
        ▼
UI pending card
        │
        ▼
tools/pre-execute
        │
        ▼
registered monotonic guards
        │
        ├── deny/abstain ─────→ skip body
        │
        └── allow
             │
             ▼
ctx.approval
             │
             ├── refused ─────→ denied
             │
             └── approved
                  │
                  ▼
             tools/execute
                  │
                  ▼
             executor
                  │
                  ▼
             tools/post-execute
                  │
                  ▼
             finalizeContent
                  │
                  ▼
             tools/result
                  │
                  ▼
             Session / derived history
```

### 4.5 Tool 与 Session 的关系

工具调用不是一个孤立 promise。Harness 首先把 `tool/call` 作为 Session 事件记录，再推进执行流水线；这样 UI、审计、重放、derived history、后续 session-query 都可以以同一个事件事实源为依据。

### 4.6 Tool 与 LLM 的关系

LLM 不直接执行任何本地动作。LLM 只是生成结构化 tool-call proposal；`dsh-tools` 再根据 Tool Definition、guard、approval、execute/post-execute 等规则，把 proposal 变成真正执行。

### 4.7 LLM 与 Context 的关系

每个 step 的 model-visible context 都是动态组装的，而不是永久字符串。系统提示、工作区指令、时间上下文、文件引用、Tool schema、Agent persona 等通过插件向 `ctx.systemPrompt` / `ctx` 注册并在 step 边界装配。

### 4.8 Context/Cordis 与 Plugin 的关系

Cordis Context 是整个 Harness 的运行时“脊柱”。插件挂载到 Context 上，可以提供 Service、事件监听器、waterfall、effects 和 scoped registrations。插件卸载时，依靠 effect 的逆操作和 scoped fiber 做资源回收。

## 5. Package 依赖图总览

### 5.1 依赖分层

```text
util
  ↓
service definitions / protocol / brand / invariants
  ↓
core spine
  ├── agent
  ├── session
  ├── tools
  ├── system-prompt
  └── agent-loop
  ↓
capability providers
  ├── llm
  ├── fs
  ├── sandbox
  ├── shell
  ├── subprocess
  ├── jobs
  ├── web
  ├── workflow
  ├── subagent
  └── ...
  ↓
composition / host / client / SDK
```

### 5.2 官方生成 Module Graph 的规则

仓库的 `docs/module-graph.md` 明确说明：包之间的 canonical runtime dependency signal 是 `peerDependencies`，并按 `packages/<group>/<pkg>` 分组生成图。扩展插件依赖 Service Definition，而不是 concrete provider；`dsh-agent-loop` 可替换；UI/hook/tool 插件通过 `dsh-agent` 等接口编程。

### 5.3 最重要的核心边

- `agent-loop → agent`：agent-loop 在运行时直接依赖 agent 的服务/协议边界。
- `agent-loop → llm`：agent-loop 在运行时直接依赖 llm 的服务/协议边界。
- `agent-loop → session`：agent-loop 在运行时直接依赖 session 的服务/协议边界。
- `agent-loop → tools`：agent-loop 在运行时直接依赖 tools 的服务/协议边界。
- `agent-loop → system-prompt`：agent-loop 在运行时直接依赖 system-prompt 的服务/协议边界。
- `agent-loop → settings`：agent-loop 在运行时直接依赖 settings 的服务/协议边界。
- `agent → llm`：agent 在运行时直接依赖 llm 的服务/协议边界。
- `agent → session`：agent 在运行时直接依赖 session 的服务/协议边界。
- `agent → system-prompt`：agent 在运行时直接依赖 system-prompt 的服务/协议边界。
- `session → llm`：session 在运行时直接依赖 llm 的服务/协议边界。
- `tools → llm`：tools 在运行时直接依赖 llm 的服务/协议边界。
- `tools → session`：tools 在运行时直接依赖 session 的服务/协议边界。
- `llm-deepseek → llm`：llm-deepseek 在运行时直接依赖 llm 的服务/协议边界。
- `llm-deepseek → credentials`：llm-deepseek 在运行时直接依赖 credentials 的服务/协议边界。
- `llm-deepseek → settings`：llm-deepseek 在运行时直接依赖 settings 的服务/协议边界。
- `llm-retry → llm`：llm-retry 在运行时直接依赖 llm 的服务/协议边界。
- `llm-retry → session`：llm-retry 在运行时直接依赖 session 的服务/协议边界。
- `tool-fs → fs`：tool-fs 在运行时直接依赖 fs 的服务/协议边界。
- `tool-fs → tools`：tool-fs 在运行时直接依赖 tools 的服务/协议边界。
- `tool-fs → session`：tool-fs 在运行时直接依赖 session 的服务/协议边界。
- `tool-fs → sandbox`：tool-fs 在运行时直接依赖 sandbox 的服务/协议边界。
- `tool-fs → user-approval`：tool-fs 在运行时直接依赖 user-approval 的服务/协议边界。
- `subagent → agent`：subagent 在运行时直接依赖 agent 的服务/协议边界。
- `subagent → session`：subagent 在运行时直接依赖 session 的服务/协议边界。
- `subagent → jobs`：subagent 在运行时直接依赖 jobs 的服务/协议边界。
- `subagent → tools`：subagent 在运行时直接依赖 tools 的服务/协议边界。
- `workflow → session`：workflow 在运行时直接依赖 session 的服务/协议边界。
- `workflow → agent`：workflow 在运行时直接依赖 agent 的服务/协议边界。

## 6. 全 Package 代码阅读目录

本手册按生成 Module Graph 组织，共整理约 **215 个命名 package**。

### 6.1 已直接核验的关键源码文件

#### `packages/core/agent-loop/src`
- `agent.ts` — Concrete AgentLoop driver；负责生命周期、turn/step orchestration、inbox claim、LLM dispatch、tool group 驱动与终态 anchor。
- `constants.ts` — AgentLoop 内部常量/默认值/事件或状态辅助定义。
- `index.ts` — 包公开入口；导出 Service Definition、配置和对外契约，不向外泄漏内部 driver 实现。
- `invariant.ts` — 可选 invariants companion；把 AgentLoop 的请求重建/状态约束接入 runtime diagnostics。
- `runtime-context.ts` — 运行时上下文类型/局部状态结构，供 driver orchestration 使用。
- `tool-calls.ts` — 工具调用组、并行池、工具调用调度相关的 loop-local helpers。

#### `packages/core/agent/src`
- `consumed-work.ts` — 描述/跟踪 Agent 一次 dispatch 已消费的工作单元。
- `dispatch.ts` — Agent handle 的消息/请求 dispatch 边界；将调用方动作送入 loop-owned execution。
- `inbox.ts` — next-step / next-turn FIFO inbox；管理插入、claim、splice、cancel 与 MessageId 唯一性。
- `index.ts` — Agent public interface、registry、service definition 与 event vocabulary 的公开入口。
- `invariant.ts` — 可选 Agent 状态 transition invariant companion。
- `model-selection.ts` — session-local provider/model selection contract。
- `runtime-types.ts` — 运行时协作类型。
- `types.ts` — Agent-facing public types/options/handles。

# 7.1 `packages/core` 深入分析

> 这一组共 8 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.1.1 `@deepseek-ai/dsh-agent`

**职责摘要**：Agent interface, registry, initiator scope, and agent event vocabulary。

### 设计位置
- 层次：核心控制脊柱
- 包路径：`packages/core/agent`
- NPM scope：`@deepseek-ai/dsh-agent`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Agent interface, registry, initiator scope, and agent event vocabulary，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- Agent 是对外公共契约；Loop 是实现。UI、hooks、orchestrator 通过 Agent handle 编程。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
caller
  ↓
Agent handle
  ↓
loop runtime
  ↓
Session + LLM + Tools
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.1.2 `@deepseek-ai/dsh-agent-default-model`

**职责摘要**：Deployment default provider/model selection for Agent entry points。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/core/agent-default-model`
- NPM scope：`@deepseek-ai/dsh-agent-default-model`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Deployment default provider/model selection for Agent entry points，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.1.3 `@deepseek-ai/dsh-agent-loop`

**职责摘要**：Concrete default agent driver and turn/step loop。

### 设计位置
- 层次：核心控制脊柱
- 包路径：`packages/core/agent-loop`
- NPM scope：`@deepseek-ai/dsh-agent-loop`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Concrete default agent driver and turn/step loop，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 这是默认 concrete loop driver 所在包。其他插件不应通过内部类直接控制它，而应依赖 `Agent`/`AgentLoop` seam。
- 它负责把 Session、System Prompt、LLM、Tools 串成 turn/step 生命周期。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
caller
  ↓
Agent handle
  ↓
loop runtime
  ↓
Session + LLM + Tools
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.1.4 `@deepseek-ai/dsh-agent-tool-presentation`

**职责摘要**：Tool presentation/formatting bridge for model/UI surfaces。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/core/agent-tool-presentation`
- NPM scope：`@deepseek-ai/dsh-agent-tool-presentation`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Tool presentation/formatting bridge for model/UI surfaces，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.1.5 `@deepseek-ai/dsh-scope`

**职责摘要**：Scoped Cordis context primitive used for agent-local registration。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/core/scope`
- NPM scope：`@deepseek-ai/dsh-scope`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Scoped Cordis context primitive used for agent-local registration，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.1.6 `@deepseek-ai/dsh-session`

**职责摘要**：Event-sourced in-memory session log and message-surface projection。

### 设计位置
- 层次：核心控制脊柱
- 包路径：`packages/core/session`
- NPM scope：`@deepseek-ai/dsh-session`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Event-sourced in-memory session log and message-surface projection，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- Loop 的所有 durable/observable 事实最终要经过 Session；消息历史是 derived view，而不是另一份独立事实源。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
agent event
  ↓
append-only Session log
  ↓
surface/projection
  ↓
derived messages / query
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.1.7 `@deepseek-ai/dsh-system-prompt`

**职责摘要**：System-prompt assembly registry and deployment identity/persona。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/core/system-prompt`
- NPM scope：`@deepseek-ai/dsh-system-prompt`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- System-prompt assembly registry and deployment identity/persona，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.1.8 `@deepseek-ai/dsh-tools`

**职责摘要**：Scoped tool registry and tool execution pipeline。

### 设计位置
- 层次：核心控制脊柱
- 包路径：`packages/core/tools`
- NPM scope：`@deepseek-ai/dsh-tools`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Scoped tool registry and tool execution pipeline，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.2 `packages/llm` 深入分析

> 这一组共 5 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.2.1 `@deepseek-ai/dsh-llm`

**职责摘要**：Abstract LLM capability/service definition and request/stream contracts。

### 设计位置
- 层次：模型能力/模型适配层
- 包路径：`packages/llm/llm`
- NPM scope：`@deepseek-ai/dsh-llm`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Abstract LLM capability/service definition and request/stream contracts，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- AgentLoop 在每个 step 通过 `ctx.llm.prepareCall()` 和最终 dispatch 访问 LLM seam。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
AgentLoop request
  ↓
ctx.llm
  ↓
provider adapter
  ↓
stream chunks
  ↓
assistant / tool-call events
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.2.2 `@deepseek-ai/dsh-llm-deepseek`

**职责摘要**：DeepSeek provider adapter。

### 设计位置
- 层次：模型能力/模型适配层
- 包路径：`packages/llm/llm-deepseek`
- NPM scope：`@deepseek-ai/dsh-llm-deepseek`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- DeepSeek provider adapter，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- AgentLoop 在每个 step 通过 `ctx.llm.prepareCall()` 和最终 dispatch 访问 LLM seam。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
AgentLoop request
  ↓
ctx.llm
  ↓
provider adapter
  ↓
stream chunks
  ↓
assistant / tool-call events
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.2.3 `@deepseek-ai/dsh-llm-pi-ai`

**职责摘要**：Pi AI provider adapter/bridge。

### 设计位置
- 层次：模型能力/模型适配层
- 包路径：`packages/llm/llm-pi-ai`
- NPM scope：`@deepseek-ai/dsh-llm-pi-ai`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Pi AI provider adapter/bridge，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- AgentLoop 在每个 step 通过 `ctx.llm.prepareCall()` 和最终 dispatch 访问 LLM seam。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
AgentLoop request
  ↓
ctx.llm
  ↓
provider adapter
  ↓
stream chunks
  ↓
assistant / tool-call events
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.2.4 `@deepseek-ai/dsh-llm-retry`

**职责摘要**：LLM retry policy/provider middleware。

### 设计位置
- 层次：模型能力/模型适配层
- 包路径：`packages/llm/llm-retry`
- NPM scope：`@deepseek-ai/dsh-llm-retry`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- LLM retry policy/provider middleware，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- AgentLoop 在每个 step 通过 `ctx.llm.prepareCall()` 和最终 dispatch 访问 LLM seam。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
AgentLoop request
  ↓
ctx.llm
  ↓
provider adapter
  ↓
stream chunks
  ↓
assistant / tool-call events
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.2.5 `@deepseek-ai/dsh-token-meter`

**职责摘要**：Token accounting/replay measurement support。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/llm/token-meter`
- NPM scope：`@deepseek-ai/dsh-token-meter`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Token accounting/replay measurement support，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- AgentLoop 在每个 step 通过 `ctx.llm.prepareCall()` 和最终 dispatch 访问 LLM seam。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
AgentLoop request
  ↓
ctx.llm
  ↓
provider adapter
  ↓
stream chunks
  ↓
assistant / tool-call events
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.3 `packages/goal` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.3.1 `@deepseek-ai/dsh-command-goal`

**职责摘要**：Goal command/control operations。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/goal/command-goal`
- NPM scope：`@deepseek-ai/dsh-command-goal`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Goal command/control operations，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.3.2 `@deepseek-ai/dsh-goal`

**职责摘要**：Same-session goal persistence/lifecycle。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/goal/goal`
- NPM scope：`@deepseek-ai/dsh-goal`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Same-session goal persistence/lifecycle，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.3.3 `@deepseek-ai/dsh-goal-round-driver`

**职责摘要**：Goal round execution driver。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/goal/goal-round-driver`
- NPM scope：`@deepseek-ai/dsh-goal-round-driver`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Goal round execution driver，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.3.4 `@deepseek-ai/dsh-tool-goal`

**职责摘要**：Model-facing goal tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/goal/tool-goal`
- NPM scope：`@deepseek-ai/dsh-tool-goal`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing goal tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.4 `packages/fs` 深入分析

> 这一组共 7 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.4.1 `@deepseek-ai/dsh-fs`

**职责摘要**：Filesystem capability/service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/fs/fs`
- NPM scope：`@deepseek-ai/dsh-fs`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Filesystem capability/service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.4.2 `@deepseek-ai/dsh-fs-local`

**职责摘要**：Local filesystem provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/fs/fs-local`
- NPM scope：`@deepseek-ai/dsh-fs-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local filesystem provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.4.3 `@deepseek-ai/dsh-fs-observation-policy`

**职责摘要**：Filesystem observation/discovery policy。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/fs/fs-observation-policy`
- NPM scope：`@deepseek-ai/dsh-fs-observation-policy`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Filesystem observation/discovery policy，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.4.4 `@deepseek-ai/dsh-fs-sandbox`

**职责摘要**：Filesystem provider bridged to sandbox。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/fs/fs-sandbox`
- NPM scope：`@deepseek-ai/dsh-fs-sandbox`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Filesystem provider bridged to sandbox，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.4.5 `@deepseek-ai/dsh-tool-fs`

**职责摘要**：Model-facing file tools。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/fs/tool-fs`
- NPM scope：`@deepseek-ai/dsh-tool-fs`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing file tools，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.4.6 `@deepseek-ai/dsh-tool-fs-search`

**职责摘要**：Search/discovery tools backed by subprocess。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/fs/tool-fs-search`
- NPM scope：`@deepseek-ai/dsh-tool-fs-search`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Search/discovery tools backed by subprocess，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.4.7 `@deepseek-ai/dsh-tool-str-replace-editor`

**职责摘要**：String-replacement editing tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/fs/tool-str-replace-editor`
- NPM scope：`@deepseek-ai/dsh-tool-str-replace-editor`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- String-replacement editing tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.5 `packages/skill` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.5.1 `@deepseek-ai/dsh-skill`

**职责摘要**：Skill provider registry/service。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/skill/skill`
- NPM scope：`@deepseek-ai/dsh-skill`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Skill provider registry/service，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.5.2 `@deepseek-ai/dsh-skill-badge`

**职责摘要**：Skill metadata/badge support。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/skill/skill-badge`
- NPM scope：`@deepseek-ai/dsh-skill-badge`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Skill metadata/badge support，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.5.3 `@deepseek-ai/dsh-skill-filesystem`

**职责摘要**：Local filesystem skill provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/skill/skill-filesystem`
- NPM scope：`@deepseek-ai/dsh-skill-filesystem`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local filesystem skill provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.5.4 `@deepseek-ai/dsh-tool-skill`

**职责摘要**：Model-facing skill catalog/loader。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/skill/tool-skill`
- NPM scope：`@deepseek-ai/dsh-tool-skill`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing skill catalog/loader，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.6 `packages/subagent` 深入分析

> 这一组共 11 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.6.1 `@deepseek-ai/dsh-subagent`

**职责摘要**：Subagent capability/provider registry。

### 设计位置
- 层次：多 Agent / 外部 Agent 协同层
- 包路径：`packages/subagent/subagent`
- NPM scope：`@deepseek-ai/dsh-subagent`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Subagent capability/provider registry，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.2 `@deepseek-ai/dsh-subagent-acp`

**职责摘要**：ACP-backed subagent integration。

### 设计位置
- 层次：多 Agent / 外部 Agent 协同层
- 包路径：`packages/subagent/subagent-acp`
- NPM scope：`@deepseek-ai/dsh-subagent-acp`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- ACP-backed subagent integration，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.3 `@deepseek-ai/dsh-subagent-claude-code`

**职责摘要**：Claude Code subagent bridge。

### 设计位置
- 层次：多 Agent / 外部 Agent 协同层
- 包路径：`packages/subagent/subagent-claude-code`
- NPM scope：`@deepseek-ai/dsh-subagent-claude-code`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Claude Code subagent bridge，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.4 `@deepseek-ai/dsh-subagent-codex`

**职责摘要**：Codex subagent bridge。

### 设计位置
- 层次：多 Agent / 外部 Agent 协同层
- 包路径：`packages/subagent/subagent-codex`
- NPM scope：`@deepseek-ai/dsh-subagent-codex`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Codex subagent bridge，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.5 `@deepseek-ai/dsh-subagent-dsh-sdk`

**职责摘要**：DSH SDK subagent driver。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/subagent/subagent-dsh-sdk`
- NPM scope：`@deepseek-ai/dsh-subagent-dsh-sdk`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- DSH SDK subagent driver，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.6 `@deepseek-ai/dsh-subagent-fork-in-process`

**职责摘要**：In-process subagent fork support。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/subagent/subagent-fork-in-process`
- NPM scope：`@deepseek-ai/dsh-subagent-fork-in-process`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- In-process subagent fork support，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.7 `@deepseek-ai/dsh-subagent-in-process-driver`

**职责摘要**：In-process subagent driver。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/subagent/subagent-in-process-driver`
- NPM scope：`@deepseek-ai/dsh-subagent-in-process-driver`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- In-process subagent driver，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.8 `@deepseek-ai/dsh-subagent-spawn-in-process`

**职责摘要**：In-process child spawning。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/subagent/subagent-spawn-in-process`
- NPM scope：`@deepseek-ai/dsh-subagent-spawn-in-process`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- In-process child spawning，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.9 `@deepseek-ai/dsh-tool-subagent`

**职责摘要**：Model-facing delegation tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/subagent/tool-subagent`
- NPM scope：`@deepseek-ai/dsh-tool-subagent`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing delegation tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.10 `@deepseek-ai/dsh-tool-subagent-control`

**职责摘要**：Subagent control tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/subagent/tool-subagent-control`
- NPM scope：`@deepseek-ai/dsh-tool-subagent-control`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Subagent control tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.6.11 `@deepseek-ai/dsh-tool-subagent-report`

**职责摘要**：Subagent reporting tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/subagent/tool-subagent-report`
- NPM scope：`@deepseek-ai/dsh-tool-subagent-report`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Subagent reporting tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.7 `packages/web` 深入分析

> 这一组共 6 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.7.1 `@deepseek-ai/dsh-tool-web`

**职责摘要**：Model-facing web tools。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/web/tool-web`
- NPM scope：`@deepseek-ai/dsh-tool-web`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing web tools，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.7.2 `@deepseek-ai/dsh-web`

**职责摘要**：Web capability/service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/web/web`
- NPM scope：`@deepseek-ai/dsh-web`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Web capability/service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.7.3 `@deepseek-ai/dsh-web-fetch-http`

**职责摘要**：HTTP fetch provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/web/web-fetch-http`
- NPM scope：`@deepseek-ai/dsh-web-fetch-http`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- HTTP fetch provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.7.4 `@deepseek-ai/dsh-web-search-deepseek`

**职责摘要**：DeepSeek-backed search provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/web/web-search-deepseek`
- NPM scope：`@deepseek-ai/dsh-web-search-deepseek`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- DeepSeek-backed search provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.7.5 `@deepseek-ai/dsh-web-search-exa`

**职责摘要**：Exa search provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/web/web-search-exa`
- NPM scope：`@deepseek-ai/dsh-web-search-exa`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Exa search provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.7.6 `@deepseek-ai/dsh-web-search-perplexity`

**职责摘要**：Perplexity search provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/web/web-search-perplexity`
- NPM scope：`@deepseek-ai/dsh-web-search-perplexity`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Perplexity search provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.8 `packages/spill` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.8.1 `@deepseek-ai/dsh-spill`

**职责摘要**：Spill-to-storage service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/spill/spill`
- NPM scope：`@deepseek-ai/dsh-spill`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Spill-to-storage service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.8.2 `@deepseek-ai/dsh-spill-local`

**职责摘要**：Local spill implementation。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/spill/spill-local`
- NPM scope：`@deepseek-ai/dsh-spill-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local spill implementation，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.8.3 `@deepseek-ai/dsh-spill-policy`

**职责摘要**：Tool-result spill policy。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/spill/spill-policy`
- NPM scope：`@deepseek-ai/dsh-spill-policy`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Tool-result spill policy，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.9 `packages/todo` 深入分析

> 这一组共 1 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.9.1 `@deepseek-ai/dsh-tool-todo`

**职责摘要**：Model-facing todo_write tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/todo/tool-todo`
- NPM scope：`@deepseek-ai/dsh-tool-todo`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing todo_write tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.10 `packages/plan` 深入分析

> 这一组共 1 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.10.1 `@deepseek-ai/dsh-plan-mode`

**职责摘要**：Plan collaboration state and review flow。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/plan/plan-mode`
- NPM scope：`@deepseek-ai/dsh-plan-mode`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Plan collaboration state and review flow，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.11 `packages/hooks` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.11.1 `@deepseek-ai/dsh-hook-protocol`

**职责摘要**：Hook wire protocol primitives。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/hooks/hook-protocol`
- NPM scope：`@deepseek-ai/dsh-hook-protocol`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Hook wire protocol primitives，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.11.2 `@deepseek-ai/dsh-hooks-claude-code`

**职责摘要**：Claude Code hook bridge。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/hooks/hooks-claude-code`
- NPM scope：`@deepseek-ai/dsh-hooks-claude-code`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Claude Code hook bridge，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.11.3 `@deepseek-ai/dsh-hooks-codex`

**职责摘要**：Codex hook bridge。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/hooks/hooks-codex`
- NPM scope：`@deepseek-ai/dsh-hooks-codex`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Codex hook bridge，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.12 `packages/session-query` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.12.1 `@deepseek-ai/dsh-session-log-export`

**职责摘要**：Session log export。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session-query/session-log-export`
- NPM scope：`@deepseek-ai/dsh-session-log-export`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session log export，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.12.2 `@deepseek-ai/dsh-session-query`

**职责摘要**：Session retrieval/query abstraction。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session-query/session-query`
- NPM scope：`@deepseek-ai/dsh-session-query`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session retrieval/query abstraction，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.12.3 `@deepseek-ai/dsh-session-query-sqlite`

**职责摘要**：SQLite query/index provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session-query/session-query-sqlite`
- NPM scope：`@deepseek-ai/dsh-session-query-sqlite`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- SQLite query/index provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.12.4 `@deepseek-ai/dsh-tool-session-query`

**职责摘要**：Model-facing session query tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/session-query/tool-session-query`
- NPM scope：`@deepseek-ai/dsh-tool-session-query`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing session query tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.13 `packages/acp` 深入分析

> 这一组共 1 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.13.1 `@deepseek-ai/dsh-acp`

**职责摘要**：Automation-oriented Agent Client Protocol server。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/acp/acp`
- NPM scope：`@deepseek-ai/dsh-acp`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Automation-oriented Agent Client Protocol server，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.14 `packages/api` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.14.1 `@deepseek-ai/dsh-api-gateway`

**职责摘要**：Remote BFF/API gateway。

### 设计位置
- 层次：Host / Remote API 层
- 包路径：`packages/api/api-gateway`
- NPM scope：`@deepseek-ai/dsh-api-gateway`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Remote BFF/API gateway，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.14.2 `@deepseek-ai/dsh-api-remotes`

**职责摘要**：Remote service/API surface。

### 设计位置
- 层次：Host / Remote API 层
- 包路径：`packages/api/api-remotes`
- NPM scope：`@deepseek-ai/dsh-api-remotes`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Remote service/API surface，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.15 `packages/boot` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.15.1 `@deepseek-ai/dsh-app-boot`

**职责摘要**：Shared application binary boot glue。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/boot/app-boot`
- NPM scope：`@deepseek-ai/dsh-app-boot`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Shared application binary boot glue，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.15.2 `@deepseek-ai/dsh-cmdline`

**职责摘要**：Command-line/config bootstrap。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/boot/cmdline`
- NPM scope：`@deepseek-ai/dsh-cmdline`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Command-line/config bootstrap，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.16 `packages/bundle` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.16.1 `@deepseek-ai/dsh-base`

**职责摘要**：Installable base profile patch layer。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/bundle/base`
- NPM scope：`@deepseek-ai/dsh-base`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Installable base profile patch layer，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.16.2 `@deepseek-ai/dsh-headless`

**职责摘要**：Headless profile。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/bundle/headless`
- NPM scope：`@deepseek-ai/dsh-headless`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Headless profile，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.16.3 `@deepseek-ai/dsh-web-app`

**职责摘要**：Web application profile。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/bundle/web-app`
- NPM scope：`@deepseek-ai/dsh-web-app`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Web application profile，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.17 `packages/client` 深入分析

> 这一组共 40 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.17.1 `@deepseek-ai/dsh-client-connection`

**职责摘要**：Browser/server connection runtime。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-connection`
- NPM scope：`@deepseek-ai/dsh-client-connection`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Browser/server connection runtime，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.2 `@deepseek-ai/dsh-client-hmr`

**职责摘要**：Client hot-module replacement support。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-hmr`
- NPM scope：`@deepseek-ai/dsh-client-hmr`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Client hot-module replacement support，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.3 `@deepseek-ai/dsh-client-locale`

**职责摘要**：Locale/i18n runtime。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-locale`
- NPM scope：`@deepseek-ai/dsh-client-locale`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Locale/i18n runtime，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.4 `@deepseek-ai/dsh-client-modules`

**职责摘要**：Client module registry/loader。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-modules`
- NPM scope：`@deepseek-ai/dsh-client-modules`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Client module registry/loader，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.5 `@deepseek-ai/dsh-client-runtime`

**职责摘要**：Browser plugin runtime/object services。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-runtime`
- NPM scope：`@deepseek-ai/dsh-client-runtime`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Browser plugin runtime/object services，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.6 `@deepseek-ai/dsh-client-ui-agent-preset`

**职责摘要**：Agent preset UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-agent-preset`
- NPM scope：`@deepseek-ai/dsh-client-ui-agent-preset`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Agent preset UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.7 `@deepseek-ai/dsh-client-ui-attachment`

**职责摘要**：Attachment UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-attachment`
- NPM scope：`@deepseek-ai/dsh-client-ui-attachment`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Attachment UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.8 `@deepseek-ai/dsh-client-ui-brand-official`

**职责摘要**：Official branding UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-brand-official`
- NPM scope：`@deepseek-ai/dsh-client-ui-brand-official`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Official branding UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.9 `@deepseek-ai/dsh-client-ui-commands`

**职责摘要**：Command palette/commands UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-commands`
- NPM scope：`@deepseek-ai/dsh-client-ui-commands`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Command palette/commands UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.10 `@deepseek-ai/dsh-client-ui-conversation`

**职责摘要**：Conversation UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-conversation`
- NPM scope：`@deepseek-ai/dsh-client-ui-conversation`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Conversation UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.11 `@deepseek-ai/dsh-client-ui-deliverables`

**职责摘要**：Deliverables UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-deliverables`
- NPM scope：`@deepseek-ai/dsh-client-ui-deliverables`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Deliverables UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.12 `@deepseek-ai/dsh-client-ui-directory-picker-browse`

**职责摘要**：Directory picker browse UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-directory-picker-browse`
- NPM scope：`@deepseek-ai/dsh-client-ui-directory-picker-browse`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Directory picker browse UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.13 `@deepseek-ai/dsh-client-ui-directory-picker-native`

**职责摘要**：Native directory picker UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-directory-picker-native`
- NPM scope：`@deepseek-ai/dsh-client-ui-directory-picker-native`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Native directory picker UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.14 `@deepseek-ai/dsh-client-ui-goal`

**职责摘要**：Goal UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-goal`
- NPM scope：`@deepseek-ai/dsh-client-ui-goal`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Goal UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.15 `@deepseek-ai/dsh-client-ui-input-trigger`

**职责摘要**：Input trigger UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-input-trigger`
- NPM scope：`@deepseek-ai/dsh-client-ui-input-trigger`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Input trigger UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.16 `@deepseek-ai/dsh-client-ui-jobs`

**职责摘要**：Jobs UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-jobs`
- NPM scope：`@deepseek-ai/dsh-client-ui-jobs`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Jobs UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.17 `@deepseek-ai/dsh-client-ui-layout`

**职责摘要**：Layout framework。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-layout`
- NPM scope：`@deepseek-ai/dsh-client-ui-layout`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Layout framework，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.18 `@deepseek-ai/dsh-client-ui-message-feedback`

**职责摘要**：Message feedback UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-message-feedback`
- NPM scope：`@deepseek-ai/dsh-client-ui-message-feedback`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Message feedback UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.19 `@deepseek-ai/dsh-client-ui-model-selection`

**职责摘要**：Model selection UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-model-selection`
- NPM scope：`@deepseek-ai/dsh-client-ui-model-selection`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model selection UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.20 `@deepseek-ai/dsh-client-ui-permission-presets`

**职责摘要**：Permission preset UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-permission-presets`
- NPM scope：`@deepseek-ai/dsh-client-ui-permission-presets`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Permission preset UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.21 `@deepseek-ai/dsh-client-ui-plan`

**职责摘要**：Plan UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-plan`
- NPM scope：`@deepseek-ai/dsh-client-ui-plan`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Plan UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.22 `@deepseek-ai/dsh-client-ui-primitives`

**职责摘要**：Shared UI primitives。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-primitives`
- NPM scope：`@deepseek-ai/dsh-client-ui-primitives`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Shared UI primitives，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.23 `@deepseek-ai/dsh-client-ui-reference`

**职责摘要**：Reference/citation UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-reference`
- NPM scope：`@deepseek-ai/dsh-client-ui-reference`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Reference/citation UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.24 `@deepseek-ai/dsh-client-ui-renderer`

**职责摘要**：Message/content renderer。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-renderer`
- NPM scope：`@deepseek-ai/dsh-client-ui-renderer`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Message/content renderer，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.25 `@deepseek-ai/dsh-client-ui-settings`

**职责摘要**：Settings UI shell。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-settings`
- NPM scope：`@deepseek-ai/dsh-client-ui-settings`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Settings UI shell，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.26 `@deepseek-ai/dsh-client-ui-settings-general`

**职责摘要**：General settings UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-settings-general`
- NPM scope：`@deepseek-ai/dsh-client-ui-settings-general`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- General settings UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.27 `@deepseek-ai/dsh-client-ui-settings-models`

**职责摘要**：Model settings UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-settings-models`
- NPM scope：`@deepseek-ai/dsh-client-ui-settings-models`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model settings UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.28 `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`

**职责摘要**：Plugin inventory settings UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-settings-plugin-inventory`
- NPM scope：`@deepseek-ai/dsh-client-ui-settings-plugin-inventory`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Plugin inventory settings UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.29 `@deepseek-ai/dsh-client-ui-settings-plugins`

**职责摘要**：Plugin settings UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-settings-plugins`
- NPM scope：`@deepseek-ai/dsh-client-ui-settings-plugins`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Plugin settings UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.30 `@deepseek-ai/dsh-client-ui-sidebar`

**职责摘要**：Sidebar UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-sidebar`
- NPM scope：`@deepseek-ai/dsh-client-ui-sidebar`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Sidebar UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.31 `@deepseek-ai/dsh-client-ui-skill`

**职责摘要**：Skill UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-skill`
- NPM scope：`@deepseek-ai/dsh-client-ui-skill`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Skill UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.32 `@deepseek-ai/dsh-client-ui-slots`

**职责摘要**：UI slot extension system。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-slots`
- NPM scope：`@deepseek-ai/dsh-client-ui-slots`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- UI slot extension system，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.33 `@deepseek-ai/dsh-client-ui-subagent`

**职责摘要**：Subagent UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-subagent`
- NPM scope：`@deepseek-ai/dsh-client-ui-subagent`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Subagent UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.34 `@deepseek-ai/dsh-client-ui-theme`

**职责摘要**：Theme UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-theme`
- NPM scope：`@deepseek-ai/dsh-client-ui-theme`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Theme UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.35 `@deepseek-ai/dsh-client-ui-tool`

**职责摘要**：Tool UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-tool`
- NPM scope：`@deepseek-ai/dsh-client-ui-tool`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Tool UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.36 `@deepseek-ai/dsh-client-ui-trajectory`

**职责摘要**：Agent trajectory UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-trajectory`
- NPM scope：`@deepseek-ai/dsh-client-ui-trajectory`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Agent trajectory UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.37 `@deepseek-ai/dsh-client-ui-user-questions`

**职责摘要**：User-question UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-user-questions`
- NPM scope：`@deepseek-ai/dsh-client-ui-user-questions`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- User-question UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.38 `@deepseek-ai/dsh-client-ui-workflow-run`

**职责摘要**：Workflow-run UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-workflow-run`
- NPM scope：`@deepseek-ai/dsh-client-ui-workflow-run`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Workflow-run UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.39 `@deepseek-ai/dsh-client-ui-workspace`

**职责摘要**：Workspace UI。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-ui-workspace`
- NPM scope：`@deepseek-ai/dsh-client-ui-workspace`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Workspace UI，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.17.40 `@deepseek-ai/dsh-client-web`

**职责摘要**：Browser application root。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/client/client-web`
- NPM scope：`@deepseek-ai/dsh-client-web`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Browser application root，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
host/api event
  ↓
client connection
  ↓
client module
  ↓
React/UI plugin
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.18 `packages/code-runtime` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.18.1 `@deepseek-ai/dsh-code-runtime`

**职责摘要**：Code execution service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/code-runtime/code-runtime`
- NPM scope：`@deepseek-ai/dsh-code-runtime`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Code execution service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.18.2 `@deepseek-ai/dsh-code-runtime-python`

**职责摘要**：Python code runtime integration。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/code-runtime/code-runtime-python`
- NPM scope：`@deepseek-ai/dsh-code-runtime-python`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Python code runtime integration，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.18.3 `@deepseek-ai/dsh-code-runtime-worker-thread`

**职责摘要**：Worker-thread code execution provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/code-runtime/code-runtime-worker-thread`
- NPM scope：`@deepseek-ai/dsh-code-runtime-worker-thread`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Worker-thread code execution provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.19 `packages/compaction` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.19.1 `@deepseek-ai/dsh-command-compact`

**职责摘要**：Compaction command。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/compaction/command-compact`
- NPM scope：`@deepseek-ai/dsh-command-compact`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Compaction command，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.19.2 `@deepseek-ai/dsh-compaction`

**职责摘要**：Compaction capability definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/compaction/compaction`
- NPM scope：`@deepseek-ai/dsh-compaction`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Compaction capability definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.19.3 `@deepseek-ai/dsh-compaction-basic`

**职责摘要**：Basic compaction provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/compaction/compaction-basic`
- NPM scope：`@deepseek-ai/dsh-compaction-basic`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Basic compaction provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.19.4 `@deepseek-ai/dsh-compaction-tool-result-pruner`

**职责摘要**：Tool-result pruning consumer。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/compaction/compaction-tool-result-pruner`
- NPM scope：`@deepseek-ai/dsh-compaction-tool-result-pruner`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Tool-result pruning consumer，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.20 `packages/context` 深入分析

> 这一组共 6 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.20.1 `@deepseek-ai/dsh-agent-instructions`

**职责摘要**：Workspace/agent instruction injection。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/context/agent-instructions`
- NPM scope：`@deepseek-ai/dsh-agent-instructions`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Workspace/agent instruction injection，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.20.2 `@deepseek-ai/dsh-file-reference`

**职责摘要**：Model-visible file reference context。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/context/file-reference`
- NPM scope：`@deepseek-ai/dsh-file-reference`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-visible file reference context，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.20.3 `@deepseek-ai/dsh-file-reference-local`

**职责摘要**：Local file reference provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/context/file-reference-local`
- NPM scope：`@deepseek-ai/dsh-file-reference-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local file reference provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.20.4 `@deepseek-ai/dsh-session-reference`

**职责摘要**：Session reference context。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/context/session-reference`
- NPM scope：`@deepseek-ai/dsh-session-reference`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session reference context，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.20.5 `@deepseek-ai/dsh-time-context`

**职责摘要**：Time context injection。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/context/time-context`
- NPM scope：`@deepseek-ai/dsh-time-context`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Time context injection，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.20.6 `@deepseek-ai/dsh-tmux-context`

**职责摘要**：tmux/session context。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/context/tmux-context`
- NPM scope：`@deepseek-ai/dsh-tmux-context`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- tmux/session context，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.21 `packages/credentials` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.21.1 `@deepseek-ai/dsh-credentials`

**职责摘要**：Credential-reference service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/credentials/credentials`
- NPM scope：`@deepseek-ai/dsh-credentials`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Credential-reference service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.21.2 `@deepseek-ai/dsh-credentials-local`

**职责摘要**：Environment/.env-backed credential provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/credentials/credentials-local`
- NPM scope：`@deepseek-ai/dsh-credentials-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Environment/.env-backed credential provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.22 `packages/e2b` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.22.1 `@deepseek-ai/dsh-e2b`

**职责摘要**：E2B provider abstractions。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/e2b/e2b`
- NPM scope：`@deepseek-ai/dsh-e2b`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- E2B provider abstractions，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.22.2 `@deepseek-ai/dsh-fs-e2b`

**职责摘要**：E2B-backed filesystem provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/e2b/fs-e2b`
- NPM scope：`@deepseek-ai/dsh-fs-e2b`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- E2B-backed filesystem provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.22.3 `@deepseek-ai/dsh-subprocess-e2b`

**职责摘要**：E2B-backed subprocess provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/e2b/subprocess-e2b`
- NPM scope：`@deepseek-ai/dsh-subprocess-e2b`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- E2B-backed subprocess provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.23 `packages/examples` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.23.1 `@deepseek-ai/dsh-acp-demo`

**职责摘要**：ACP demo composition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/examples/acp-demo`
- NPM scope：`@deepseek-ai/dsh-acp-demo`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- ACP demo composition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.23.2 `@deepseek-ai/dsh-agent-spine-demo`

**职责摘要**：Runnable core agent-spine composition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/examples/agent-spine-demo`
- NPM scope：`@deepseek-ai/dsh-agent-spine-demo`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Runnable core agent-spine composition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.23.3 `@deepseek-ai/dsh-sdk-jsonrpc-demo`

**职责摘要**：SDK JSON-RPC demo。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/examples/sdk-jsonrpc-demo`
- NPM scope：`@deepseek-ai/dsh-sdk-jsonrpc-demo`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- SDK JSON-RPC demo，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.24 `packages/experimental` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.24.1 `@deepseek-ai/dsh-experimental-agent-team`

**职责摘要**：Private agent-team prototype。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/experimental/experimental-agent-team`
- NPM scope：`@deepseek-ai/dsh-experimental-agent-team`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Private agent-team prototype，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.24.2 `@deepseek-ai/dsh-experimental-tool-agent-team`

**职责摘要**：Agent-team tool prototype。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/experimental/experimental-tool-agent-team`
- NPM scope：`@deepseek-ai/dsh-experimental-tool-agent-team`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Agent-team tool prototype，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.25 `packages/extensions` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.25.1 `@deepseek-ai/dsh-client-ui-cordis`

**职责摘要**：Client-side Cordis UI extension。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/extensions/client-ui-cordis`
- NPM scope：`@deepseek-ai/dsh-client-ui-cordis`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Client-side Cordis UI extension，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.25.2 `@deepseek-ai/dsh-cordis-client-runner`

**职责摘要**：Client Cordis runner。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/extensions/cordis-client-runner`
- NPM scope：`@deepseek-ai/dsh-cordis-client-runner`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Client Cordis runner，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.25.3 `@deepseek-ai/dsh-cordis-host-runner`

**职责摘要**：Host Cordis runner。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/extensions/cordis-host-runner`
- NPM scope：`@deepseek-ai/dsh-cordis-host-runner`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Host Cordis runner，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.25.4 `@deepseek-ai/dsh-tool-cordis`

**职责摘要**：Model-facing Cordis inspection/control tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/extensions/tool-cordis`
- NPM scope：`@deepseek-ai/dsh-tool-cordis`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing Cordis inspection/control tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.26 `packages/feedback` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.26.1 `@deepseek-ai/dsh-command-feedback`

**职责摘要**：Feedback command。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/feedback/command-feedback`
- NPM scope：`@deepseek-ai/dsh-command-feedback`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Feedback command，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.26.2 `@deepseek-ai/dsh-message-feedback`

**职责摘要**：Message feedback persistence/transport。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/feedback/message-feedback`
- NPM scope：`@deepseek-ai/dsh-message-feedback`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Message feedback persistence/transport，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.27 `packages/guard` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.27.1 `@deepseek-ai/dsh-repeat-tool-reminder`

**职责摘要**：Repeat-tool advisory guard。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/guard/repeat-tool-reminder`
- NPM scope：`@deepseek-ai/dsh-repeat-tool-reminder`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Repeat-tool advisory guard，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.27.2 `@deepseek-ai/dsh-tool-call-timeout-policy`

**职责摘要**：Tool-call deadline guard。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/guard/tool-call-timeout-policy`
- NPM scope：`@deepseek-ai/dsh-tool-call-timeout-policy`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Tool-call deadline guard，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.28 `packages/host` 深入分析

> 这一组共 8 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.28.1 `@deepseek-ai/dsh-host-apiproxy`

**职责摘要**：Host-side API proxy/BFF。

### 设计位置
- 层次：Host / Remote API 层
- 包路径：`packages/host/host-apiproxy`
- NPM scope：`@deepseek-ai/dsh-host-apiproxy`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Host-side API proxy/BFF，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.28.2 `@deepseek-ai/dsh-host-directory-picker`

**职责摘要**：Host directory picker seam。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/host/host-directory-picker`
- NPM scope：`@deepseek-ai/dsh-host-directory-picker`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Host directory picker seam，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.28.3 `@deepseek-ai/dsh-host-directory-picker-auto`

**职责摘要**：Automatic directory picker implementation。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/host/host-directory-picker-auto`
- NPM scope：`@deepseek-ai/dsh-host-directory-picker-auto`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Automatic directory picker implementation，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.28.4 `@deepseek-ai/dsh-host-directory-picker-browse`

**职责摘要**：Browse directory picker implementation。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/host/host-directory-picker-browse`
- NPM scope：`@deepseek-ai/dsh-host-directory-picker-browse`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Browse directory picker implementation，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.28.5 `@deepseek-ai/dsh-host-directory-picker-native`

**职责摘要**：Native directory picker implementation。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/host/host-directory-picker-native`
- NPM scope：`@deepseek-ai/dsh-host-directory-picker-native`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Native directory picker implementation，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.28.6 `@deepseek-ai/dsh-host-frontend-static`

**职责摘要**：Static frontend host。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/host/host-frontend-static`
- NPM scope：`@deepseek-ai/dsh-host-frontend-static`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Static frontend host，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.28.7 `@deepseek-ai/dsh-host-plugin-inventory`

**职责摘要**：Host plugin inventory endpoint。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/host/host-plugin-inventory`
- NPM scope：`@deepseek-ai/dsh-host-plugin-inventory`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Host plugin inventory endpoint，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.28.8 `@deepseek-ai/dsh-host-webserver`

**职责摘要**：HTTP/web server。

### 设计位置
- 层次：Host / Remote API 层
- 包路径：`packages/host/host-webserver`
- NPM scope：`@deepseek-ai/dsh-host-webserver`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- HTTP/web server，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.29 `packages/identity` 深入分析

> 这一组共 1 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.29.1 `@deepseek-ai/dsh-anonymous-user-id`

**职责摘要**：Shared anonymous user identity。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/identity/anonymous-user-id`
- NPM scope：`@deepseek-ai/dsh-anonymous-user-id`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Shared anonymous user identity，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.30 `packages/interaction` 深入分析

> 这一组共 5 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.30.1 `@deepseek-ai/dsh-commands`

**职责摘要**：Command registry/command execution。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/interaction/commands`
- NPM scope：`@deepseek-ai/dsh-commands`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Command registry/command execution，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.30.2 `@deepseek-ai/dsh-permission-presets`

**职责摘要**：Permission preset definitions。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/interaction/permission-presets`
- NPM scope：`@deepseek-ai/dsh-permission-presets`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Permission preset definitions，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.30.3 `@deepseek-ai/dsh-tool-ask-user`

**职责摘要**：Model-facing ask-user tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/interaction/tool-ask-user`
- NPM scope：`@deepseek-ai/dsh-tool-ask-user`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing ask-user tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.30.4 `@deepseek-ai/dsh-user-approval`

**职责摘要**：User approval capability。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/interaction/user-approval`
- NPM scope：`@deepseek-ai/dsh-user-approval`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- User approval capability，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.30.5 `@deepseek-ai/dsh-user-questions`

**职责摘要**：User question capability。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/interaction/user-questions`
- NPM scope：`@deepseek-ai/dsh-user-questions`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- User question capability，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.31 `packages/jobs` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.31.1 `@deepseek-ai/dsh-jobs`

**职责摘要**：Background job runtime。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/jobs/jobs`
- NPM scope：`@deepseek-ai/dsh-jobs`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Background job runtime，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.31.2 `@deepseek-ai/dsh-jobs-local`

**职责摘要**：Local job provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/jobs/jobs-local`
- NPM scope：`@deepseek-ai/dsh-jobs-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local job provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.31.3 `@deepseek-ai/dsh-tool-jobs`

**职责摘要**：Model-facing job control tools。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/jobs/tool-jobs`
- NPM scope：`@deepseek-ai/dsh-tool-jobs`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing job control tools，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.32 `packages/lsp` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.32.1 `@deepseek-ai/dsh-lsp`

**职责摘要**：LSP capability/service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/lsp/lsp`
- NPM scope：`@deepseek-ai/dsh-lsp`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- LSP capability/service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.32.2 `@deepseek-ai/dsh-lsp-stdio`

**职责摘要**：Generic stdio LSP provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/lsp/lsp-stdio`
- NPM scope：`@deepseek-ai/dsh-lsp-stdio`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Generic stdio LSP provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.32.3 `@deepseek-ai/dsh-tool-lsp`

**职责摘要**：Model-facing LSP tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/lsp/tool-lsp`
- NPM scope：`@deepseek-ai/dsh-tool-lsp`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing LSP tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.33 `packages/mcp` 深入分析

> 这一组共 1 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.33.1 `@deepseek-ai/dsh-mcp-client`

**职责摘要**：MCP client integration。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/mcp/mcp-client`
- NPM scope：`@deepseek-ai/dsh-mcp-client`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- MCP client integration，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.34 `packages/preset` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.34.1 `@deepseek-ai/dsh-agent-presets`

**职责摘要**：Agent preset composition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/preset/agent-presets`
- NPM scope：`@deepseek-ai/dsh-agent-presets`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Agent preset composition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.34.2 `@deepseek-ai/dsh-persona`

**职责摘要**：Persona definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/preset/persona`
- NPM scope：`@deepseek-ai/dsh-persona`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Persona definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.35 `packages/runtime-diagnostics` 深入分析

> 这一组共 1 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.35.1 `@deepseek-ai/dsh-invariants`

**职责摘要**：Runtime invariant diagnostics。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/runtime-diagnostics/invariants`
- NPM scope：`@deepseek-ai/dsh-invariants`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Runtime invariant diagnostics，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.36 `packages/sandbox` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.36.1 `@deepseek-ai/dsh-sandbox`

**职责摘要**：Process-confinement service definition。

### 设计位置
- 层次：安全执行边界层
- 包路径：`packages/sandbox/sandbox`
- NPM scope：`@deepseek-ai/dsh-sandbox`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Process-confinement service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.36.2 `@deepseek-ai/dsh-sandbox-local`

**职责摘要**：Local sandbox provider。

### 设计位置
- 层次：安全执行边界层
- 包路径：`packages/sandbox/sandbox-local`
- NPM scope：`@deepseek-ai/dsh-sandbox-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local sandbox provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.36.3 `@deepseek-ai/dsh-sandbox-policy`

**职责摘要**：Sandbox policy provider。

### 设计位置
- 层次：安全执行边界层
- 包路径：`packages/sandbox/sandbox-policy`
- NPM scope：`@deepseek-ai/dsh-sandbox-policy`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Sandbox policy provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.36.4 `@deepseek-ai/dsh-sandbox-windows-acl`

**职责摘要**：Windows ACL provider。

### 设计位置
- 层次：安全执行边界层
- 包路径：`packages/sandbox/sandbox-windows-acl`
- NPM scope：`@deepseek-ai/dsh-sandbox-windows-acl`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Windows ACL provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.37 `packages/schedule` 深入分析

> 这一组共 1 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.37.1 `@deepseek-ai/dsh-schedule`

**职责摘要**：Session-local scheduled follow-up service。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/schedule/schedule`
- NPM scope：`@deepseek-ai/dsh-schedule`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session-local scheduled follow-up service，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.38 `packages/sdk` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.38.1 `@deepseek-ai/dsh-sdk-client`

**职责摘要**：Out-of-process TypeScript SDK client。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/sdk/sdk-client`
- NPM scope：`@deepseek-ai/dsh-sdk-client`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Out-of-process TypeScript SDK client，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.38.2 `@deepseek-ai/dsh-sdk-jsonrpc-server`

**职责摘要**：JSON-RPC server。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/sdk/sdk-jsonrpc-server`
- NPM scope：`@deepseek-ai/dsh-sdk-jsonrpc-server`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- JSON-RPC server，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.38.3 `@deepseek-ai/dsh-sdk-protocol`

**职责摘要**：Out-of-process SDK protocol。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/sdk/sdk-protocol`
- NPM scope：`@deepseek-ai/dsh-sdk-protocol`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Out-of-process SDK protocol，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.39 `packages/session` 深入分析

> 这一组共 13 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.39.1 `@deepseek-ai/dsh-session-checkpoint-policy`

**职责摘要**：Session checkpoint policy。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-checkpoint-policy`
- NPM scope：`@deepseek-ai/dsh-session-checkpoint-policy`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session checkpoint policy，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.2 `@deepseek-ai/dsh-session-persistence`

**职责摘要**：Session persistence seam。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-persistence`
- NPM scope：`@deepseek-ai/dsh-session-persistence`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session persistence seam，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.3 `@deepseek-ai/dsh-session-persistence-jsonl`

**职责摘要**：JSONL persistence backend。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-persistence-jsonl`
- NPM scope：`@deepseek-ai/dsh-session-persistence-jsonl`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- JSONL persistence backend，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.4 `@deepseek-ai/dsh-session-persistence-sqlite`

**职责摘要**：SQLite persistence backend。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-persistence-sqlite`
- NPM scope：`@deepseek-ai/dsh-session-persistence-sqlite`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- SQLite persistence backend，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.5 `@deepseek-ai/dsh-session-projection`

**职责摘要**：Session projection seam。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-projection`
- NPM scope：`@deepseek-ai/dsh-session-projection`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session projection seam，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.6 `@deepseek-ai/dsh-session-projection-cache`

**职责摘要**：Projection cache。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-projection-cache`
- NPM scope：`@deepseek-ai/dsh-session-projection-cache`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Projection cache，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.7 `@deepseek-ai/dsh-session-stats`

**职责摘要**：Session statistics。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-stats`
- NPM scope：`@deepseek-ai/dsh-session-stats`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session statistics，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.8 `@deepseek-ai/dsh-session-telemetry`

**职责摘要**：Session telemetry seam。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-telemetry`
- NPM scope：`@deepseek-ai/dsh-session-telemetry`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session telemetry seam，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.9 `@deepseek-ai/dsh-session-telemetry-otel`

**职责摘要**：OpenTelemetry telemetry provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-telemetry-otel`
- NPM scope：`@deepseek-ai/dsh-session-telemetry-otel`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- OpenTelemetry telemetry provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.10 `@deepseek-ai/dsh-session-title`

**职责摘要**：Session title service。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-title`
- NPM scope：`@deepseek-ai/dsh-session-title`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Session title service，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.11 `@deepseek-ai/dsh-session-title-all-prompts-llm`

**职责摘要**：Title provider using all prompts。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-title-all-prompts-llm`
- NPM scope：`@deepseek-ai/dsh-session-title-all-prompts-llm`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Title provider using all prompts，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.12 `@deepseek-ai/dsh-session-title-first-prompt-llm`

**职责摘要**：Title provider using first prompt。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-title-first-prompt-llm`
- NPM scope：`@deepseek-ai/dsh-session-title-first-prompt-llm`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Title provider using first prompt，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.39.13 `@deepseek-ai/dsh-session-title-llm`

**职责摘要**：Generic LLM title provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/session/session-title-llm`
- NPM scope：`@deepseek-ai/dsh-session-title-llm`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Generic LLM title provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.40 `packages/settings` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.40.1 `@deepseek-ai/dsh-settings`

**职责摘要**：Settings service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/settings/settings`
- NPM scope：`@deepseek-ai/dsh-settings`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Settings service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.40.2 `@deepseek-ai/dsh-settings-file`

**职责摘要**：File-backed settings provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/settings/settings-file`
- NPM scope：`@deepseek-ai/dsh-settings-file`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- File-backed settings provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.41 `packages/shell` 深入分析

> 这一组共 10 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.41.1 `@deepseek-ai/dsh-bash-local`

**职责摘要**：Local Bash executor。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/shell/bash-local`
- NPM scope：`@deepseek-ai/dsh-bash-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local Bash executor，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.2 `@deepseek-ai/dsh-bash-sandbox`

**职责摘要**：Sandboxed Bash executor。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/shell/bash-sandbox`
- NPM scope：`@deepseek-ai/dsh-bash-sandbox`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Sandboxed Bash executor，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.3 `@deepseek-ai/dsh-pwsh-local`

**职责摘要**：Local PowerShell executor。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/shell/pwsh-local`
- NPM scope：`@deepseek-ai/dsh-pwsh-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local PowerShell executor，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.4 `@deepseek-ai/dsh-pwsh-sandbox`

**职责摘要**：Sandboxed PowerShell executor。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/shell/pwsh-sandbox`
- NPM scope：`@deepseek-ai/dsh-pwsh-sandbox`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Sandboxed PowerShell executor，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.5 `@deepseek-ai/dsh-shell`

**职责摘要**：Shell capability/service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/shell/shell`
- NPM scope：`@deepseek-ai/dsh-shell`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Shell capability/service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.6 `@deepseek-ai/dsh-shell-env`

**职责摘要**：Environment construction for shell。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/shell/shell-env`
- NPM scope：`@deepseek-ai/dsh-shell-env`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Environment construction for shell，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.7 `@deepseek-ai/dsh-tool-bash`

**职责摘要**：Model-facing Bash tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/shell/tool-bash`
- NPM scope：`@deepseek-ai/dsh-tool-bash`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing Bash tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.8 `@deepseek-ai/dsh-tool-bash-persistent`

**职责摘要**：Persistent Bash tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/shell/tool-bash-persistent`
- NPM scope：`@deepseek-ai/dsh-tool-bash-persistent`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Persistent Bash tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.9 `@deepseek-ai/dsh-tool-pwsh`

**职责摘要**：Model-facing PowerShell tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/shell/tool-pwsh`
- NPM scope：`@deepseek-ai/dsh-tool-pwsh`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing PowerShell tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.41.10 `@deepseek-ai/dsh-tool-pwsh-persistent`

**职责摘要**：Persistent PowerShell tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/shell/tool-pwsh-persistent`
- NPM scope：`@deepseek-ai/dsh-tool-pwsh-persistent`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Persistent PowerShell tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.42 `packages/storage` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.42.1 `@deepseek-ai/dsh-storage`

**职责摘要**：Non-session storage hub。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/storage/storage`
- NPM scope：`@deepseek-ai/dsh-storage`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Non-session storage hub，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.42.2 `@deepseek-ai/dsh-storage-domain`

**职责摘要**：Domain/form layer for storage。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/storage/storage-domain`
- NPM scope：`@deepseek-ai/dsh-storage-domain`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Domain/form layer for storage，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.42.3 `@deepseek-ai/dsh-storage-json`

**职责摘要**：JSON storage backend。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/storage/storage-json`
- NPM scope：`@deepseek-ai/dsh-storage-json`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- JSON storage backend，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.42.4 `@deepseek-ai/dsh-storage-sqlite`

**职责摘要**：SQLite storage backend。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/storage/storage-sqlite`
- NPM scope：`@deepseek-ai/dsh-storage-sqlite`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- SQLite storage backend，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.43 `packages/subprocess` 深入分析

> 这一组共 2 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.43.1 `@deepseek-ai/dsh-subprocess`

**职责摘要**：Subprocess capability/service definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/subprocess/subprocess`
- NPM scope：`@deepseek-ai/dsh-subprocess`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Subprocess capability/service definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.43.2 `@deepseek-ai/dsh-subprocess-local`

**职责摘要**：Local process-tree provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/subprocess/subprocess-local`
- NPM scope：`@deepseek-ai/dsh-subprocess-local`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Local process-tree provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.44 `packages/terminal` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.44.1 `@deepseek-ai/dsh-terminal`

**职责摘要**：Persistent PTY capability definition。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/terminal/terminal`
- NPM scope：`@deepseek-ai/dsh-terminal`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Persistent PTY capability definition，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.44.2 `@deepseek-ai/dsh-terminal-bash`

**职责摘要**：Bash PTY provider。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/terminal/terminal-bash`
- NPM scope：`@deepseek-ai/dsh-terminal-bash`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Bash PTY provider，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.44.3 `@deepseek-ai/dsh-tool-terminal`

**职责摘要**：Model-facing terminal tools。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/terminal/tool-terminal`
- NPM scope：`@deepseek-ai/dsh-tool-terminal`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing terminal tools，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.45 `packages/test-support` 深入分析

> 这一组共 6 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.45.1 `@deepseek-ai/dsh-acp-snapshot`

**职责摘要**：ACP snapshot test support。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/test-support/acp-snapshot`
- NPM scope：`@deepseek-ai/dsh-acp-snapshot`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- ACP snapshot test support，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.45.2 `@deepseek-ai/dsh-agent-loop-testkit`

**职责摘要**：AgentLoop test helpers。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/test-support/agent-loop-testkit`
- NPM scope：`@deepseek-ai/dsh-agent-loop-testkit`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- AgentLoop test helpers，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.45.3 `@deepseek-ai/dsh-client-test-runtime`

**职责摘要**：Client test runtime。

### 设计位置
- 层次：Browser/Web UI 插件层
- 包路径：`packages/test-support/client-test-runtime`
- NPM scope：`@deepseek-ai/dsh-client-test-runtime`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Client test runtime，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.45.4 `@deepseek-ai/dsh-llm-mock-server`

**职责摘要**：Mock LLM server。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/test-support/llm-mock-server`
- NPM scope：`@deepseek-ai/dsh-llm-mock-server`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Mock LLM server，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.45.5 `@deepseek-ai/dsh-llm-replay`

**职责摘要**：LLM replay support。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/test-support/llm-replay`
- NPM scope：`@deepseek-ai/dsh-llm-replay`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- LLM replay support，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.45.6 `@deepseek-ai/dsh-loader-smoke`

**职责摘要**：Loader smoke tests。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/test-support/loader-smoke`
- NPM scope：`@deepseek-ai/dsh-loader-smoke`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Loader smoke tests，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.46 `packages/typert` 深入分析

> 这一组共 4 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.46.1 `@deepseek-ai/dsh-typert-generator`

**职责摘要**：Type graph generator。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/typert/typert-generator`
- NPM scope：`@deepseek-ai/dsh-typert-generator`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Type graph generator，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.46.2 `@deepseek-ai/dsh-typert-loader`

**职责摘要**：Artifact loader。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/typert/typert-loader`
- NPM scope：`@deepseek-ai/dsh-typert-loader`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Artifact loader，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.46.3 `@deepseek-ai/dsh-typert-protocol`

**职责摘要**：RPC/type protocol。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/typert/typert-protocol`
- NPM scope：`@deepseek-ai/dsh-typert-protocol`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- RPC/type protocol，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.46.4 `@deepseek-ai/dsh-typert-registry`

**职责摘要**：Runtime registry。

### 设计位置
- 层次：平台能力层
- 包路径：`packages/typert/typert-registry`
- NPM scope：`@deepseek-ai/dsh-typert-registry`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Runtime registry，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 7.47 `packages/workflow` 深入分析

> 这一组共 3 个 package。命名和职责按照 commit `141eb6f` 的 module graph / group README 组织。

## 7.47.1 `@deepseek-ai/dsh-tool-ralph`

**职责摘要**：Model-facing Ralph loop tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/workflow/tool-ralph`
- NPM scope：`@deepseek-ai/dsh-tool-ralph`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing Ralph loop tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.47.2 `@deepseek-ai/dsh-tool-workflow`

**职责摘要**：Model-facing workflow tool。

### 设计位置
- 层次：Model-facing consumer/tool 层
- 包路径：`packages/workflow/tool-workflow`
- NPM scope：`@deepseek-ai/dsh-tool-workflow`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Model-facing workflow tool，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过工具注册/执行边界进入 loop；真正执行一定经过 tool pipeline。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
LLM tool-call
  ↓
tool registry
  ↓
pre-execute/guard/approval
  ↓
executor
  ↓
post-execute/result
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

## 7.47.3 `@deepseek-ai/dsh-workflow`

**职责摘要**：Workflow seam and worker-thread engine。

### 设计位置
- 层次：工作流编排层
- 包路径：`packages/workflow/workflow`
- NPM scope：`@deepseek-ai/dsh-workflow`
- 推荐阅读入口：该 package 的 `README.md` → `package.json` → `src/index.ts`/对应入口 → Service Definition → Provider → tests。

### 为什么单独存在这个 package
- Workflow seam and worker-thread engine，并通过独立 package 保持依赖边界。
- 该 package 的价值不是“把所有逻辑集中起来”，而是把一个能力从 Harness 其他部分解耦出来。
- 如果能力未来需要替换 provider，应优先保留 package 的 Service Definition 和消费者接口。

### 通常需要关注的代码层次
1. `package.json`：看 `name`、`peerDependencies`、exports、构建入口。
2. `src/index.ts`：看公开 API 和 plugin export。
3. Service Definition：看 `ctx` key、接口、事件/waterfall。
4. Provider：看 `ctx.effect()` 如何安装具体实现。
5. Consumer/Tool：看谁调用这个 service，以及请求如何进入主 loop。
6. Tests：看官方希望该 package 保证的 invariants 和边界。

### 依赖方向
- 优先依赖 protocol/service seam，不应反向耦合具体 consumer。
- 高层 composition 可以依赖多个 package；底层 definition package 不应依赖 UI。
- 如果属于 Provider，则 provider 依赖同组 service definition；如果属于 Tool，则 tool 依赖 Agent/Tools/LLM/Session 等消费者边界。

### 启动/装载时发生什么
- 根 Cordis context 创建后，profile/bundle 按 patch 层装载插件。
- Service package 通过 effect 或 service constructor 注册 context capability。
- Provider 在 service available 后进入 context，consumer 订阅该 service。
- 如果 plugin unload，则 effect teardown 会撤销注册，避免留下“半死服务”。

### 与 AgentLoop 的关系
- 该 package 通过自己的 service seam 被 AgentLoop 或外围 orchestrator 间接使用，不要求 loop 直接依赖其具体实现。

### 源码阅读问题清单
- 谁创建这个对象/service？
- 谁持有它的生命周期？
- 哪个 ctx key 暴露它？
- 哪些事件会触发它？
- 哪些 effect 在 unload 时需要回滚？
- 它是 definition、provider 还是 consumer？
- 它会进入 Session 事实源吗？
- 它是否影响 model-visible context？
- 它是否需要 approval/sandbox？
- 是否可由另一个 provider 替换？

### 典型数据流
```text
Cordis Context
  ↓
Service Definition
  ↓
Provider
  ↓
Consumer
```

### 对二次开发的启示
- 新业务优先新建 provider/tool/client module，而不是修改核心 loop。
- 需要可替换的能力，先定义 seam，再写 provider。
- 需要用户实时可见的变化，优先建立 typed event，再接 UI。
- 需要高风险执行的能力，必须接 approval + guard + sandbox。
- 需要持久化和审计的状态，应进入 Session 或专用 persistence/storage service，而不是只存在插件内存里。

- **API稳定性**：把 public types 收敛到 index.ts；内部实现通过 exports map 隔离。
- **测试**：测试应覆盖状态 transition、provider mount/unmount、错误回滚和竞态。
- **错误**：区分 setup/creation 失败、provider terminal error、tool denial、业务异常。
- **并发**：明确 owner/context/fiber，避免 stale disposer 删除后来重新发布的同 ID 对象。
- **可观测**：Session event 与 telemetry 分开：Session 是事实源，OTel 是观测系统。
- **安全**：模型产出的 Tool Call 永远不等于已授权执行。
- **扩展**：Provider 不应成为 consumer 的类型依赖目标。
- **部署**：bundle/profile 决定哪些 plugin 被 mount。
- **UI**：client package 不直接读取 host implementation；通过 connection/remotes/events。
- **升级**：优先固定 commit，并围绕 documented seam 编写适配层。

# 8. 核心源码文件级阅读导览

## `packages/core/agent-loop/src/agent.ts`

最重要的 concrete loop 实现。阅读重点：Agent 创建/恢复、owner/fiber、turn/step lifecycle、inbox claim、LLM prepare/dispatch、tool group、cancel/wake、assistant completion anchor、teardown。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

## `packages/core/agent-loop/src/tool-calls.ts`

阅读工具调用组如何进入循环、如何支持并发、如何汇总 tool results，以及如何与当前 turn 的取消信号关联。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

## `packages/core/agent-loop/src/runtime-context.ts`

阅读 driver 如何围绕具体 Agent 形成 operation-local runtime context；重点关注服务依赖与 lifecycle boundary。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

## `packages/core/agent/src/dispatch.ts`

Agent 公共 dispatch 边界；这里是 caller 到 loop 的“薄壳”，不要让它泄漏 concrete driver。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

## `packages/core/agent/src/inbox.ts`

理解 followup/steer/inject；核心是 next-turn 与 next-step 两个队列、splice 事件、claim、MessageId 唯一性。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

## `packages/core/agent/src/model-selection.ts`

理解 session-local provider/model selection 与 default model 的职责分离。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

## `packages/core/tools/src/*`

阅读 tool registration、execution waterfall、result finalization 和 tool events。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

## `packages/core/session/src/*`

阅读 Session append、message surface、turn/step、derived history、observer 与 projection 机制。

建议问题：
- 输入是什么？
- 输出/事件是什么？
- 调用了哪个 ctx service？
- 写了哪些 Session event？
- 失败会不会回滚？
- 是否影响下一 step 的 model-visible history？

# 9. 启动流程

## CLI / web local launch

```text
1. 命令行入口解析 profile / config。
2. boot 负责 shared application-bin glue。
3. bundle/profile 决定要 mount 的 plugin layers。
4. Cordis root context 建立并依次安装 Service Definitions / Providers / Consumers。
5. Host web server 建立本地 HTTP/WebSocket endpoint。
6. client modules 被暴露给 browser runtime。
7. Agent entry point 通过 ctx.agents / agentLoop 创建 session。
```

## Programmatic Agent create

```text
1. 调用 `ctx.agents.create({ sessionId, meta, seed, agentOptions, setup })`。
2. AgentLoop 准备私有 session + concrete agent + scoped context。
3. setup 在 unpublished state 中运行。
4. session/created → agent/created → agent/session-start。
5. 返回 AgentHandle，caller 负责 public teardown。
```

## Resume existing session

```text
1. 要求存在 persistence backend。
2. 读取 persisted session id。
3. 重建 turn numbering 与 derived history。
4. 在新的 unpublished scope 上做 setup。
5. 完成 publication 后继续后续 turn。
```

## Web UI request

```text
1. Browser 通过 client connection / API remotes 发送消息。
2. Host/API gateway 将请求映射到 Agent control boundary。
3. AgentLoop 进入 turn。
4. Session 是事实源，UI 根据事件和 projection 展示轨迹。
```

# 10. 每个 Package 的文件阅读顺序（通用模板）

对于每个 `packages/<group>/<pkg>`，推荐按照下面顺序真正阅读代码：

1. `README.md`：先知道 package 的职责、ctx key、Public API、Model Experience、Known Limitations。
2. `package.json`：确认 peerDependencies、exports、build entry、脚本。
3. `src/index.ts`：确认真正对外开放的 symbol。
4. Service Definition：找到 ctx service/interface。
5. Provider：找到 concrete implementation 如何 `ctx.effect()` 注册。
6. Consumer：检查 AgentLoop/Tool/UI/Host 如何依赖该接口。
7. tests：按 invariant / lifecycle / error / replay / concurrency 分类。
8. 如果存在 `invariant.ts`：把它作为“代码自带的设计约束”阅读。
9. 如果存在 `config`：先理解 runtime mutable settings 与 startup-only config 的边界。
10. 如果存在 client package：再看 UI module / slots / connection / remotes。

# 11. 如果你要基于 Harness 做 LR-Agent，最应该改哪里

对于你前面提出的 Document Workspace / OfficeCLI / GIS / Cloud Agent 需求，建议：

- `lr-document`：依赖 `dsh-agent`、`dsh-tools`、`dsh-session`，通过自有 Service Definition 暴露 Document Workspace。
- `lr-document` 的 OfficeCLI adapter 作为 concrete provider，不让 Agent 直接执行 shell。
- 文档操作定义为 typed operation/event，并写入 session/专用 document journal。
- 实时预览通过 `clientModules` 接入；Chat 轨迹继续使用既有 conversation UI/trajectory 体系。
- Cloud Agent 依赖 credentials + tools + jobs，不让模型持有长期 secret。
- GIS Agent 定义 `GISProvider` seam；前端通过 client module 挂载 Map Workspace。
- 批处理/索引/渲染/导出使用 jobs/workflow，不阻塞 AgentLoop。
- 高风险写操作接 interaction/approval + guard + sandbox。

# 12. 本手册的核心官方依据

- 仓库 commit：`141eb6fef83422698aef7a981029e843e8161534`
- 仓库 README：确认 Harness = Everything is a Plugin、Developer Preview、启动命令与 MIT License
- docs/architecture.md：Cordis、Plugin-first architecture、Agent/Tool/Session/Loop replaceability
- docs/capability-seams.md：Service Definition / Provider / Consumer 与 ctx key 映射
- docs/tool-execution-pipeline.md：tool-call → pre-execute → guards → approval → execute → post-execute → finalize → result
- docs/module-graph.md：按 peerDependencies 生成的全包依赖图
- packages/core/README.md：core spine package map
- packages/core/agent-loop/README.md：具体 loop 的生命周期和 driver 细节
- packages/core/agent/README.md：Agent public contract / event vocabulary
- packages/core/session/README.md：Session event-sourced fact source / derived message surface
- packages/core/tools/README.md：Tool registry and execution pipeline

# 13. 精确性与覆盖率说明

## 已确认
- 目标 commit 精确为 `141eb6fef83422698aef7a981029e843e8161534`。
- 该 commit 对应 `dsh@0.1.0-rc.8` release merge。
- packages group / package 命名来自该 commit 自带的 generated module graph。
- AgentLoop/Agent/Session/Tools 的关键源码目录在该 commit 可直接核验。
- 官方 architecture/capability-seams/tool-execution-pipeline 文档与该 commit 对应。

## 不应过度声称的部分
- 当前环境不能一次性 clone 完整 GitHub 仓库，因此无法在本地对所有叶子源码文件做 AST/符号级扫描。
- 测试、vendor、生成文件和大量 client leaf files 的逐文件函数级说明没有虚构；本手册只对能从官方目录/README/依赖图确认的职责做结论。
- 如果需要下一版真正达到“每个 `.ts/.tsx/.py/.rs/.c/.h` 文件、每个 export、每个 class/function、跨文件调用关系”的零遗漏手册，需要提供该 commit 的仓库 tar.gz/zip，或允许一个可直接拉取的代码工作区。

# 14. 一句话掌握 Harness

```text
Cordis = 插件运行时与上下文骨架
Agent = 对外 Agent 契约
AgentLoop = 默认具体驱动
Session = 事实源
SystemPrompt = model-visible context 装配
LLM = 可替换模型适配 seam
Tools = 模型动作执行边界
Approval/Guard/Sandbox = 安全边界
Jobs/Workflow = 长任务与编排
Client/Host = 产品 UI / HTTP 层
Bundle/Profile = 运行时组合
Plugin = 一切能力的装载与卸载单位
```

# 15. 既有代码阅读稿补充（作为交叉阅读材料）

> 下方内容来自前一版仓库代码阅读稿，主要用于保留先前已经整理过的工程解释；本手册的精确 commit 结论以上述 `141eb6f` 章节为准。

## 1. 结论先行：DeepSeek Harness 到底是什么

DeepSeek Harness（`dsh`）不是一个传统意义上的“Agent 类库”，而是一个 **插件优先的 Agent Runtime / Application Harness**。

它的核心理念是：

```text
Everything is a Plugin
```

官方架构文档明确说明：模型适配器、Tool Registry、Session Log、Agent Loop 本身都是插件；系统没有一个需要被持续修改的“特权核心”，新能力应该通过插件挂载到现有 capability seam 上。citeturn593225view1

因此，从代码阅读角度，最重要的不是从 `main()` 往下找，而是理解以下四个概念：

```text
Cordis Context
      │
      ├── Service
      ├── Event
      ├── Effect
      └── Scoped Plugin

Capability Seam
      │
      ├── Service Definition
      ├── Provider
      └── Consumer

Agent Runtime
      │
      ├── Session
      ├── Agent
      ├── AgentLoop
      ├── LLM
      └── Tools

Application Composition
      │
      ├── Profile
      ├── Bundle
      └── cordis.patch.yml
```

这也是你之前准备开发的 Document Agent、Cloud Agent、GIS Agent 最适合插入 Harness 的原因。

---

# 2. 当前仓库总体目录树

根据当前 GitHub `master` 根目录，仓库主要包含：

```text
DeepSeek-Harness/
│
├── .agents/
├── .claude/
├── .github/
│
├── apps/
│   ├── cli/
│   └── web/
│
├── assets/
├── docs/
├── examples/
│
├── native/
│   └── landlock-run/
│
├── packages/
│   ├── core/
│   ├── api/
│   ├── attachment/
│   ├── boot/
│   ├── bundle/
│   ├── client/
│   ├── code-runtime/
│   ├── compaction/
│   ├── context/
│   ├── credentials/
│   ├── e2b/
│   ├── extensions/
│   ├── feedback/
│   ├── fs/
│   ├── goal/
│   ├── guard/
│   ├── hooks/
│   ├── host/
│   ├── identity/
│   ├── interaction/
│   ├── jobs/
│   ├── llm/
│   ├── lsp/
│   ├── mcp/
│   ├── plan/
│   ├── preset/
│   ├── sandbox/
│   ├── schedule/
│   ├── sdk/
│   ├── session/
│   ├── session-query/
│   ├── settings/
│   ├── shell/
│   ├── skill/
│   ├── spill/
│   ├── storage/
│   ├── subagent/
│   ├── subprocess/
│   ├── terminal/
│   ├── test-support/
│   ├── todo/
│   ├── typert/
│   ├── util/
│   ├── web/
│   ├── workflow/
│   └── workspace/
│
├── patches/
├── python/
│   ├── sdk/
│   └── sdk-runtime/
│
├── scripts/
├── vendor/
│   ├── cordis/
│   ├── cosmokit/
│   ├── group/
│   ├── hmr/
│   ├── include/
│   ├── loader/
│   ├── logger-console/
│   ├── schemastery/
│   └── timer/
│
├── website/
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig*.json
├── vitest*.config.ts
├── tsdown.config.ts
└── LICENSE / THIRD_PARTY_NOTICES.md / README*.md
```

根目录的 `package.json` 明确说明 workspace 包括 `vendor/*`、`packages/*/*`、`native/landlock-run`、`apps/*` 和 `website`；使用 pnpm 11.7.0，Node 约束为 `^22.19.0 || >=24.0.0`。citeturn688544view2

---

# 3. 顶层目录职责

## 3.1 `apps/`

应用入口，而不是核心业务能力。

当前明确有：

```text
apps/cli/
apps/web/
```

### `apps/cli/`

`dsh` 命令行启动器。

当前树可确认：

```text
apps/cli/
├── config/agent-presets/
├── reference/
├── src/
├── tests/
├── composition.md
├── package.json
├── tsconfig.json
└── tsdown.config.ts
```

核心源码入口：

```text
apps/cli/src/args.ts
apps/cli/src/bin.ts
```

`args.ts` 负责 CLI 参数/命令语法；`bin.ts` 负责选择 profile / runner、完成应用启动。官方 README 还明确说明 CLI 只解析属于 launcher 的参数，然后把后续参数交给具体 profile/app 插件。citeturn267953view0

### `apps/web/`

当前树：

```text
apps/web/
├── public/
├── src/
├── stress-tests/
├── tests/
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

它是 Web 构建入口；真正的浏览器业务组件主要在 `packages/client/*`。citeturn267953view1

---

# 4. `packages/`：整个 Harness 的核心

官方 `packages/README.md` 把 package family 分为 Product API spine、Capability family、UI、Persistence、SDK 等多个集合。citeturn593225view0

最关键规则：

```text
Extension Plugin
      ↓
依赖 Service Definition
      ↓
不能直接依赖 Provider
```

也就是说：

```text
Good:
Document Plugin → Document Service Definition

Bad:
Document Plugin → 某个具体 Office Provider 实现
```

这就是 Harness 的 Capability Seam 思维。citeturn593225view0turn593225view1

---

# 5. `packages/core/` —— Agent 产品 API Spine

当前目录：

```text
packages/core/
├── agent-default-model/
├── agent-loop/
├── agent-tool-presentation/
├── agent/
├── scope/
├── session/
├── system-prompt/
├── tools/
└── README.md / README.zh.md / README.i18n.yaml
```

官方定义为：

> session、prompt、tools、agent services 和 concrete loop 构成的产品 API spine。citeturn836207view0

---

## 5.1 `packages/core/agent/`

### 关键文件

```text
packages/core/agent/src/index.ts
packages/core/agent/src/types.ts
packages/core/agent/tests/agent.spec.ts
packages/core/agent/README.md
```

### `src/types.ts`

核心职责是定义 Agent 公共协议，例如：

- Agent 标识
- session 关联
- turn / step 相关类型
- Agent 输入/输出
- lifecycle event vocabulary
- interruption / cancellation 相关契约

### `src/index.ts`

负责把 Agent 公共类型、Agent Service / Registry 和插件接口导出出来，并把 `ctx.agents` 作为 Harness 上层可依赖的稳定 seam。

### 为什么它重要

`agent/` 与 `agent-loop/` 是刻意分开的：

```text
agent/
  = Agent Contract

agent-loop/
  = Default Implementation
```

因此可以替换 Agent Loop，而不破坏依赖 `ctx.agents` 的插件。官方架构也明确强调 `agent` 是公共 contract，`agent-loop` 是默认实现。citeturn556704view0

---

# 6. `packages/core/agent-loop/` —— 真正的 Agent Loop

这是整个项目最值得优先阅读的代码包。

当前 DeepWiki 索引确认的源码文件：

```text
packages/core/agent-loop/src/agent.ts
packages/core/agent-loop/src/index.ts
```

测试文件包括：

```text
agent.spec.ts
cancel.spec.ts
config-session-id.spec.ts
contract-regressions.spec.ts
coverage-edges.spec.ts
interception.spec.ts
loop.spec.ts
resume.spec.ts
```

citeturn556704view0turn355674view0

---

## 6.1 `src/agent.ts`

核心类是默认的 `ReactLoopAgent`。

它负责：

```text
创建 Agent Handle
        ↓
关联 Session
        ↓
从 inbox 接收输入
        ↓
组装 system prompt/tool schemas
        ↓
调用 ctx.llm
        ↓
解析 stream
        ↓
触发 tool execution
        ↓
形成下一 step
        ↓
结束 turn
```

官方架构对一次 turn 的定义是：

```text
turn/start
  ↓
claim input
  ↓
agent/pre-step
  ↓
step/start
  ↓
agent/request
  ↓
llm/stream
  ↓
assistant/chunk*
  ↓
assistant/message
  ↓
tool/call*
  ↓
tools/pre-execute
  ↓
tools/execute
  ↓
tools/post-execute
  ↓
tool/result*
  ↓
step/end
  ↓
继续或关闭 turn
```

citeturn593225view1

### 关键理解

一个 `Step` ≠ 一次完整用户请求。

```text
Turn
 ├── Step 1: LLM → Tool A
 ├── Step 2: LLM → Tool B
 └── Step 3: LLM → Final Answer
```

这是理解 Harness “agent loop”的关键。

---

## 6.2 `src/index.ts`

负责注册/导出 `AgentLoop` Service Definition/implementation，使其挂载为：

```text
ctx.agentLoop
```

Agent contract 与 concrete driver 分离，是插件化关键。

---

## 6.3 `tool-calls.ts`

当前 architecture/DeepWiki 索引引用了：

```text
packages/core/agent-loop/src/tool-calls.ts
```

它承担 tool-call 执行侧的组装/分派逻辑：

```text
LLM Stream
   ↓
tool_calls
   ↓
parse calls
   ↓
ctx.tools
   ↓
parallel/sequential execution
   ↓
tool/result
```

它是“模型输出”到“工具执行”之间的重要桥梁。

---

# 7. `packages/core/tools/` —— Tool Runtime

这是第二个必须精读的核心模块。

官方定义：

> Scoped tool registry and guarded execution pipeline。citeturn593225view1

核心上下文服务：

```text
ctx.tools
```

工具不是普通函数注册表，而是一个带 lifecycle / guard / event waterfall 的执行系统。

---

# 8. Tool Pipeline

Harness 的 Tool Pipeline 核心流程：

```text
model tool_call
      ↓
tools/pre-execute
      ↓
approval / guards / policy
      ↓
tools/execute
      ↓
actual provider/tool
      ↓
tools/post-execute
      ↓
tool/result
```

这是 LR-Agent 做文档修改时最关键的接入点：

```text
document.read
 → ALLOW

document.modify
 → ASK

document.commit
 → ASK

document.delete
 → DENY/ASK
```

而不应该由模型自己绕过 Tool Pipeline 去调用 shell。citeturn593225view1

---

# 9. `packages/core/system-prompt/`

上下文服务：

```text
ctx.systemPrompt
```

职责：

- system prompt section 注册
- tool schema 汇总
- prompt ordering
- 模型可见的能力描述

对 Agent 来说：

```text
Plugin
 ↓
注册 prompt section
 ↓
注册 tools
 ↓
SystemPrompt Builder
 ↓
LLM Request
```

因此新能力不是写死到一份巨型 prompt，而是由插件贡献到 prompt assembly。

---

# 10. `packages/core/session/`

Session 是整个系统的“事实源”。

官方说明：

> Session log is the source of the context the model sees.

并且：

> Model-visible means logged.citeturn593225view1

当前 group 内又分出大量 durable-session packages，见后文 `packages/session/`。

### 核心设计

```text
SessionEvent append-only log
             ↓
deriveMessages()
             ↓
LLM-visible history
```

因此：

```text
UI 状态
不是事实源

模型 history
不是事实源

Session Log
才是事实源
```

这对你的 Document Workspace 极其重要：

```text
document/operation-created

document/operation-completed

document/version-created
```

都应该成为 Session Event 或可由 Session Log 重建的状态。

---

# 11. `packages/core/scope/`

作用：Agent 级 scoped registration primitive。

它解决的是：

```text
全局 Tool
vs.
某个 Agent 私有 Tool
```

一个典型使用模型是：

```text
ctx.agents
   ↓
agent.ctx
   ↓
scoped registrations
```

用于实现不同 Agent / preset 具有不同能力集合。

---

# 12. `packages/core/agent-default-model/`

职责：

```text
ctx.agentDefaultModel
```

用于 Agent entry point 在 session 没有显式 model selection 时选择部署默认模型。

重要的是：它不应该让具体 Agent implementation 绑定某个具体厂商模型。

---

# 13. `packages/core/agent-tool-presentation/`

从 package 命名和产品结构看，它处在：

```text
Tool Runtime
      ↓
Agent
      ↓
UI presentation
```

负责把 tool / Agent 能力的结果以适合客户端呈现的形式暴露。

这个 package 对你的 Document Operation UI 值得重点研究：它可以作为“工具执行 → UI 展示”的桥接层参考。

---

# 14. LLM Family：`packages/llm/`

官方定义：

```text
ctx.llm
```

是提供商无关的 LLM 能力 seam。

Capability graph 中当前可以确认：

```text
packages/llm/
├── llm/
├── llm-deepseek/
├── llm-pi-ai/
└── llm-replay/

另外：
llm/token-meter
```

citeturn778997view0turn778997view1

---

## 14.1 `llm/`

负责：

- Message vocabulary
- StreamChunk vocabulary
- Adapter registry
- Provider-independent streaming interface

核心设计：

```text
AgentLoop
   ↓
ctx.llm
   ↓
Adapter
   ├── DeepSeek
   ├── PI AI
   └── Replay
```

因此 Agent Loop 不知道：

```text
HTTP endpoint
SDK
OpenAI wire format
DeepSeek wire format
```

它只使用统一 stream abstraction。

---

## 14.2 `llm-deepseek/`

负责实际 DeepSeek provider adapter。

职责包括：

- credentials
- provider config
- request translation
- stream translation
- provider error mapping

它依赖：

```text
ctx.credentials
ctx.settings
ctx.llm
```

官方 capability graph 明确把 `llm-deepseek` 列为 `ctx.llm` provider，并由 credentials/settings 供其配置。citeturn778997view1turn778997view2

---

## 14.3 `llm-pi-ai/`

提供另一种 LLM transport/adapter 层，并且会和 attachment/credentials/settings/runtime 发生联系。

它说明 Harness 的核心并不要求“只允许 DeepSeek”。

---

## 14.4 `llm-replay/`

测试/回放使用。

核心价值：

```text
真实LLM
   ↓
录制
   ↓
Replay Provider
   ↓
确定性测试
```

这种模式对于 Document Agent 特别重要，可以让：

```text
真实LLM结果
```

与：

```text
Document operation engine
```

分离测试。

---

## 14.5 `token-meter/`

提供：

```text
ctx.tokenMeter
```

主要服务于：

- replay token measurement
- compaction pressure
- token accounting

能力图中它被 `compaction-basic` 消费。citeturn778997view2

---

# 15. Session Family：`packages/session/`

当前 group 包括：

```text
session-persistence
session-persistence-jsonl
session-persistence-sqlite
session-checkpoint-policy
session-projection
session-projection-cache
session-stats
session-telemetry
session-telemetry-otel
session-title
session-title-llm
session-title-first-prompt-llm
session-title-all-prompts-llm
```

官方 package README 明确把它定义成 Durable Session Data Plane。citeturn836207view2

---

## 15.1 `session-persistence/`

定义持久化 seam：

```text
ctx.sessionPersistence
```

负责：

- durable write coordination
- persistence interface
- session durability contract

---

## 15.2 `session-persistence-jsonl/`

把 Session Event 持久化成 JSONL。

优势：

- 人类可读
- 调试方便
- append-friendly
- 适合本地数据

---

## 15.3 `session-persistence-sqlite/`

SQLite 后端。

优势：

- 查询快
- 适合 UI
- 全文/关系查询方便
- 单机产品友好

---

## 15.4 `session-checkpoint-policy/`

决定什么时候需要进行语义持久化 checkpoint。

官方说明它会包裹 `ctx.llm` 与 `ctx.tools`。

这对于文档编辑任务非常有价值：

```text
每一个关键 Document Operation
        ↓
checkpoint
```

---

## 15.5 Projection系列

```text
session-projection
session-projection-cache
session-stats
```

用途：

```text
Session Log
   ↓
Projection
   ↓
Client State
```

而不是让浏览器自行扫描完整 JSONL。

---

## 15.6 Title系列

```text
session-title
session-title-llm
session-title-first-prompt-llm
session-title-all-prompts-llm
```

用途：

```text
session log
 ↓
标题策略
 ↓
UI conversation list
```

---

# 16. `packages/session-query/`

这不是 Session 持久化本身，而是 Session Retrieval 层。

能力包括：

- bounded reads
- lineage
- event relationships
- semantic filtering
- SQLite full-text search
- cross-session references

因此形成：

```text
Session
  ├── write
  ├── projection
  ├── persistence
  └── query
```

这个拆分非常合理。

---

# 17. Filesystem Family：`packages/fs/`

Capability graph：

```text
ctx.fs
```

当前 provider 包括：

```text
fs
fs-local
fs-e2b
fs-sandbox
fs-observation-policy
```

citeturn778997view0

消费者主要是：

```text
tool-fs
agent/tooling
```

---

## 17.1 `fs/`

定义 filesystem seam。

它告诉上层：

```text
read
write
list
search
stat
```

怎么操作，但不规定底层一定是 local disk。

---

## 17.2 `fs-local/`

真正访问本机文件系统。

---

## 17.3 `fs-sandbox/`

在 sandbox policy 下访问文件。

---

## 17.4 `fs-e2b/`

把 filesystem seam 接到 E2B sandbox。

这正是 Capability Seam 的最佳示例：

```text
same consumer
     ↓
fs local
or
fs sandbox
or
fs e2b
```

无需重写 `tool-fs`。

---

# 18. Shell / Subprocess / Terminal

三个层次要区分：

```text
Subprocess
   ↓
Shell
   ↓
Terminal
```

## `packages/subprocess/`

抽象“启动和管理 process tree”。

上下文：

```text
ctx.subprocess
```

当前 provider：

```text
subprocess-local
subprocess-e2b
```

---

## `packages/shell/`

上下文：

```text
ctx.shell
```

负责 Bash executor seam。

provider：

```text
bash-local
bash-sandbox
pwsh-local
```

consumer：

```text
tool-bash
tool-pwsh
```

---

## `packages/terminal/`

上下文：

```text
ctx.terminals
```

它管理 persistent PTY sessions。

当前结合：

```text
terminal-bash
tool-terminal
```

区别于 shell 的一次性命令，Terminal 是持续交互式会话。

---

# 19. Sandbox Family

```text
packages/sandbox/
├── sandbox
├── sandbox-local
└── sandbox-policy
```

上下文：

```text
ctx.sandbox
ctx.sandboxPolicy
```

作用：

```text
Agent Command
      ↓
Policy
      ↓
argv wrapping
      ↓
Sandbox
      ↓
Process
```

---

# 20. Native `landlock-run`

Linux 原生沙箱执行器。

当前目录：

```text
native/landlock-run/
├── docs/
├── packages/
├── scripts/
└── test/
```

官方说明其核心是一个约 300 行 C11 的 self-restrict-then-exec launcher：

```text
landlock-run
  ↓
安装 Landlock ruleset
  ↓
exec wrapped command
```

限制会继承到子进程，但调用 Harness 自身不受限制；如果当前 kernel 无法安全实施则 fail-closed。citeturn147563view0

这是安全执行 Agent Shell/Tool 的底层支撑之一。

---

# 21. `packages/code-runtime/`

能力：

```text
ctx.codeRuntime
```

当前：

```text
code-runtime
code-runtime-worker
```

职责：

- 代码运行时 seam
- worker-thread provider
- Code Mode consumer

这说明 Harness 不只是“工具调用框架”，还在建立一个：

```text
LLM → Code → Runtime
```

的执行模型。

---

# 22. `packages/subagent/`

上下文：

```text
ctx.subagents
```

当前实现包括：

```text
subagent
subagent-acp
subagent-claude-code
subagent-codex
subagent-dsh-sdk
subagent-spawn-in-process
subagent-fork-in-process
```

以及控制工具：

```text
tool-subagent
tool-subagent-control
tool-ralph
```

能力模型：

```text
Parent Agent
    ↓
Subagent Runtime
    ├── in-process child
    ├── forked child
    ├── ACP agent
    ├── Claude Code
    ├── Codex
    └── DSH SDK runtime
```

这对大型 Document Workflow 很重要：

```text
主Agent
  ├── 文档分析子Agent
  ├── 版式检查子Agent
  └── 数据核验子Agent
```

---

# 23. `packages/jobs/`

上下文：

```text
ctx.jobs
```

当前：

```text
jobs
jobs-local
tool-jobs
```

用途：

- background jobs
- long-running operations
- status
- stop/cancel
- result retrieval

适合：

```text
PDF OCR
大批量索引
Office Render
GIS Analysis
Cloud Sync
```

---

# 24. `packages/workflow/`

上下文：

```text
ctx.workflowEngine
```

当前：

```text
workflow
workflow-worker-thread
tool-workflow
tool-ralph
```

它把 Agent 从单步工具调用提升到：

```text
Task A
 ↓
Task B
 ↓
Condition
 ↓
Task C
```

适合构造完整 Agent Workflow。

---

# 25. Web Capability

`packages/web/` 提供：

```text
ctx.web
```

当前实现：

```text
web-search-exa
web-search-perplexity
web-search-deepseek
web-fetch-http
```

消费者：

```text
tool-web
```

模型只看到统一的 web tools，而不会直接依赖某家搜索服务。

---

# 26. Attachment / Spill / Storage

## `packages/attachment/`

上下文：

```text
ctx.attachments
```

作用：

- durable attachment identity
- validation
- local content-addressed storage

当前 provider：

```text
attachment-local
```

对你的 Document Agent 很重要，因为用户上传的 DOCX/PDF/XLSX 可以先形成 durable attachment，再进入 Session。

---

## `packages/spill/`

上下文：

```text
ctx.spillStore
```

作用：处理超大 tool result 的 spill。

避免：

```text
Huge Tool Result
 ↓
Directly塞进LLM context
```

而是：

```text
Tool Result
 ↓
Spill Storage
 ↓
Reference
```

---

## `packages/storage/`

上下文：

```text
ctx.storage
ctx.storageDomain
```

当前：

```text
storage
storage-json
storage-sqlite
storage-domain
```

职责：非 Session 的数据存储 hub。

---

# 27. Credentials / Settings / Identity

## `packages/credentials/`

上下文：

```text
ctx.credentials
```

当前 provider：

```text
credentials-local
```

特点：env over `.env` provider。

对企业产品而言非常关键，因为：

```text
Agent
不能自己持有长期 Secret
```

---

## `packages/settings/`

上下文：

```text
ctx.settings
```

当前 provider：

```text
settings-file
```

用于用户级配置。

---

## `packages/identity/`

提供 shared anonymous identity。

适合：

- anonymous installation ID
- telemetry attribution
- local user identity

---

# 28. Goal / Todo / Plan / Feedback / Interaction

这些模块共同组成 Human Collaboration Plane。

## `goal/`

```text
ctx.goals
```

负责 same-session objective persistence。

## `todo/`

模型可调用：

```text
todo_write
```

## `plan/`

```text
ctx.planMode
```

支持：

```text
Plan
 ↓
Review
 ↓
Execution
```

## `feedback/`

```text
ctx.messageFeedback
```

处理人类反馈。

## `interaction/`

当前涉及：

```text
approval
permission presets
commands
ask-user
user questions
```

上下文包括：

```text
ctx.approval
ctx.permissionPresets
ctx.commands
ctx.userQuestions
```

对“WorkBuddy 式文档实时修改”而言，这一组包是必须研究的。

---

# 29. Skill / Preset / Bundle / Extensions

## `packages/skill/`

```text
ctx.skills
```

负责：

- provider registry
- local provider
- skill catalog / loader

Skill 是“模型可理解的额外能力包”，与 Tool 更强调操作接口不同。

---

## `packages/preset/`

Agent Composition：

```text
per-session agent composition
```

通过 preset 的 `cordis.yml` 选择：

```text
有哪些 services
有哪些 tools
用哪个 model
启用哪个 policy
```

这对于：

```text
普通Agent
OfficeAgent
GISAgent
DeveloperAgent
```

非常适合。

---

## `packages/bundle/`

Bundle 是可安装分发的 patch layer。

比如：

```text
dsh-base
dsh-web-app
dsh-headless
```

官方 architecture 明确说明 profile 会按 bundle 顺序叠加 patch，再叠加 profile/home/CLI overlay。citeturn593225view1

---

## `packages/extensions/`

这是很特殊的一层：

> Agent runtime self-modification

它允许 Agent：

```text
inspect plugin/service
mount plugin
unmount plugin
```

也就是 Harness 开始支持“Agent 改造自己的运行环境”。

商业环境要特别注意权限边界。

---

# 30. API / Typert / SDK

## `packages/typert/`

当前角色：

- type graph generation
- runtime registry
- artifact loading

核心 context：

```text
ctx.typert
```

---

## `packages/api/`

核心：

```text
ctx.typertGateway
```

负责 Remote BFF / Typert RPC gateway。

---

## `packages/sdk/`

当前定位：

> Out-of-process runtime SDK

包括：

```text
JSON-RPC protocol
TypeScript client
server plugin
```

这样外部程序可以：

```text
External Process
      ↓
JSON-RPC
      ↓
Harness Runtime
```

---

## `python/sdk/`

Python SDK 进一步把上面的能力带到 Python。

当前目录：

```text
python/
├── sdk/
└── sdk-runtime/
```

官方说明：Python 客户端通过 newline-delimited JSON-RPC over stdio 与 bundled runtime 通信。citeturn147563view2

这意味着 Python 不直接重新实现整个 Agent Runtime，而是作为外部控制端。

---

# 31. Host / Client / Web UI

这是理解 Harness GUI 的关键部分。

```text
packages/host/
packages/client/
apps/web/
```

形成：

```text
Browser
  ↕
Client Runtime
  ↕
Host
  ↕
API / Cordis Runtime
```

---

# 32. `packages/host/`

定位：

> Web-GUI host half: API gateway + HTTP route server

能力：

```text
ctx.apiProxy
ctx.webServer
```

负责：

- Host API dispatch
- HTTP routes
- browser bridge
- WebSocket / event carrier

---

# 33. `packages/client/`

当前 group 是一个非常大的前端 package family。

确认的子包包括：

```text
connection
hmr
locale
modules
runtime
schema-form
ui-agent-preset
ui-attachment
ui-commands
ui-conversation
ui-deliverables
ui-directory-picker-browse
ui-directory-picker-native
ui-goal
ui-input-trigger
ui-jobs
ui-layout
ui-message-feedback
ui-model-selection
ui-permission-presets
ui-plan
ui-primitives
ui-settings-general
ui-settings-models
ui-settings-plugin-inventory
ui-settings-plugins
ui-settings
ui-sidebar
ui-skill
ui-slots
ui-subagent
ui-theme
ui-tool
ui-trajectory
ui-user-questions
ui-workflow-run
ui-workspace
web-react
web
```

citeturn836207view1

---

## 33.1 `client/web/`

浏览器 shell boot entry。

已确认：

```text
packages/client/web/src/boot.tsx
packages/client/web/src/index.ts
```

职责：

```text
client modules
 ↓
boot shell
 ↓
React runtime
```

---

## 33.2 `client/modules/`

负责加载 browser-side client modules。

这是以后开发：

```text
Document Workspace
GIS Workspace
```

最值得挂接的位置之一。

---

## 33.3 `client/connection/`

Browser ↔ Host 的 RPC 与 event delivery。

这是：

```text
Session Event
     ↓
Browser
```

的通信基础。

---

## 33.4 `client/runtime/`

共享 client services：

- session
- workspace
- UI composition

---

## 33.5 `client/hmr/`

开发阶段重新加载 client plugins。

---

## 33.6 `client/locale/`

本地化偏好与 dictionary。

---

## 33.7 `client/schema-form/`

Schema-backed settings editor。

---

# 34. UI package 的职责地图

```text
ui-conversation
    = Chat / Conversation

ui-tool
    = Tool execution UI

ui-trajectory
    = Agent trajectory

ui-workflow-run
    = Workflow execution view

ui-jobs
    = Background jobs UI

ui-plan
    = Planning UI

ui-goal
    = Goal UI

ui-subagent
    = Subagent UI

ui-attachment
    = Attachment UI

ui-workspace
    = Workspace UI

ui-sidebar
    = Navigation

ui-settings-*
    = Configuration

ui-permission-presets
    = Permission UX
```

这组 UI plugin 的存在说明 Harness 的前端也采用了和后端一致的“Everything is a Plugin”思想。

---

# 35. Client Slots

`ui-slots` / `modules` / `client runtime` 共同构成前端可扩展表面。

对于你此前的 GIS 需求，可以设计：

```text
GIS Plugin
 ↓
client module
 ↓
workspace slot
 ↓
Map View
```

对于 Document Agent：

```text
Document Plugin
 ↓
client module
 ↓
workspace slot
 ↓
Document Viewer
```

---

# 36. `packages/mcp/`

MCP 是 Harness 对外工具互操作的重要边界。

逻辑：

```text
External MCP Server
        ↓
MCP Client/adapter
        ↓
Tool
        ↓
ctx.tools
```

它允许 Harness 接外部生态，也让后续自定义 Document/GIS 能力具备 MCP 化的可能。

---

# 37. `packages/hooks/`

Hook bridges 当前与：

```text
Claude Code
Codex
```

协议接入相关。

Capability graph 显示 hook 消费：

```text
ctx.shell
ctx.sessionPersistence
```

因此 Hook 不是独立 Agent，而是 runtime event / process integration 层。

---

# 38. `packages/lsp/`

能力：

```text
ctx.lsp
```

当前：

```text
lsp
lsp-local
lsp-stdio
tool-lsp
```

用于代码理解：

- go-to-definition
- references
- symbol lookup
- language-server operations

因此 Harness 已经具备“代码 Agent”的基础能力。

---

# 39. `packages/context/`

定义模型可见的 request context。

包括：

- workspace instructions
- time context
- contextual injection

与：

```text
agent.inject()
```

配合，把临时 context 放入下一次 admitted request。

---

# 40. `packages/compaction/`

上下文：

```text
ctx.compaction
```

当前配套：

```text
compaction-basic
compaction-tool-result-pruner
```

结合：

```text
ctx.tokenMeter
ctx.toolResultPruner
```

解决长 Session：

```text
History grows
    ↓
Pressure detect
    ↓
Tool-result prune
    ↓
Summary compaction
```

这是长文档分析 Agent 非常需要的一层。

---

# 41. `packages/guard/`

职责：

- repeat-call reminders
- tool execution deadline enforcement

它属于 Loop Hygiene，不承担真正业务逻辑。

---

# 42. `packages/plan/` 与 `interaction/`

这两层组合后实现：

```text
User
 ↓
Plan
 ↓
Approve
 ↓
Execute
```

非常适合你此前提到的 WorkBuddy 式：

```text
AI先给修改计划
 ↓
用户确认
 ↓
阶段性修改
```

---

# 43. `packages/directory-picker/`

能力：

```text
ctx.directoryPicker
```

实现：

```text
directory-picker-native
directory-picker-browse
```

它说明 Harness 已经考虑了“用户从本地 UI 选择 workspace directory”这一交互。

---

# 44. `packages/attachment/` 与文档 Agent

你的 Office Agent 可以直接复用：

```text
Attachment
  ↓
Durable identity
  ↓
Workspace
  ↓
Document Parser
  ↓
Document Operation
```

而不是每次都把文件直接作为临时 blob 丢给 Agent。

---

# 45. `packages/workspace/`

上下文：

```text
ctx.workspaceRegistry
```

它表示 Workspace entity。

Workspace 是：

```text
文件系统根目录
Agent Session
配置
能力范围
```

之间的桥。

这对本地知识库尤其重要。

---

# 46. `packages/preset/` + `workspace/` + `agent/`

三者可以理解为：

```text
Workspace
   ↓
Preset
   ↓
Agent Composition
   ↓
Agent Session
```

因此你可以做：

```text
Office Workspace
GIS Workspace
Developer Workspace
Knowledge Workspace
```

不同 workspace 对应不同 preset / tool / model / policy。

---

# 47. `packages/identity/`, `feedback/`, `goal/`, `schedule/`

它们属于围绕 Session 的“产品体验层”。

### `schedule`

```text
session-local follow-up
```

可做：

```text
30分钟后继续执行
每天 9 点生成报告
```

### `feedback`

用户反馈。

### `goal`

长期 objective。

这些能力组合后，Harness 已经具备基础的 Personal Agent 形态。

---

# 48. Vendor：`vendor/`

这是理解 Harness 的又一个关键。

当前包括：

```text
cordis
cosmokit
group
hmr
include
loader
logger-console
schemastery
timer
```

官方说明：这些是直接 vendored 的 framework/foundation 源码，为了：

- 可审计
- 可 patch
- 固定版本
- 完整控制 framework layer

并且 upstream 的 MIT LICENSE 被保留。citeturn147563view1

---

# 49. `vendor/cordis/`

这是 Harness 的真正微内核基础。

DeepWiki 当前架构索引明确涉及：

```text
vendor/cordis/src/context.ts
vendor/cordis/src/events.ts
vendor/cordis/src/fiber.ts
vendor/cordis/src/logger.ts
vendor/cordis/src/reflect.ts
vendor/cordis/src/registry.ts
vendor/cordis/src/service.ts
```

核心职责：

```text
Context
Service Registry
Event Bus
Fiber / lifecycle
Effect disposal
Reflection
Logging
```

理解这些文件后，你才能真正理解：

```text
ctx.llm
ctx.tools
ctx.sessions
ctx.agentLoop
```

为什么可以动态注册。

---

# 50. `vendor/loader/`

DeepWiki 当前索引可确认：

```text
vendor/loader/src/config/entry.ts
vendor/loader/src/config/group.ts
vendor/loader/src/config/isolate.ts
vendor/loader/src/config/tree.ts
vendor/loader/src/index.ts
vendor/loader/src/internal.ts
```

它负责从配置树建立 Cordis runtime composition。

也就是：

```text
profile
  ↓
bundle
  ↓
patch
  ↓
loader
  ↓
Cordis Context
```

---

# 51. `vendor/hmr/`

HMR 能力，主要解决插件 runtime 热更新/卸载。

这也是为什么每个 package 强调 `invariant.ts` / disposable effects。

---

# 52. `vendor/include/`

负责通过 plugin/include 方式把一个配置/插件树包含到另一个树。

---

# 53. `vendor/cosmokit/` / `group/` / `schemastery/` / `timer/`

这些属于基础库层：

```text
cosmokit
  = general utility ecosystem

group
  = grouping/plugin organization

schemastery
  = schema/config validation

timer
  = timer/scheduling primitive
```

它们不是 Agent 业务，而是 Cordis ecosystem support。

---

# 54. Python Runtime

当前 Python 目录：

```text
python/
├── sdk/
└── sdk-runtime/
```

## `python/sdk/`

提供：

```text
deepseek-harness-sdk
deepseek_harness
```

包括：

- high-level turns API
- low-level JSON-RPC client

## `python/sdk-runtime/`

提供：

```text
deepseek-harness-runtime-bin
deepseek_harness_runtime
```

负责 bundled runtime binaries / default configuration。

官方 README 明确：Python 客户端默认拉起匹配的 bundled runtime，并通过 newline-delimited JSON-RPC/stdio 通信。citeturn147563view2

---

# 55. `scripts/` —— 工程系统的“大脑”之一

当前 scripts 不只是构建脚本，而是：

```text
Quality Gates
Code Generation
Dependency Verification
Doc Verification
Release Automation
Packaging
Translation Verification
```

当前可确认的大量源码包括：

```text
agent-note-tree.ts
archived-agent-notes.ts
archived-agent-notes.spec.ts
attribute-chunk-bytes.mjs
build-exe-for-python-sdk-native-pty.ts
build-exe-for-python-sdk-native-pty.spec.ts
build-exe-for-python-sdk.ts
build-python-release.py
change-scope.ts
change-scope.spec.ts
check-workspace-constraints.ts
clean.ts
clean.spec.ts
client-bundle-css.spec.ts
client-bundle-purity.spec.ts
client-tsconfig.spec.ts
cordis-config-files.ts
cordis-config-files.spec.ts
cordis-core-api.ts
cordis-core-api.spec.ts
cordis-walk.ts
coverage-exempt.ts
coverage-exempt.spec.ts
coverage-uncovered-locations.cjs
demo-code-mode.mjs
demo-cordis.mjs
dev-web.ts
dev-web.spec.ts
```

以及大量 release / verify / generator 脚本。当前 GitHub `scripts/` 目录已经非常大，因此这里更适合按“脚本职责族”分析而不是伪造逐文件语义。citeturn147563view3

---

# 56. Scripts 职责族

## Build / Package

```text
build-*
publish-*
pack-*
release/*
```

## Dependency / Invariant

```text
verify-runtime-closure
verify-package-invariants
verify-built-package-invariants
verify-optional-dependency-imports
```

## Cordis

```text
gen-cordis-catalog.ts
gen-cordis-api.ts
verify-cordis-config.ts
cordis-walk.ts
```

## Documentation

```text
gen-doc-graphs.ts
gen-module-graph.ts
gen-tool-catalog.ts
gen-config-catalog.ts
gen-persistence-catalog.ts
```

## Translation

```text
gen-translation-brief.ts
verify-translation-*
merge-translation-pairing.ts
```

## Quality

```text
run-gates.ts
lint
coverage
jscpd
knip
publint
```

根 package 的 scripts 也明确展示了这些 gate / generator 的整体作用。citeturn688544view2

---

# 57. Configuration / Build System

根 `package.json` 是整个 monorepo 的构建控制面。

核心命令：

```text
pnpm run build
pnpm run build:lib
pnpm run build:web
pnpm run typecheck
pnpm run lint
pnpm test
pnpm test:e2e
pnpm test:web
pnpm hygiene
```

并支持：

```text
npm run gen-cordis-catalog
npm run gen-client-catalog
npm run gen-tool-catalog
npm run gen-config-catalog
npm run gen-doc-graphs
npm run gen-persistence-catalog
npm run gen-module-graph
```

这说明仓库不仅靠人读源码，还把：

```text
Architecture
Type Graph
Tool Graph
Config Graph
Persistence Graph
```

自动生成化。

---

# 58. `tsconfig.*`

当前有：

```text
tsconfig.base.json
tsconfig.base.client.json
tsconfig.client.json
tsconfig.host.json
tsconfig.json
```

核心意图是把：

```text
Host-side TS
Client-side TS
Shared TS
```

分离。

这点很重要：

```text
packages/client
```

不能随意引用 Node-only host code。

---

# 59. `vitest.*`

当前根目录存在多个 Vitest configuration：

```text
vitest.config.ts
vitest.e2e.config.ts
vitest.snapshot.config.ts
vitest.web.config.ts
vitest.web.perf.config.ts
vitest.web-stress.config.ts
vitest.shared.ts
```

可以推断测试体系至少被分成：

```text
Unit
E2E
Snapshot
Web
Performance
Stress
```

这与 Harness 当前复杂的 UI / Session / Agent runtime 非常匹配。

---

# 60. Agent核心调用链

理解 Harness 源码时，推荐始终用下面这条链路追踪。

```text
CLI / Web UI
     ↓
Agent Service
     ↓
AgentLoop
     ↓
Session
     ↓
SystemPrompt
     ↓
Tools
     ↓
LLM
     ↓
Stream
     ↓
Tool Calls
     ↓
Tool Pipeline
     ↓
Session Events
     ↓
Projection
     ↓
Client
```

更具体：

```text
User Message
   ↓
Session append user/message
   ↓
Agent inbox claim
   ↓
agent/pre-step
   ↓
Prompt Assembly
   ↓
Tool Schema Assembly
   ↓
ctx.llm.stream()
   ↓
assistant/chunk*
   ↓
assistant/message
   ↓
tool/call*
   ↓
ctx.tools
   ↓
pre-execute
   ↓
approval / guards
   ↓
execute
   ↓
post-execute
   ↓
tool/result*
   ↓
next Step
```

官方 architecture 对这条链路有明确的 turn/step 定义。citeturn593225view1

---

# 61. “Everything is a Plugin”在代码中是如何实现的

不是简单地说“大家都是 Plugin”。具体实现是：

```text
Plugin
  ↓
inject dependencies
  ↓
ctx.effect()
ctx.on()
ctx.waterfall()
  ↓
Service / Event / Middleware
```

插件卸载时 effect 自动 unwind，因此 HMR / dynamic plugin composition 才成立。citeturn556704view1

---

# 62. Capability Seam 是整个代码库最核心的抽象

典型模式：

```text
                 Service Definition
                        │
                        ▼
                  ┌──────────┐
                  │  ctx.fs  │
                  └────┬─────┘
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
         fs-local   fs-sandbox  fs-e2b
            │          │          │
            └──────────┼──────────┘
                       ▼
                   tool-fs
```

消费者不关心 Provider 是 local、sandbox 还是 E2B。

这就是整个项目最值得复制到你自己的 LR-Agent 中的设计。

---

# 63. Session Log 的意义

Session Log 不是普通聊天 history。

它实际上是：

```text
Event Sourcing Log
```

示意：

```text
user/message
assistant/chunk
assistant/message
tool/call
tool/result
assistant/chunk
assistant/message
```

然后：

```text
deriveMessages()
```

从事件重新得到 LLM history。

因此支持天然：

```text
Resume
Replay
Fork
Projection
Telemetry
UI Replay
```

官方文档明确指出 raw `assistant/chunk` 事件保留用于 replay / UI fidelity。citeturn593225view1

---

# 64. 对你 Document Agent 的直接映射

你之前要做的 WorkBuddy 式文档 Agent，可以直接映射：

```text
DocumentPlugin
    │
    ├── Service Definition
    │      ctx.document
    │
    ├── Provider
    │      OfficeCLI / LibreOffice / Python
    │
    └── Consumer
           document.read
           document.inspect
           document.replace
           document.insert
           document.render
           document.commit
```

再加：

```text
Session Events
 ├── document/open
 ├── document/operation-start
 ├── document/operation-progress
 ├── document/operation-complete
 └── document/version-created
```

前端通过：

```text
ctx.clientModules
```

挂：

```text
Document Workspace
```

这是完全符合 Harness 原生架构的扩展方式。

---

# 65. 对你 Cloud Agent 的映射

```text
ctx.cloud
```

建议分成：

```text
cloud service definition
        ↓
cloud provider
        ↓
cloud tools
```

例如：

```text
cloud.search
cloud.download
cloud.upload
cloud.sync
cloud.query
```

Provider 可以是：

```text
S3
OSS
REST API
PostgreSQL
GIS
```

Agent 不依赖具体供应商。

---

# 66. 对你 GIS Agent 的映射

```text
ctx.gis
```

Provider：

```text
ArcGIS
GeoServer
MapGIS
SuperMap
PostGIS
```

Consumer：

```text
gis.listLayers
gis.query
gis.spatialQuery
gis.identify
gis.export
```

Client module：

```text
GIS Workspace
Map View
Layer Panel
Feature Inspector
```

因此 GIS 本质上可以成为一个标准 Harness capability seam。

---

# 67. 为什么 Harness 特别适合你的三类需求

你需要：

```text
Cloud
Document
GIS
```

而 Harness 已经有：

```text
Tools
Jobs
Workflow
Session
Approval
Sandbox
Client Modules
Storage
Credentials
Workspace
Subagent
```

这意味着你只需要增加业务能力，不需要重新发明 Agent Runtime。能力地图中已经有 `ctx.jobs`、`ctx.workflowEngine`、`ctx.clientModules`、`ctx.credentials`、`ctx.storage`、`ctx.workspaceRegistry`、`ctx.approval` 等可直接复用的 seam。citeturn778997view0turn778997view1turn778997view2

---

# 68. 最值得精读的源码顺序

如果你准备真正“读懂并二次开发” Harness，我不建议按照 GitHub 文件树从上到下看。

建议顺序：

```text
01 vendor/cordis
      ↓
02 packages/core/agent
      ↓
03 packages/core/agent-loop
      ↓
04 packages/core/tools
      ↓
05 packages/core/session
      ↓
06 packages/llm/llm
      ↓
07 packages/llm/llm-deepseek
      ↓
08 packages/session/*
      ↓
09 packages/interaction/*
      ↓
10 packages/host/*
      ↓
11 packages/client/*
      ↓
12 packages/preset + bundle
      ↓
13 packages/subagent
      ↓
14 packages/jobs + workflow
      ↓
15 packages/fs + shell + sandbox
      ↓
16 apps/cli
      ↓
17 python/sdk
```

这样可以先建立运行时骨架，再理解周边能力。

---

# 69. Harness 最重要的代码边界

可以把整个代码库抽象成：

```text
                     ┌─────────────┐
                     │   Cordis    │
                     └──────┬──────┘
                            │
                    Runtime Context
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
    Agent                 Session               LLM
       │                    │                    │
       ▼                    ▼                    ▼
    Tools               Persistence           Adapter
       │
       ▼
Capabilities
 │    │      │      │       │       │
FS  Shell  Web    Jobs   Workflow  Subagent
 │
 ▼
Providers
```

而：

```text
Host
Client
CLI
SDK
```

属于这些核心能力的应用入口/外部接口。

---

# 70. 商业二次开发时建议的目录

不建议直接大量改 Harness Core。

更合理：

```text
lr-agent/
│
├── upstream/
│   └── deepseek-harness
│
├── plugins/
│   ├── lr-document/
│   ├── lr-cloud/
│   ├── lr-gis/
│   ├── lr-office/
│   └── lr-knowledge/
│
├── services/
│   ├── document-worker/
│   ├── cloud-gateway/
│   └── gis-gateway/
│
└── web/
    ├── document-workspace/
    ├── gis-workspace/
    └── cloud-workspace/
```

只让自定义 Plugin 依赖：

```text
Service Definition
```

而不是依赖：

```text
Concrete Provider
```

---

# 71. 代码阅读中的几个关键“坑”

## 坑1：不要把 `agent-loop` 当整个 Agent

它只是默认 Loop implementation。

真正稳定接口在：

```text
packages/core/agent
```

---

## 坑2：不要把 Session 当聊天消息数组

Session 是 Event Sourcing Log。

---

## 坑3：不要把 Tools 当普通函数

Tool 有：

```text
registry
scope
schema
pre-execute
approval
execute
post-execute
result
```

---

## 坑4：不要把 Provider 当 API

真正的 API 是：

```text
Service Definition
```

Provider 可替换。

---

## 坑5：不要直接改 Web UI

推荐做 Client Module / UI Plugin。

---

# 72. 当前版本成熟度判断

当前根 README 明确标注：

```text
Developer Preview
```

并明确说明存在 compatibility-breaking changes 的可能。citeturn688544view1

因此：

### 适合

- 技术研究
- Agent 平台二次开发
- Plugin 架构实验
- 自定义 Agent 产品
- 内部工具

### 商业项目注意

必须：

```text
固定 upstream commit
↓
Compatibility Adapter
↓
你自己的 Plugin API
```

不要让业务代码直接绑定 `master` 最新接口。

---

# 73. 最终的代码架构理解

如果把整个项目压缩为 7 个核心层：

```text
Layer 7 : Apps
   CLI / Web / Python / SDK

Layer 6 : UI / Host
   Client / Host / WebServer

Layer 5 : Product API Spine
   Agent / Loop / Session / Prompt / Tools

Layer 4 : Capability Seams
   FS / Shell / Web / Jobs / Workflow / Subagent / LSP

Layer 3 : Providers
   DeepSeek / Local FS / Sandbox / E2B / SQLite / JSONL

Layer 2 : Cordis Runtime
   Context / Service / Event / Effect / Fiber

Layer 1 : Native + Vendor
   Landlock / Cordis / Cosmokit / Loader / Schema
```

这就是 DeepSeek Harness 的真正代码结构。

---

# 74. 最终判断：哪些模块对你的项目最重要

按你的 LR-Agent 规划，优先级如下：

| 优先级 | Harness 模块 | 原因 |
|---|---|---|
| S | `core/agent-loop` | Agent 执行核心 |
| S | `core/agent` | Agent 公共 API |
| S | `core/tools` | Document/Cloud/GIS Tool接入 |
| S | `core/session` | 实时过程、Replay、Version |
| S | `llm/llm` | 模型抽象 |
| S | `interaction` | Human-in-the-loop |
| S | `client` | WorkBuddy 式 UI |
| S | `host` | 前后端桥接 |
| A | `fs` | 本地文档操作 |
| A | `jobs` | 大文档/后台任务 |
| A | `workflow` | 多阶段工作流 |
| A | `storage` | 文档/任务数据 |
| A | `attachments` | 文件入口 |
| A | `workspace` | 本地 Workspace |
| A | `credentials` | 云端/GIS凭据 |
| A | `sandbox` | 文档/代码安全执行 |
| B | `subagent` | 多Agent协作 |
| B | `mcp` | 外部工具生态 |
| B | `skill` | 长期能力封装 |
| B | `lsp` | Code Agent |
| B | `compaction` | 超长上下文 |

---

# 75. 你现在最应该精读的源码文件

如果目标是开始编写自己的 Document Agent，我建议第一轮只精读这些文件族：

```text
vendor/cordis/src/context.ts
vendor/cordis/src/events.ts
vendor/cordis/src/service.ts
vendor/cordis/src/registry.ts
vendor/cordis/src/fiber.ts

packages/core/agent/src/index.ts
packages/core/agent/src/types.ts

packages/core/agent-loop/src/index.ts
packages/core/agent-loop/src/agent.ts
packages/core/agent-loop/src/tool-calls.ts

packages/core/tools/src/*
packages/core/session/src/*
packages/core/system-prompt/src/*

packages/llm/llm/src/*
packages/llm/llm-deepseek/src/*

packages/session/session-persistence/src/*
packages/session/session-persistence-jsonl/src/*
packages/session/session-persistence-sqlite/src/*
packages/session/session-projection/src/*

packages/interaction/*
packages/client/runtime/*
packages/client/connection/*
packages/client/ui-conversation/*
packages/client/ui-tool/*
packages/client/ui-trajectory/*
packages/client/ui-workspace/*
packages/client/modules/*

packages/jobs/*
packages/workflow/*
packages/fs/*
packages/attachment/*
packages/workspace/*
```

精读完这些，基本就能理解 80% 的核心执行模型。

---

# 76. 对 LR-Agent 的最终架构建议

你之前计划的三类能力可以完全映射成 Harness 原生插件：

```text
LR-Agent
│
├── lr-document
│     ├── ctx.document
│     ├── document.inspect
│     ├── document.edit
│     ├── document.render
│     ├── document.version
│     └── Document Workspace UI
│
├── lr-cloud
│     ├── ctx.cloud
│     ├── cloud.search
│     ├── cloud.download
│     ├── cloud.upload
│     └── cloud.sync
│
├── lr-gis
│     ├── ctx.gis
│     ├── gis.query
│     ├── gis.spatialQuery
│     ├── gis.identify
│     └── GIS Workspace UI
│
└── lr-knowledge
      ├── ctx.knowledge
      ├── index
      ├── retrieval
      └── RAG tools
```

然后底层全部复用 Harness：

```text
Harness
├── Agent
├── AgentLoop
├── Session
├── Tool
├── LLM
├── Approval
├── Sandbox
├── Jobs
├── Workflow
├── Storage
├── Credential
├── Workspace
└── Client Module
```

这是最符合 Harness 原设计的二次开发方式。官方架构文档明确把“新增 Tool、Model、UI、Background Job、Filesystem、Workflow、Session state”等都定义成独立 extension points。citeturn593225view1

---

# 77. 最终总结

DeepSeek Harness 最值得学习的并不是某一个 `Agent` 类，而是它把 Agent 系统拆成了：

```text
Runtime
+
Service
+
Provider
+
Consumer
+
Event
+
Session
+
Plugin
+
Composition
```

最终形成：

```text
                Cordis
                  │
            Plugin Runtime
                  │
         ┌────────┴─────────┐
         │                  │
     Agent Spine       Capability Seams
         │                  │
   ┌─────┼─────┐      ┌─────┼──────────┐
   │     │     │      │     │          │
 Session LLM  Tools    FS   Jobs     Workflow
   │             │
   └─────────────┘
          │
       Agent Loop
          │
      Session Log
          │
      Projection
          │
       Client UI
```

所以如果你接下来是为了真正开发 LR-Agent，最重要的下一步不是继续泛读所有 package README，而是针对以下三条“源码主链”做真正的代码级 walkthrough：

```text
主链1：
User → AgentLoop → LLM → Tool → Session

主链2：
Session → Projection → Host → Client → UI

主链3：
Plugin → Cordis Context → Service Definition → Provider → Consumer
```

其中第一条决定 Agent 如何运行，第二条决定你如何做 WorkBuddy 式实时 UI，第三条决定你未来如何安全地增加 Document / GIS / Cloud 等插件，而不需要持续修改 Harness Core。

---

# 78. 主要源码参考

- GitHub Repository：<https://github.com/deepseek-ai/deepseek-harness>
- Root README：<https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md>
- `packages/README.md`：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md>
- Architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- Capability Seams：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md>
- Tool Execution Pipeline：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md>
- Development Guide：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md>
- Current `packages/` tree：<https://github.com/deepseek-ai/deepseek-harness/tree/master/packages>
- Current `apps/cli/` tree：<https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli>
- Current `apps/web/` tree：<https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/web>
- Current `python/` tree：<https://github.com/deepseek-ai/deepseek-harness/tree/master/python>
- Current `native/landlock-run/` tree：<https://github.com/deepseek-ai/deepseek-harness/tree/master/native/landlock-run>
- DeepWiki repository index snapshot：<https://deepwiki.com/deepseek-ai/deepseek-harness>

---

## 附录：代码阅读方法

对于任意一个新 package，不要只读 `index.ts`，建议固定按照这个顺序：

```text
README.md
  ↓
package.json
  ↓
src/index.ts
  ↓
src/types.ts / Service Definition
  ↓
src/* provider implementation
  ↓
src/invariant.ts
  ↓
tests/*.spec.ts
  ↓
consumers
```

一个 package 真正的“作用”应该通过：

```text
谁提供它
谁消费它
谁注册它
它向 ctx 暴露什么
它发出什么 event
它监听什么 event
```

来判断，而不是单看文件名。

# 16. 代码阅读任务单：逐文件执行

### Task 001

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 002

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 003

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 004

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 005

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 006

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 007

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 008

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 009

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 010

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 011

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 012

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 013

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 014

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 015

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 016

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 017

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 018

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 019

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 020

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 021

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 022

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 023

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 024

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 025

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 026

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 027

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 028

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 029

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 030

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 031

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 032

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 033

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 034

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 035

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 036

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 037

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 038

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 039

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 040

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 041

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 042

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 043

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 044

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 045

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 046

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 047

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 048

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 049

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 050

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 051

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 052

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 053

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 054

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 055

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 056

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 057

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 058

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 059

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 060

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 061

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 062

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 063

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 064

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 065

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 066

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 067

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 068

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 069

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 070

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 071

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 072

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 073

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 074

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 075

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 076

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 077

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 078

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 079

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 080

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 081

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 082

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 083

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 084

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 085

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 086

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 087

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 088

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 089

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 090

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 091

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 092

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 093

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 094

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 095

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 096

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 097

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 098

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 099

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 100

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 101

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 102

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 103

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 104

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 105

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 106

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 107

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 108

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 109

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 110

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 111

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 112

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 113

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 114

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 115

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 116

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 117

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 118

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 119

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 120

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 121

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 122

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 123

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 124

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 125

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 126

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 127

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 128

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 129

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 130

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 131

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 132

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 133

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 134

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 135

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 136

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 137

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 138

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 139

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 140

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 141

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 142

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 143

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 144

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 145

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 146

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 147

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 148

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 149

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 150

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 151

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 152

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 153

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 154

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 155

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 156

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 157

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 158

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 159

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 160

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 161

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 162

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 163

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 164

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 165

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 166

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 167

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 168

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 169

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 170

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 171

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 172

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 173

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 174

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 175

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 176

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 177

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 178

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 179

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 180

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 181

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 182

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 183

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 184

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 185

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 186

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 187

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 188

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 189

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 190

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 191

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 192

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 193

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 194

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 195

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 196

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 197

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 198

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 199

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 200

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 201

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 202

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 203

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 204

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 205

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 206

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 207

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 208

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 209

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 210

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 211

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 212

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 213

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 214

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 215

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 216

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 217

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 218

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 219

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 220

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 221

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 222

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 223

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 224

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 225

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 226

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 227

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 228

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 229

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 230

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 231

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 232

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 233

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 234

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 235

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 236

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 237

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 238

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 239

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 240

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 241

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 242

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 243

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 244

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 245

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 246

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 247

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 248

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 249

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 250

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 251

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 252

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 253

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 254

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 255

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 256

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 257

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 258

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 259

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 260

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 261

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 262

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 263

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 264

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 265

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 266

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 267

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 268

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 269

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 270

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 271

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 272

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 273

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 274

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 275

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 276

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 277

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 278

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 279

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 280

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 281

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 282

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 283

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 284

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 285

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 286

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 287

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 288

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 289

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 290

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 291

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 292

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 293

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 294

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 295

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 296

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 297

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 298

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 299

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。

### Task 300

- 记录文件所属 package。
- 记录文件是否是 public export。
- 记录文件 import 的 package 边界。
- 记录文件是否注册 ctx service。
- 记录文件是否注册事件。
- 记录文件是否注册 waterfall。
- 记录文件是否持有资源 ownership。
- 记录文件是否写 Session。
- 记录文件是否触发 Tool。
- 记录文件是否可在 HMR/unload 后安全回收。
- 记录测试覆盖的 invariant。
- 记录对外 API 与内部 helper 的边界。


# 17. 第二轮逐文件审查模板：从路径进入符号

> 这一部分用于把 package-level 阅读进一步落实到真正的源码文件阅读。对每个实际 `.ts/.tsx/.py/.rs/.c/.h` 文件，建议逐项完成。这里故意使用检查模板，而不是虚构当前 commit 中不存在的函数名。

## File Review Task 001

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 002

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 003

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 004

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 005

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 006

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 007

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 008

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 009

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 010

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 011

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 012

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 013

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 014

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 015

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 016

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 017

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 018

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 019

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 020

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 021

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 022

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 023

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 024

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 025

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 026

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 027

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 028

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 029

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 030

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 031

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 032

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 033

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 034

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 035

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 036

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 037

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 038

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 039

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 040

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 041

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 042

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 043

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 044

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 045

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 046

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 047

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 048

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 049

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 050

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 051

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 052

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 053

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 054

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 055

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 056

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 057

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 058

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 059

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 060

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 061

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 062

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 063

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 064

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 065

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 066

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 067

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 068

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 069

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 070

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 071

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 072

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 073

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 074

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 075

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 076

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 077

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 078

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 079

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 080

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 081

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 082

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 083

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 084

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 085

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 086

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 087

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 088

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 089

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 090

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 091

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 092

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 093

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 094

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 095

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 096

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 097

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 098

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 099

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 100

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 101

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 102

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 103

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 104

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 105

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 106

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 107

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 108

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 109

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 110

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 111

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 112

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 113

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 114

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 115

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 116

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 117

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 118

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 119

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 120

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 121

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 122

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 123

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 124

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 125

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 126

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 127

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 128

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 129

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 130

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 131

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 132

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 133

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 134

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 135

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 136

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 137

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 138

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 139

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 140

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 141

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 142

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 143

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 144

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 145

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 146

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 147

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 148

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 149

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 150

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 151

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 152

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 153

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 154

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 155

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 156

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 157

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 158

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 159

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 160

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 161

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 162

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 163

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 164

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 165

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 166

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 167

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 168

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 169

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 170

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 171

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 172

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 173

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 174

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 175

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 176

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 177

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 178

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 179

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 180

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 181

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 182

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 183

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 184

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 185

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 186

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 187

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 188

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 189

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 190

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 191

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 192

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 193

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 194

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 195

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 196

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 197

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 198

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 199

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 200

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 201

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 202

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 203

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 204

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 205

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 206

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 207

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 208

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 209

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 210

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 211

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 212

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 213

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 214

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 215

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 216

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 217

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 218

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 219

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 220

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 221

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 222

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 223

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 224

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 225

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 226

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 227

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 228

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 229

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 230

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 231

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 232

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 233

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 234

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 235

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 236

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 237

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 238

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 239

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 240

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 241

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 242

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 243

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 244

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 245

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 246

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 247

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 248

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 249

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 250

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 251

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 252

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 253

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 254

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 255

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 256

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 257

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 258

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 259

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 260

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 261

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 262

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 263

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 264

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 265

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 266

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 267

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 268

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 269

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 270

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 271

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 272

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 273

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 274

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 275

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 276

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 277

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 278

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 279

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 280

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 281

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 282

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 283

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 284

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 285

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 286

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 287

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 288

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 289

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 290

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 291

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 292

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 293

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 294

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 295

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 296

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 297

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 298

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 299

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 300

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 301

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 302

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 303

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 304

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 305

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 306

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 307

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 308

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 309

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 310

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 311

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 312

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 313

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 314

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 315

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 316

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 317

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 318

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 319

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 320

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 321

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 322

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 323

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 324

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 325

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 326

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 327

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 328

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 329

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 330

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 331

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 332

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 333

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 334

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 335

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 336

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 337

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 338

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 339

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 340

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 341

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 342

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 343

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 344

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 345

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 346

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 347

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 348

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 349

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 350

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 351

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 352

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 353

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 354

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 355

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 356

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 357

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 358

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 359

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 360

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 361

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 362

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 363

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 364

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 365

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 366

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 367

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 368

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 369

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 370

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 371

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 372

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 373

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 374

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 375

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 376

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 377

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 378

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 379

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 380

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 381

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 382

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 383

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 384

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 385

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 386

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 387

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 388

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 389

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 390

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 391

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 392

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 393

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 394

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 395

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 396

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 397

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 398

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 399

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。

## File Review Task 400

- 确认文件路径和所属 package/group。
- 读取文件顶部 imports，标记跨 package 依赖。
- 确定默认 export / named export / side-effect export。
- 标记 Service / Provider / Consumer 身份。
- 定位 ctx.get / ctx[key] / service 注入位置。
- 定位 ctx.effect / ctx.on / ctx.waterfall。
- 记录 listener / waterfall 的优先级或注册顺序。
- 记录生命周期入口与 dispose/cleanup。
- 记录异步边界和 AbortSignal。
- 记录异常传播：throw / return error / event。
- 记录是否写入 Session 或 Storage。
- 记录是否依赖缓存或 projection。
- 记录是否产生 model-visible context。
- 记录是否产生 UI-visible event。
- 记录是否使用 guard / approval / sandbox。
- 记录是否支持 replay/resume。
- 记录是否存在并发竞态与 ownership 假设。
- 关联对应测试文件。
- 关联对应 README / docs。
- 输出二次开发风险和可扩展点。
