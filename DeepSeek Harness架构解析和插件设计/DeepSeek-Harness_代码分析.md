# DeepSeek Harness 代码级全面分析

> 分析对象：`https://github.com/deepseek-ai/deepseek-harness`
>
> 分析时间：2026-08-19
>
> 分析分支：`master`
>
> 当前仓库根 package：`@deepseek-ai/dsh-root`，版本 `0.1.0-rc.7`；仓库采用 MIT License，并明确处于 **Developer Preview** 阶段，官方 README 警告未来存在兼容性破坏变更。
>
> **重要说明**：本报告以当前 GitHub `master` 页面、仓库自身 README / architecture / capability-seams / package README，以及 2026-08-13 的 DeepWiki 代码索引为主要依据。当前运行环境无法直接 `git clone` GitHub，因此无法对 12k+ commits 的所有历史版本和全部当前源码文件做本地 AST 级扫描。本报告做到“架构、模块、package、关键源码文件、核心调用链”的代码级解析，并对 GitHub 当前树可确认的文件进行逐层说明；对于仓库中数量极大的测试、生成文件、第三方 vendor 文件，不虚构不存在的逐文件细节。若需要 100% 精确到 **当前 master 的每一个 `.ts/.tsx/.js/.mjs/.py/.rs/.c/.h` 文件**，最稳妥的方式是提供仓库 zip/tar.gz，本报告可以在此基础上继续生成真正的全文件索引。

---

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
