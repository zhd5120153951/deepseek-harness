# DeepSeek Harness 架构与设计哲学全景分析

> 本文档基于对 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库（`@deepseek-ai/dsh-root` v0.1.0-rc.7，MIT License）的源码级分析整理而成，目标是为一、二次开发者提供完整的设计哲学、架构分解与扩展点地图。
>
> 所有代码引用均使用仓库内相对路径，可对照源码阅读。仓库位置（本文分析对象）：`E:\WorkSpace\LLM_Projects\deepseek-harness`。

## 目录

- [1. 一句话定位](#1-一句话定位)
- [2. 设计哲学（核心思想）](#2-设计哲学核心思想)
- [3. 架构总览](#3-架构总览)
- [4. 基座：Cordis 插件框架](#4-基座cordis-插件框架)
- [5. 核心运行时：会话与 Agent Loop](#5-核心运行时会话与-agent-loop)
- [6. 工具系统与执行管线](#6-工具系统与执行管线)
- [7. LLM 能力 Seam](#7-llm-能力-seam)
- [8. 持久化与会话数据](#8-持久化与会话数据)
- [9. 执行世界：沙箱/子进程/Shell/文件系统](#9-执行世界沙箱子进程shell文件系统)
- [10. Agent 级能力层](#10-agent-级能力层)
- [11. 组合与配置体系](#11-组合与配置体系)
- [12. 交互与审批](#12-交互与审批)
- [13. 通信层：Typert RPC 与 SDK](#13-通信层typert-rpc-与-sdk)
- [14. Web 宿主与浏览器客户端](#14-web-宿主与浏览器客户端)
- [15. 扩展与自我修改](#15-扩展与自我修改)
- [16. 二次开发指南](#16-二次开发指南)
- [17. 工程实践与质量体系](#17-工程实践与质量体系)
- [18. 术语表](#18-术语表)
- [19. 参考资料索引](#19-参考资料索引)

---

## 1. 一句话定位

> DeepSeek Harness（`dsh`）是一个 **"一切皆插件"（Everything is a Plugin）** 的开源 Agent Harness：基于 vendored 的 [Cordis](https://github.com/cordiverse/cordis) 插件框架构建，把 LLM 适配、工具注册、会话日志、Agent 主循环本身都做成可替换的插件，通过配置（`cordis.yml` 组合）装配成不同形态的应用（Web GUI / headless 一次性任务 / ACP 自动化服务器）。

- 组织：DeepSeek AI 开发，MIT 许可，当前为 **developer preview**（`0.1.0-rc.7`），官方声明"会有破坏性变更"。
- 技术栈：TypeScript（`strict: true`，全 ESM，Node `^22.19 || >=24`），pnpm monorepo（约 160 个 workspace 包），React 客户端，可选 Python SDK / 原生 Landlock 沙箱模块。
- 产品形态：`npx @deepseek-ai/dsh web` 启动 Web UI（默认 `http://127.0.0.1:3080`）；另有 headless 模式与 ACP 模式。
- 官方架构文档：`docs/architecture.md`（必读），`docs/AGENTS.md`（开发者约定）。

## 2. 设计哲学（核心思想）

以下原则从 `AGENTS.md`、`docs/architecture.md`、`docs/cordis-primer.md` 与源码中提炼，是理解整个代码库的钥匙。

### 2.1 没有特权内核：一切皆插件

> "There is no privileged core to patch: you extend dsh by mounting a plugin beside the others" —— `docs/architecture.md`

- 模型适配器（`ctx.llm`）、工具注册表（`ctx.tools`）、会话日志（`ctx.sessions`）、系统提示词组装（`ctx.systemPrompt`）、**Agent 主循环本身**（`ctx.agentLoop`）全部是插件。
- 这意味着二次开发**不需要 fork 主循环**：新行为挂到文档化的扩展点（事件、服务、组合层）上即可。
- 佐证：`packages/core/agent-loop` 在 capability-seams 图里被标记为 `bundle` 角色（"The one concrete loop plugin; extension packages depend on dsh-agent events and services, not on this package"）。

### 2.2 Capability Seam：能力三件套

一个可替换能力（seam）由三个角色构成，缺一不可：

1. **Service Definition**：声明接口的 Cordis `Service`（抽象类或注册表，**绝不是 TS interface**），拥有 `ctx.<key>` 与词汇类型；
2. **Service Provider**：实现该接口的后端（可多个并存/替换）；
3. **Consumer**：消费该服务的插件，通常是模型面向的工具。

> 规范示例：`packages/shell` —— `dsh-shell`（定义）、`dsh-bash-local` / `dsh-bash-sandbox` / `dsh-pwsh-local`（提供者）、`dsh-tool-bash` / `dsh-tool-pwsh`（消费者）。

"Seams are why one provider swap changes the whole product"：文件系统与子进程提供者共享同一个执行世界，把它们指向远程沙箱（E2B），Bash、PTY、LSP 会一起迁移，无需分叉 provider。完整地图见 `docs/capability-seams.md`（约 60 个 ctx 服务）。

### 2.3 模型可见 ⟺ 可记录（Model-visible ⟺ Logged）

> "Anything that reaches a model request must be reconstructable from the session log, and a runtime invariant asserts it." —— `docs/architecture.md`

- 会话日志（`SessionEventMap` 追加式事件流）是模型上下文的**唯一事实源**；`Session.deriveMessages()` 从日志投影出模型历史。
- 新增任何"模型能看到"的输入，都必须新增一个 session 事件类型，并让 UI/SDK 从日志渲染——这条由运行时不变式（`packages/runtime-diagnostics/invariants`）强制。
- 收益：Fork、恢复、回放、转录、遥测、持久化全部派生自同一条流。

### 2.4 事件是扩展点，分三个域

- **Session 事件**（`session/event`）：追加到日志的持久事实（`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`），需要跨重启存活时用它。
- **Agent 事件**（`agent/*`）：携带活体 `Agent` 的实时协调事件（inbox、status、pre-step、request、error、turn-stopping），用于观察/拦截飞行中的工作。
- **能力事件**（`fs/*`、`tools/*`、`telemetry/*`）：在不引入 loop 的情况下给能力缝挂策略与适配器。

调度模式（Cordis 词汇）：`emit`（观察）、`waterfall`（环绕中间件，必须 `next()` 委托，可短路）、`parallel`（并行）、`serial`（顺序且有返回值）。事件完整矩阵见 `docs/event-producer-consumer.md`。

### 2.5 注册即效果（Registrations are Effects）

- 提示词分段、工具 schema、适配器、provider、监听器全部通过 `ctx.effect()` / `ctx.on()` 安装，插件卸载时**可逆地回滚**。
- 约定："Registrations are effects: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer."（`AGENTS.md`）

### 2.6 组合优于配置（Composition over Config）

- 运行中的 `dsh` 是一棵**插件树**，由启动时按有序分层装配：`profile`（命名组合，存于 Harness home）→ 依序叠加 `bundle`（可分发、可补丁的配置行+代码包）→ 用户 `cordis.patch.yml` → 命令行 `--patch` 覆盖。
- patch 按行 id 寻址，**整行替换** config，而非合并——保证任何一层都可被上层完全覆盖。
- 平台差异（Windows 用 pwsh 而非 bash）也由组合层表达：`disabled: !!js process.platform === 'win32'`（见 `packages/bundle/base/cordis.patch.yml:180`）。

### 2.7 显式优于隐式，失败要响亮

- 包边界的默认值必须是显式 `resolve(request): Spec` 步骤，禁止在 `run()` 里藏 `?? default`（`dsh-shell` 的 request/spec 分离是模板）。
- 部署相关的可调参数必须是 cordis.yml 可改的 `Config` 字段；协议常量、外部规范、安全不变式保持固定。
- 配置错误在加载时响亮失败（fail loud）；权限缺失时沙箱/审批失败即关闭（fail closed）。

### 2.8 类型安全是产品策略

- 全仓 `strict: true` + `noImplicitAny`；`any` 必须解释原因。
- 跨边界 ID 一律**品牌化**（`Branded<'SessionId'>`，`packages/util/brand`），禁止裸 `string`。
- "Trust TypeScript at typed same-process boundaries"——运行时校验只放在解析器/配置、队列、模型/工具 JSON、持久化/文件、worker/进程、线协议等真实边界。
- 封闭联合用判别式 `switch` 并以 `assertNever` 收尾；可扩展联合走文档化 default。

### 2.9 Host/Client 双面构建

- 同一 monorepo 编译出两个"面"：Host 面（Node 进程内的一切）与 Client 面（浏览器端），见 `tsconfig.host.json` / `tsconfig.client.json` 与 `tsdown --env.DSH_BUILD_FACE host|client`。
- 一个包可以同时产出 Host 入口与浏览器 bundle；跨面契约（如 Typert Remote）由生成器保证两侧一致。

### 2.10 双 SDK 投影同一主循环

- TypeScript SDK（`packages/sdk`）与 Python SDK（`python/`）都投影 agent-loop、会话生命周期与 `SessionEventMap`；改动 loop 必须同 PR 更新两侧的预期输出。

### 2.11 自举（Dogfooding）与工程纪律

- 仓库用 `.agents/`（Agent Notes、skills）记录架构决策，用 AGENTS.md 约束 agent 行为，本身就是一个"DSH 被自己使用"的样例。
- 质量门极多（`pnpm run hygiene` / `check:ci:*` / 文档生成器 + 校验器），快照测试（`test:snapshot`）保证模型可见行为可回放。

---

## 3. 架构总览

### 3.1 仓库形态

pnpm monorepo（`pnpm-workspace.yaml`：`vendor/*`、`packages/*/*`、`native/landlock-run`、`apps/*`、`website`），关键顶层目录：

| 目录 | 内容 |
|---|---|
| `packages/<group>/<pkg>` | 约 160 个 `@deepseek-ai/dsh-<name>` 工作区包（见 3.3） |
| `apps/cli` | `dsh` 命令行入口（profile 启动、`--dump-config`、`plugin` 子命令） |
| `apps/web` | 前端 shell 的 Vite 入口（非独立应用，依赖 `window.__DSH_BOOT__` 注入） |
| `vendor/` | vendored Cordis 源码（固定 SHA 的源代码副本，同步流程见 `vendor/README.md`） |
| `native/landlock-run` | Linux Landlock 沙箱原生模块（`@deepseek-ai/node-addon-landlock-run`） |
| `python/` | Python SDK（`sdk`）+ 内置运行时（`sdk-runtime`） |
| `examples/` | 可运行的 `cordis.yml` 叶子应用（agent-spine-demo、acp-demo、jsonrpc-demo） |
| `docs/` | 架构文档、子系统参考、cookbook、postmortem（英中双语） |
| `.agents/` | Agent Notes（架构决策记录）与 skills |
| `scripts/` | 仓库门禁与代码生成器（typert、catalog、module-graph 等） |

### 3.2 分层视图

```text
┌─────────────────────────────────────────────────────────────────┐
│ 应用形态：apps/cli (dsh web | headless | acp)  ·  examples/     │
├─────────────────────────────────────────────────────────────────┤
│ 组合层：packages/boot (app-boot, cmdline) · bundle (base/       │
│         headless/web-app) · preset (agent-presets, persona)     │
├─────────────────────────────────────────────────────────────────┤
│ 核心 spine：core/session · core/agent · core/agent-loop ·       │
│             core/tools · core/system-prompt · core/scope        │
├─────────────────────────────────────────────────────────────────┤
│ 能力 seams：llm · fs · shell · subprocess · sandbox · terminal ·│
│             subagent · workflow · web · skill · jobs · …        │
├─────────────────────────────────────────────────────────────────┤
│ 宿主服务：session-persistence · session-query · storage ·       │
│           settings · credentials · api/gateway · host/webserver │
├─────────────────────────────────────────────────────────────────┤
│ 客户端面：client/connection · client/modules · client/runtime · │
│           client/ui-* (React) · apps/web · typert 生成物        │
├─────────────────────────────────────────────────────────────────┤
│ 基座：vendor/cordis (context · service · events · effects)      │
└─────────────────────────────────────────────────────────────────┘
```

两个构建面（`tsconfig.host.json` / `tsconfig.client.json`）各是一个独立 `ts.Program`——因为 Host 与 Client 会在同一个 `Context` 接口键下声明合并**不同的**服务，单程序会冲突（`docs/development.md`）。

### 3.3 包地图（按组）

**核心 spine（`packages/core/`）**：`session`（会话日志）、`agent`（Agent 接口/注册表/Inbox）、`agent-loop`（默认驱动）、`tools`（工具注册表+执行管线）、`system-prompt`（提示词组装）、`scope`（作用域注册原语）、`agent-default-model`、`agent-tool-presentation`。

**LLM（`packages/llm/`）**：`llm`（词汇+适配器 seam）、`llm-deepseek` / `llm-pi-ai`（provider）、`llm-retry`、`token-meter`。

**会话数据（`packages/session/`）**：`session-persistence`（+jsonl/sqlite 后端）、`session-projection`（+cache）、`session-title`（+llm 变体）、`session-telemetry`（+otel）、`session-stats`、`session-checkpoint-policy`。

**执行世界**：`packages/sandbox/*`（sandbox、sandbox-policy、sandbox-local、sandbox-windows-acl）、`packages/subprocess/*`、`packages/shell/*`（shell、bash-local、bash-sandbox、pwsh-local、shell-env、tool-bash、tool-pwsh、tool-bash-persistent）、`packages/fs/*`（fs、fs-local、fs-sandbox、fs-observation-policy、tool-fs、tool-fs-search、tool-str-replace-editor）、`packages/terminal/*`、`packages/code-runtime/*`、`packages/lsp/*`、`packages/e2b/*`。

**Agent 能力**：`packages/subagent/*`（7 个 provider + 3 个工具）、`packages/workflow/*`（引擎、worker-thread、tool-workflow、tool-ralph）、`packages/goal/*`、`packages/plan/plan-mode`、`packages/todo/tool-todo`、`packages/skill/*`、`packages/jobs/*`、`packages/compaction/*`、`packages/spill/*`、`packages/context/*`、`packages/schedule/*`、`packages/session-query/*`、`packages/feedback/*`、`packages/attachment/*`、`packages/mcp/*`。

**组合与交互**：`packages/boot/*`、`packages/bundle/*`（base/headless/web-app）、`packages/preset/*`、`packages/interaction/*`（commands、user-approval、user-questions、tool-ask-user、permission-presets）、`packages/extensions/*`（cordis-host-runner、cordis-client-runner、tool-cordis、ui-cordis）、`packages/hooks/*`（hook-protocol、hooks-claude-code、hooks-codex）、`packages/acp/acp`、`packages/identity/*`、`packages/settings/*`、`packages/credentials/*`、`packages/workspace/*`、`packages/storage/*`、`packages/util/*`。

**通信与客户端**：`packages/api/*`（gateway、remotes）、`packages/typert/*`（generator、loader、protocol、registry）、`packages/sdk/*`（protocol、server、client）、`packages/client/*`（connection、modules、hmr、runtime、web、web-react、locale、ui-* 约 30 个）、`packages/host/*`（webserver、frontend-static、apiproxy、plugin-inventory、directory-picker*）、`packages/web/*`（web、tool-web、web-search-*、web-fetch-http）。

**其他**：`packages/guard/*`（timeout-policy、repeat-tool-reminder）、`packages/runtime-diagnostics/invariants`、`packages/test-support/*`、`packages/examples/*`。

### 3.4 核心服务一览（ctx 键）

由 `docs/capability-seams.md` 生成的服务图（约 60 个服务），关键分类：

- **core（spine）**：`ctx.sessions`、`ctx.agents`、`ctx.agentLoop`、`ctx.tools`、`ctx.systemPrompt`、`ctx.invariants`、`ctx.typert`、`ctx.typertGateway`、`ctx.commands`、`ctx.goals`、`ctx.planMode`、`ctx.agentPresets`、`ctx.sessionProjections`、`ctx.webServer`、`ctx.clientModules`、`ctx.apiProxy`、`ctx.storageDomain`、`ctx.workspaceRegistry`、`ctx.messageFeedback`、`ctx.sessionReferenceResolver`、`ctx.sandboxPolicy`、`ctx.permissionPresets`、`ctx.shellEnv`、`ctx.tokenMeter`、`ctx.toolResultPruner`、`ctx.e2b`、`ctx.dynamicCordisRunner`、`ctx.cordisInspect` …
- **seam（可替换能力）**：`ctx.llm`、`ctx.fs`、`ctx.shell`、`ctx.subprocess`、`ctx.sandbox`、`ctx.terminals`、`ctx.codeRuntime`、`ctx.lsp`、`ctx.subagents`、`ctx.workflowEngine`、`ctx.jobs`、`ctx.web`、`ctx.skill`、`ctx.compaction`、`ctx.sessionPersistence`、`ctx.sessionQuery`、`ctx.sessionTitle`、`ctx.sessionTelemetry`、`ctx.settings`、`ctx.credentials`、`ctx.storage`、`ctx.approval`、`ctx.userQuestions`、`ctx.attachments`、`ctx.spillStore`、`ctx.directoryPicker` …

---

## 4. 基座：Cordis 插件框架

`vendor/cordis` 是 vendored 的 [Cordis](https://github.com/cordiverse/cordis)（源自 Koishi 生态，论文：*A Programming Paradigm for Spatiotemporal Composability*）。DSH 的整套扩展机制建立在其五个核心概念上（`docs/cordis-primer.md`）：

1. **插件即 Service**：插件可以是带可选 `inject` 与 `apply(ctx)` 的函数，也可以是 `Service` 子类；Cordis 把生命周期挂载进当前 context。
2. **Context 是服务仓库**：服务占据稳定的 `ctx.<key>`（如 `ctx.tools`），插件按 key 找服务，而不是 import 具体实现。
3. **`inject` 声明依赖**：插件声明需要的服务，Cordis 等服务就绪后再激活——加载顺序由服务依赖表达，而非手工排布。
4. **类型化事件**：通过 TS 声明合并声明事件名，按 `emit` / `waterfall` / `parallel` / `serial` 四种模式分发。
5. **注册即可逆效果**：通过 `ctx.effect()` / `ctx.on()` 安装，卸载时按序回滚。

### 4.1 事件分发模式（DSH 中的使用）

| 模式 | 是否等待 | 顺序 | 返回值 | DSH 典型用法 |
|---|---|---|---|---|
| `emit` | 否 | 注册序 | 无 | `agent/status`、`session/event` 广播 |
| `waterfall` | 否 | 注册序 | 有（经 `next()` 传递） | `agent/pre-step`、`agent/request`、`llm/stream`、`tools/*`——**环绕中间件**，不调 `next()` 即短路 |
| `parallel` | 是 | 并行 | 无 | 少见 |
| `serial` | 是 | 注册序 | 有 | `agent/turn-stopping`（终态检查点，无 next） |

Waterfall 语义（`docs/cordis-primer.md`）：监听器收到 `(...args, next)`；`next()` 委托并传递可能被包装的结果；不调用 `next()` 直接返回即短路（单决策事件的默认设计，如策略监听器）。

### 4.2 加载器配置（`!!js` 表达式）

`@deepseek-ai/cordis-plugin-include` 把 `!!js` 解析为表达式节点：插件行的 `config`（在声明注入激活后、针对插件 context 求值）与 `disabled`（每次挂载决策时、针对 loader context 求值）可含 JS 表达式；其他元数据保持字面量。环境选择插件用 **overlay**（组合叠加），例如：

```yaml
# packages/bundle/base/cordis.patch.yml:180
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
```

### 4.3 为什么 vendored 而不是依赖

`vendor/` 固定上游 SHA 的源代码副本（rescope 为 `@deepseek-ai/cordis` 系列），原因是 DSH 对 Cordis 有本地修改（如 HMR 插件、loader 增强），且需要类型级集成（`Context` 声明合并）。同步流程见 `vendor/README.md`。

---

## 5. 核心运行时：会话与 Agent Loop

### 5.1 会话（Session）与事件日志

**核心文件**：`packages/core/session/src/{index,surface,types}.ts`

- `SessionId = Branded<'SessionId'>`（`types.ts:22`）——品牌化 ID 的代表。
- `SessionEventMap`（`types.ts:236` 起）是**可合并扩展**的追加式事件日志类型：每个事件是 lossless JSON，序列号连续（含原始 chunk），持久化可逐字存储。
- 事件分三类：
  - **turn/step 括号**：`turn/start`、`turn/end`（携带 `TurnEndReason`）、`step/start`、`step/end`；
  - **模型表面**：`user/message`（含 `source` 区分人类提示/注入上下文/目标续跑）、`assistant/chunk`（原始流块，token 级回放保真）、`assistant/message`（组装消息+usage）、`tool/call`（模型原始参数 JSON 串，未解析）、`tool/result`（模型面向结果+可选 `meta` 呈现载荷）；
  - **log-only 状态**：`todo/write`（整表快照）、`request/header`（每次请求的完整头部快照，用于重建）、`request/context`（路由元数据）、`compaction/*`、`plan/mode` 等。
- `SESSION_FORMAT_VERSION = 0`（`types.ts:56`）：单调整数、无主次版本；只有**结构性**变更才 bump（header 形状、事件信封、核心语义、surface 机制）；新增普通事件类型不 bump——由 `ignorable` 守卫覆盖词汇增长。写入方决定 bump，读取方拒绝未知版本（不迁移）。
- `Session.deriveMessages()`（`index.ts:726`）：从日志投影模型历史——**日志是模型看到什么的唯一事实源**。投影规则在 `surface.ts`（"THE per-node projection rule"）。
- `SessionHeader`（`types.ts:61`）：日志之外的不可变存储元数据（version/id/createdAt/cwd/parentSession/seedLength/origin/delegationDepth/agentPreset）——`agentPreset` 持久化是因为"preset 决定会话的工具与提示词，恢复时必须恢复相同组合"。

### 5.2 Agent 对象模型

**核心文件**：`packages/core/agent/src/{runtime-types,index,inbox}.ts`

`Agent` 接口（`runtime-types.ts:64`）是公开活体句柄：

```ts
export interface Agent {
  readonly id: SessionId            // 与 session 共享同一身份
  readonly options: AgentOptions    // provider/model/maxTokens
  readonly session: Session         // 活会话；日志是持久事实源
  readonly inbox: Inbox             // 待处理工作的 agent 自有投影
  readonly status: AgentStatus      // 'idle' | 'running'
  readonly ctx: Context             // agent 作用域 context（agent-local、随处置回滚）
  cancel(cause, options?): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task): Promise<T>
  send(message, target, wakeup): void   // next-turn / next-step 边界
  followup(message): void               // 排队一个普通轮次并唤醒
  steer(message): void                  // 就近 step 的转向输入
  inject(message): void                 // 下一个 pre-step 的模型上下文，不唤醒
}
```

- `AgentRegistry`（`index.ts:256`，`ctx.agents`）：跟踪活体 agent；创建工厂由 `agent-loop` 插件经 `setFactory` 注册——所以 `ctx.agents` 是接口，`agent-loop` 是实现，ACP 等消费者只依赖接口。
- `AgentHandle`（`index.ts:172`）：**能力型**句柄——只有持有者能拆除 agent；`dispose()` 顺序：停 loop → 等退出 → 注销 → 从 store 移除会话 → 回滚作用域世界。`ctx.agents.get(id)` 只返回裸 `Agent`，handle 只给创建者。
- `AgentFactory.createAgent / resume`（`index.ts:183`）：创建与恢复走同一发布序列（setup → 提交 → 双通知 → `agent/session-start` → 启动 loop），全程可回滚。创建事务 `prepare → publish`：先注册 memoized 反向 teardown（在任何资源存在之前，防泄漏），再构造 driver+scope+ctx，然后依次 `sessions.enter → agents.enter → sessions.announce → agents.announce → agent/session-start`——任一步 setup/commit throw 或 owner disposal 都整体回滚，不发布任何一个 id（`agent-loop/src/index.ts:459-578`）。
- **initiator scope**：`withInitiator(agent, op)` / `currentInitiator()` / `requireInitiator()` 用两个 `AsyncLocalStorage` 传播"发起链"（driver 的 `kick()` 包在 `withInitiator` 里；工具调度用 `requireInitiator()` 取回 agent）。这只是**同进程因果归属，不是授权**（`index.ts:249-254`）。
- `AgentSetup`（`index.ts:69`）："组合而非驱动"契约——setup 期间经 `agentCtx` 注册的一切（scoped tools、prompt sections、restrict、listeners）在 `agent/created` 与首次 prompt 组装之前就已存在；可返回同步 `commit()` 在发布点再校验。
- `Inbox`（`inbox.ts:25`）：两个有序 pending 列表 `next-turn` / `next-step`；**它是 durable 投影**——构造时从 `session.events` 回放 `agent/inbox/spliced` 事件，所有变更先 `session.append` 再改内存（durable 事件先于 live 投影）。`claim(target, turn)` 取走全部 next-step 输入 + 一个排队消息（"一个 followup 成为其轮次唯一普通消息"的机制）。
- 事件（`runtime-types.ts:146` 起，全部 `@mode` 标注）：生命周期（`agent/created/disposed/status/session-start`）、inbox（`agent/inbox/inserted/claimed/discarded`）、机器扩展点（`agent/pre-step`、`agent/request`、`agent/request-error` 为 waterfall；`agent/turn-stopping` 为 serial 且无 `next()`）、错误（`agent/error`）。全部 **scope-filtered**（`Scoped<Agent>`）。turn/step 边界**不是** agent 事件而是 durable session 事件。

### 5.3 驱动循环（agent-loop）

**核心文件**：`packages/core/agent-loop/src/{agent,tool-calls,invariant}.ts`

`ReactLoopAgent`（`agent.ts:64`）是默认驱动实现，状态机为 `Phase = idle | maintenance | running`（`agent.ts:38`）；`maintenance` 在公共 `status` 上算 `idle`。

**turn = 一次输入排空**（0 或多个 step）；**step = 一次模型请求 + 其工具执行**。主循环（`agent.ts:246-330`）：

1. `kick()`（`agent.ts:210`）是 driver 边界：`while (await this.turn()) {}`，退出后归 `idle` 并回放被 latch 的唤醒。
2. `turn()` 打开 `turn/start`，循环 step 边界：
   - `preStep()`（`agent.ts:225`）：`inbox.claim()` → `ctx.systemPrompt.assemble()` → 运行时上下文快照投影 → `agent/pre-step` waterfall（默认 `enter(messages + 上下文快照)`；listener 可改写或 `reject`）；
   - reject → turn 以 `blocked` 关闭；首 step 空消息 → `completed` 关闭——**都不花模型调用**，但 durable turn 边界照记（"日志记录这次尝试"）；
   - 否则 `step/start` → 逐条追加 `user/message`（`surfaceOp: 'append'`）→ `step()` → `step/end`；
   - step 结束后若 `turnEnds` 且 next-step 队列空 → `agent/turn-stopping`（serial 检查点）；再查一次 inbox，有 fresh steering 就继续下一 step（`target = 'next-step'`），否则 break；
   - `finally` 追加 `turn/end`（`reason` 结构化：completed/max-tokens/aborted/error/blocked）。
3. `step()`（`agent.ts:332`）：`buildRequest()`（见下）→ `llm.stream` 逐 chunk 追加 `assistant/chunk`（同时 `BlockAssembler` 收拢）→ `assistant/message`（带 usage 与 `sourceEventSeqs`）→ finish 为 error/aborted 时走 `agent/request-error` waterfall（可 `retry`）→ 有 tool-call block 则 `executeToolCalls()`。
4. 取消：`AbortController` 每 turn 换新；`agent/error` 在活边界报告；`max-tokens` 结局**粘性**（后续正常完成的 step 不得降级）。

**请求组装 `buildRequest()`**（`agent.ts:407-495`）：seed config（首请求用 agent options，之后用 `requestProposal` 去掉 adapter 默认值字段）→ `agent/request` waterfall（可整体替换 config）→ `ctx.llm.prepareCall()` 物化精确默认值（`NO_ADAPTER` 时降级接受提议）→ `canonicalHeader` 组装 `EpochHeader{config, adapterDefaults?, system?, tools?}` 并**与日志中的 request/header 基线比较，变化才追加**（reason: `initial|resume|change`）→ 请求 = `markAgentLoopRequest(deepFreeze({...config, messages: session.deriveMessages(), system, tools, sessionId, signal}))`。

**"模型可见 ⟺ 已日志化"的运行时断言**（`agent-loop/src/invariant.ts:19-55`）：loop 在 `llm/stream` 上断言自己构造的请求——必须 frozen、带 live sessionId；`options.messages` 必须 JSON 等于 `session.deriveMessages()`（log 重建失同步即失败）；model/system/temperature/maxTokens/stop/tools 必须匹配从日志折叠出的 `request/header`。编译期强制 + 运行时断言双保险。

### 5.4 为什么 loop 本身也是插件

`ctx.agentLoop` 在 capability-seams 图里是唯一的 `bundle` 角色实现（`docs/capability-seams.md`）："The one concrete loop plugin; extension packages depend on dsh-agent events and services, not on this package." 也就是说，**没有任何包 import agent-loop 来扩展它**——全部通过 `agent/*` 事件与 `ctx.agents` 服务。更换驱动（例如为某个场景写一个特殊驱动）只需注册新的 factory。

---

## 6. 工具系统与执行管线

**核心文件**：`packages/core/tools/src/{index,types,schema,code-mode,presentation}.ts`

### 6.1 工具注册表（`ctx.tools`）

- 工具通过 `ctx.tools.register(ToolDefinition)` 注册；**工具 schema 自动进入系统提示词组装**（system-prompt 消费 tool-provider 结果）。
- 注册是作用域感知的：全局工具对所有 agent 可见；经 `agent.ctx` 注册的工具对该 agent 可见且随其生命周期回滚（scope 机制）。
- `tools.restrict` 限制：按作用域过滤**全局**工具集（交集合成）；被过滤掉的工具既不出现在提示词里也拒绝执行，与"不存在"不可区分（`docs/glossary.md`）。
- `ToolDefinition` 完整字段（`index.ts:222-288`）：
  - `name/description/parameters`（模型可见三字段，`schemas()` 只投影这三个）；
  - `output: ToolOutputDefinition`（**强制**）：`{schema, render(args, value) → ContentBlock[], presentationMeta?}`；
  - `execute(args, exec) → Promise<unknown>`：返回 canonical lossless-JSON 值，受 `output.schema` 校验；
  - `finalizeContent?(exec, result)`：同步最后一英里内容变换，调用开始时快照绑定；
  - `timeoutMs?`：协作式超时预算（由 `dsh-tool-call-timeout-policy` 在 tools/execute wrapper 执行，绝不发给模型）；
  - `isConcurrencySafe?(args)`：纯同步并发分类——**仅精确 `true` 入选 parallel**，其余（含异常/非法参数）exclusive（fail-closed）；
  - `presentCall?/presentResult?`：纯、无副作用、可重放的 UI 呈现意图（`card` 判别联合）。
- 执行结果：`ToolExecutionResult = Success{value, content, meta?, additionalContexts?, concludesTurn?} | Failure{error, content, ...}`；canonical `value` 仅执行局部，durable 事件只存 content/error/meta。
- **schema DSL 不是 zod**：自研 JSON-value DSL（`schema.ts`，`string/number/integer/boolean/null/array/object/json/oneOf`），编译到强制 raw JSON-Schema 子集（`json-schema.ts`，迭代式任务图防递归爆栈 + 环检测），`InferArgs/InferValue` 精确推断到 16 层容器深度后回退 `JsonValue`。`defineTool` 把参数 schema 编译并在执行时 `validateArgs`（不合法抛 `INVALID_ARGS`）。

### 6.2 执行管线（一次工具调用的完整旅程）

模型消息含 tool-call 块 → `tool/call` 事件（**执行前先落日志**）→ UI pending 卡 → **五个阶段**（`docs/tool-execution-pipeline.md` + `index.ts:1329` 起）：

1. **`tools/pre-execute` waterfall**（`index.ts:152`）：钩子、权限、沙箱。决策：`allow` / `deny` / `ask`（→ `ctx.approval` 一次性审批，缺席/不可答 → 拒绝）。
2. **monotonic guards**（`index.ts:704`）：注册后**单调执行**的守卫（deny 或 abstain），身份受保护——"owner policy that must not be reordered remains a registered guard"（审批 `ask` 在 guards 之前解析）。
3. **`tools/execute` waterfall（around dispatch）**：超时、重试、指标包住真正的工具 body（如 `timeout-policy`）。
4. **工具 body**：执行；FS 变更走 `fs/write-intent` / `fs/edit-intent` 事件门；工具自有的 session 事件（`todo/write`、`fs/observed`、`hook/invoked`…）在此产生。
5. **`tools/post-execute` waterfall**（`index.ts:175`）：`accept` / `block` / `replace` / 附加上下文。

之后：注册表外层规范化（管线/结果快照异常变成 `isError`）→ `ToolDefinition.finalizeContent`（`index.ts:247`，**内容-only 的最后不变式**，同步回调，调用开始时快照绑定——`index.ts:1398`）→ `tools/result` 同步通知（冻结的权威结果，lossless JSON）→ 活动批次 `additionalContexts` FIFO（作为记录的工具结果之后的注入 user/message）→ `tool/result` 事件 → UI 完成卡。

关键代码（`index.ts:1342`）：

```ts
async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
  return this.prepareExecution(exec, prepared => this.completeScheduledExecution(prepared))
}
// completeScheduledExecution 按 prepared.kind 分派：
//   dispatch   → dispatchScheduledExecution（pre/guards）→ post-result → finalize
//   post-result → finalizeScheduledExecution（post-execute + finalizeContent）
//   final-result → finishScheduledExecution（跳过 post-execute）
```

细节值得注意的设计：

- **参数物化**：`snapshotJsonValue(exec.arguments)` 先做 lossless-JSON 深拷贝并 `deepFreeze`（`index.ts:1412-1416`）——工具拿到的参数是不可变快照。
- **collapse（Code Mode）**：被折叠的工具调用在策略管线**之前**确定性拒绝，`tools/pre-execute`、审批、guards 都不会看到它（`index.ts:1373-1444`）——"policy must never observe — or worse, approve — a call that can only fail"。
- `UNKNOWN_TOOL` 仍走历史 dispatch 路径，让策略监听器能看到每个到达注册表的名字。

### 6.3 调度：`executionMode` 与并行池

`executeToolCalls`（`agent-loop/src/tool-calls.ts:59`）把一步内的 model-order tool calls 分组：每次按**当前** `executionMode` 重新分类——exclusive 单独成组（屏障），parallel 组成滚动池（上限 `maxParallelToolCalls`）。`runGroup`：`tool/call` 在启动前落日志 → 有序 pre 与并发 body 重叠 → 结果按 **model order** 经 head-of-line cursor 提交（每次提交 `tool/result`，`additionalContexts` 进 next-step inbox）→ abort 时已启动的 drain+提交，未启动的写合成错误结果（`TOOL_ABORTED_BEFORE_DISPATCH`）保证回放有效。

### 6.4 Code Mode（代码模式）

- `code-mode.ts`：保留的 `run_code` 传输工具——从不进可过滤层，只在非 native 模式的 scope 可见。
- 模型只直接调用 `run_code`；程序内通过 SDK binding 发起**嵌套 dispatch**（`parent: exec.token`，`subCallId <parent>:code:<n>`），遵循与 native 完全相同的并发契约（exclusive 屏障 + parallel 池）。
- 子调用记录 `tool/code-dispatch-start` / `tool/code-dispatch` 事件（log-only，不进模型历史）；后者可经 `tools/code-dispatch-log` waterfall 改写 durable 副本（spill 策略的 preview+locator）。
- 外层 `run_code` 的结果是精选的 `{logs, result?}` 摘要（render 为文本），**只有它进入模型历史**。
- 折叠（collapse）：mode `code` 下模型直呼非 `run_code` 名字在策略管线之前确定性拒绝，错误信息指引正确调用途径；`dsh-agent-tool-presentation` 让 preset 在 scope 上 `tools.presentAs(mode)`。

### 6.5 模型面向工具全表（base 组合）

由 `docs/tool-catalog.md` 生成目录（54 个）：`ask_user_question`、`run_code`、`exit_plan_mode`、`bash`、`pwsh`、`cordis_define/inspect_list/inspect_query/inspect_self/run/stop/undefine`、`str_replace_editor`、`edit`、`read`、`read_image`、`write`、`glob`、`grep`、`terminal_*`（open/read/send/close/signal/list）、`create_goal/get_goal/update_goal`、`schedule_*`、`lsp`、`ralph`、`skill`、`session_event_read/search/trace`、`session_search/trace`、`subagent`、`interrupt_agent`、`list_agents`、`send_message`、`report`、`job_kill/job_list/job_output`、`todo_write`、`workflow`、`web_fetch`、`web_search`。

---

## 7. LLM 能力 Seam

**核心文件**：`packages/llm/llm/src/`（`types.ts`、`message.ts`、`assembler.ts`、`index.ts`、`error.ts`）、`packages/llm/llm-deepseek/src/`（`adapter.ts`、`serialize.ts`、`sse.ts`、`translate.ts`）

### 7.1 词汇与线协议

- **`ContentBlockMap`**（`types.ts:99-110`）是 merge-extensible 的封闭判别联合：`text` / `reasoning`（思考，与可见文本分开）/ `image`（attachment 引用）/ `tool-call`（`arguments` 全程是 **raw JSON 字符串**）/ `tool-result`（可嵌套任意块）。
- **`Message`**（`message.ts:129`）：`{ id: MessageId, role, content, source }` 的不可变值；`source`（`MessageSourceMap`）区分 user / plugin / model（含 provider/model/`replayState`）/ tool——语义词汇 `ContextForm`（instructions/catalog/snapshot/notice/relay/recall）是"谁产生"与"是什么信息"两条独立轴。
- **`StreamChunk`**（`types.ts:312-324`）是 adapter 的**唯一输出协议**（封闭联合）：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。协议纪律：delta 用 `index` 绑定块；`usage` 必须在 `finish` 前、`finish` 后不得再有 chunk；工具参数流式片段是 raw JSON 串；错误两条路（`stream()` 抛出 `LlmError` 或 `finish {kind:'error'|'aborted'}` 终结流）；`ReplayEnvelope` 是 adapter 私有重放元数据（半透明）。
- **`TokenUsage`** 为不相交计数：`inputTokens` 只算未缓存输入，缓存命中单独报 `cacheReadTokens`——DeepSeek 的 `prompt_tokens` 含缓存命中，适配器要减出（`llm-deepseek/src/translate.ts:53-62`）。
- **`BlockAssembler`**（`assembler.ts:36`）：chunk → 消息的唯一组装算法；对 delta-only 协议宽容；max-tokens 截断时丢弃所有 `tool-call` 块并同步剪掉 replay envelope 对应条目（"一处决策、两处派生"，二者永不打架）。

### 7.2 `LlmAdapter` 契约与 `ctx.llm`

- `LlmAdapter`（`index.ts:180-233`）抽象类，**只有一个抽象方法** `stream(options): AsyncIterable<StreamChunk>`；其余（`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel`）可选。
- `LlmRuntime`（`ctx.llm`）：`registerAdapter(providers, adapter)` 全有或全无注册（返回 `AdapterRegistrationHandle`，可 `replace()` 原子换路由）；`prepareCall()` 把一次调用绑定到同一注册（HMR 不混配）；`stream()` 包 `llm/stream` **waterfall**（retry/replay/routing 都挂这里）；`forAdapter()` 只把 `replayState` 传给同时拥有历史与目标 provider 的同一 adapter 实例——换 provider 后旧私有重放状态自动失效，降级为中立内容。
- 失败统一为 `LlmFailure{message, code, ...}`；规范码：`CONTEXT_WINDOW_EXCEEDED`、`QUOTA`、`EMPTY_RESPONSE`、`INVALID_CREDENTIAL`（compaction 的恢复逻辑依赖它们）。
- 每个 provider HTTP 请求必须带 `attributionHeaders()`；`assertUsableApiKey` 拒绝空/非法 key 且绝不回显密钥。

### 7.3 llm-deepseek：参考实现布局

四层职责分离（新 adapter 的参考模板）：`serialize.ts`（请求组装；tool-result 块 → 独立 `{role:'tool'}` wire 消息；assistant 纯工具 turn 发 `content:""` **绝不发 null**；thinking 模式的 `reasoning_content` 只在工具轮回传）→ `sse.ts`（`EventSourceStreamParser` 解码；EOF 未见 `[DONE]` 抛 `STREAM_CLOSED`）→ `translate.ts`（wire → StreamChunk；finish/usage 延迟到 `[DONE]` 统一 flush）→ `adapter.ts`（连接事实按操作解析：`options()` / `resolveApiKey()` / `resolveUserId()` 三个 thunk，每次请求解析，in-flight 流保持开始时的快照；端点 `{baseURL}/chat/completions`；错误映射 401/403→AUTH、429→RATE_LIMIT、400+上下文超限→CONTEXT_WINDOW_EXCEEDED 等）。

**新增一个 provider 的最小路径**（cookbook）：实现 `LlmAdapter`（唯一必选 `stream()`）→ Cordis 插件 `inject: ['llm']` → `Config`（schemastery）+ 环境回退 → `ctx.llm.registerAdapter(['my-provider'], adapter)`。

## 8. 持久化与会话数据

**核心文件**：`packages/session/session-persistence/src/{index,coordinator,write-behind}.ts`、`session-persistence-jsonl/src/{index,format}.ts`、`session-persistence-sqlite/src/{index,schema}.ts`、`session-projection/src/index.ts`、`session-projection-cache/src/index.ts`

### 8.1 `SessionPersistence` seam 与 Coordinator

- 抽象服务 `ctx.sessionPersistence`：`create/append/prepare/load/inspect/readFrom/list`；后端直接存 `SessionEvent`（**没有并行的持久化事件类型**），`SessionHeader` 单独携带。
- `PersistenceCoordinator`（约 800 行）是**后端无关的写路径编排**：按会话 id 串行化、写路径监听（`session/created` 捕获 header、`session/event` 入队、`session/flush` 显式排空、`session/disposed` 退休排空）、懒物化、碰撞检测、HMR 前缀收养、prepared LRU 缓存、legacy 迁移、格式拒读（未知必读事件类型拒绝解释，除非 `ignorable: true`）。后端只需实现约 7 个存储原语（`PersistenceBackend`）。
- **flush 时机**：`session-checkpoint-policy` 拥有每请求持久性检查点；写控制器是每会话固定批窗口（默认 200ms）；后台写失败保留事件并暂停自动重试；`session/flush` 是 loop 认领下一普通 turn 前的排序与错误观察检查点。
- **crash recovery**：`prepareCore` = 读前缀 → 校验版本/身份 → 就地升级 → **合成缺失的 closers**（保留完整的中断 turn 不截断，补 `turn/end {kind:'interrupted'}`）→ 构建未发布 Session；`commitPrepared` 修后重读。活跃会话绝不 crash-repair。

### 8.2 JSONL 与 SQLite 后端

- **JSONL**：`root/<projectKey>/<encodeSegment(id)>/session.jsonl[.zstd]`；首行 header 记录，其后每事件一行；`packChunks` 把连续 chunk delta 打包（约小 60%）；默认 zstd 物理编码；物化用临时文件 + `link()`+`unlink()` 发布（防并发双写 clobber）；撕裂尾经 `commitRepair` 截断+补 closers；revision 由 stat 派生（`dev:ino:size:mtimeNs:ctimeNs`）。
- **SQLite**：三张 STRICT 表（`persistence_state` / `sessions` / `events`，`PK(session_id, seq)`）；`SCHEMA_VERSION = 15`（表布局，`PRAGMA user_version`）与 `SESSION_FORMAT_VERSION = 0`（事件词汇）**正交**；`application_id = 0x44534850` 防污染无关数据库；追加是单事务（物化 + 逐事件 INSERT + revision+1，中途失败整体回滚）；撕裂尾扫描找最后合法 `turn/end`。

### 8.3 投影系统

- `ProjectionDefinition<K, S>`：`{ key, schema, init(), apply(state, event), view(state), stateVersion }`——**三个函数必须同步**，`state` 必须 plain JSON；无关事件返回同一引用（`Object.is` → 零下游工作）；**整值事件规则**（携带状态的事件含完整 post-change 状态，last-wins）。注册是 effect，同 key 重复注册计数共享。
- `ctx.sessionProjections`：订阅一次 `session/event`，每个事件驱动所有单元 `apply`；单元格懒构建（从内存日志全量重折）；热路径通知同步非否决；`snapshot()` 全同步（`asOfSeq = session.seq - 1`）。
- **投影缓存**（`ctx.sessionProjectionCache`）：写时机 = 事件计数/间隔节流 + `turn/end` + session detach 两个强制点；写前先 `sessions.flush()`（持久化先于缓存行的**持久性屏障**，崩溃只落后不超前）；冷读阶梯：缓存行 → `persistence.readFrom(id, floor)` 尾重放 → 失败则全量重折；`cachedSnapshot` 零 I/O 列读。缓存行 identity 绑定 `{createdAt, cwd}` 防旧记录污染。
- **storage hub**：`ctx.storage` 是零 IO 的会合点（多后端并存 + data-form 挂载）；`ctx.storageDomain`（唯一消费者）提供 schema 校验 + `domain/changed` 事件的 KV 域，每域单写链（先后端持久性、再内存、再通知）。

### 8.4 会话标题与遥测

- `ctx.sessionTitle`：latest-wins 折叠 `session/title` 事件（log-only）；确定性回退 + 唯一可选异步 provider（`first-prompt` / `all-prompts` 两个薄插件共享 LLM 实现）。
- `ctx.sessionTelemetry`：捕获侧（固定 chunk 投影 + `session-telemetry/record` **redaction waterfall**）+ 最小后端契约；`session-telemetry-otel` 是唯一 provider（OTLP/HTTP，默认 `DISABLED`）。

---

## 9. 执行世界：沙箱/子进程/Shell/文件系统

> 依据研究报告 `research/D-execution.md`。"执行世界"不是单个包，而是一组能力 seam 的横向切片：**sandbox（只包 argv）→ subprocess（spawn 进程树）→ shell（bash 语义与预算）→ 工具（模型面）**；fs 与 subprocess 平级、共享同一世界；terminal 站在 subprocess 的 PTY 原语上。

### 9.1 沙箱体系（`ctx.sandbox` + `ctx.sandboxPolicy`）

- **三值模式**：`'read-only' | 'workspace-write' | 'danger-full-access'`（`packages/sandbox/sandbox/src/index.ts:29`）。
- **policy 是 per-call 的**：`SandboxPolicy` 携带 `mode`（provider 只会收到 `ConfinedSandboxMode`，`danger-full-access` 在消费者边界分流，永远到不了 provider）+ `workspaceRoot`（即使不消费也携带）+ 可选 `sessionId`（Windows ACL 后端按 session/workspace 分配私有临时目录）。
- **解析链**：`ctx.sandboxPolicy` 是唯一 owner——`request.mode（审批通过的显式升级）?? 会话日志最后一条 sandbox/mode 事件 ?? 部署默认（fail-safe 'read-only'）`；workspaceRoot = 会话 immutable cwd ?? 配置回退。**session override 的存储就是会话事件日志**（`setSandboxMode` = `session.append('sandbox/mode', ...)`，倒序折叠）——没有外部配置存储，重放日志即状态，bash 与 fs 共享同一 override。模式还渲染成模型可见的 runtime-context（重放可重建）。
- **`ConfinedArgv`**：核心概念——消费者把**即将 spawn 的 argv** 交给沙箱（`confine(argv, policy)` 返回包装后的 argv + `enforcement` 报告 + `denialSignatures` 方言表 + `runnerFailureRules` 证据规则）。bash-sandbox 把 `['bash','-c',command]` 交出去然后 spawn `confined.argv`；terminal-bash 的 PTY argv 同样过沙箱。enforcement 是报告的"事实"而非承诺（windows-acl 诚实声明 `partial`）。
- **平台链**：linux `['bwrap','landlock']`、darwin `['seatbelt']`、win32 `['windows-acl']`；多候选做真实功能探测（spawn profile 跑 `true`）。可写根唯一出处 `writableRoots(policy)`（workspace + /tmp + tmpdir，`realpathSync.native` 规范化）——**"write 工具不能写 /tmp 但 bash 能写"的不对称在结构上不可能出现**。
- **Landlock（Linux）**：`native/landlock-run` 是 ~300 行 C11（musl 静态链接）launcher：先在自己进程装 ruleset 再 `execve`（规则随 execve 继承给整棵树）；`--ro/--rw` 授权列表，**未授予即拒绝**；内核 ABI 协商，`ENOSYS/EOPNOTSUPP → fail-closed` 绝不无约束 exec；`--probe` 真功能探测；失败打印 `landlock-run: ...` 并 exit 125。
- **Windows ACL**：WRITE_RESTRICTED 受限令牌 + 能力 SID；workspace SID 从规范化路径确定性派生（ACE 每机器每 workspace 只物化一次），私有 temp SID 从随机目录派生（兄弟 session 不能互入）；runner 用 `CreateProcessAsUserW`，**子进程从不无约束启动**。
- **fail-closed 与升级**：`SandboxUnavailableError`（`SANDBOX_UNAVAILABLE`）可区分"缺少约束"与"命令失败"；`escalation.ts` 是跨工具族共享的升级词汇（`WIDER_MODES` 严格更宽阶梯、`approveEscalation` 执行前 fail-closed 序列、`sandbox_permissions` 与 `justification` 强制成对）。

### 9.2 子进程 seam（`ctx.subprocess`）

- **`SubprocessSpawnSpec` 全字段、零默认**（`types.ts:75`）：`argv`（绝不 shell 解释）/`cwd`/`stdio`（全显式）/`graceMs`/`signal?`/`env?`（`undefined` 是墓碑）。
- **DSH_\* 环境词汇**：`DSH_ENV_PREFIX`；`scrubbedParentEnv()` 移除凭证形态名（`KEY|PASSWORD|SECRET|TOKEN`）+ 全部 `DSH_*`——**子进程的父环境 DSH_\* 一律被 scrub，只有显式 `dshEnv` 快照能进入**。`shell-env` 注册表构建每调用的受信快照（内建 `DSH_HOME`/`DSH_SHELL=1`/`DSH_SESSION_ID` + 贡献者注册的 `DSH_SESSION_JSONL` 等；key 命名与返回值有 drift 保护）。
- **进程树/会话生命周期**：spawn 即 detached 进程树（POSIX 自有进程组 / Windows `taskkill /T`）；live 集只在**整棵树**退出后释放所有权（会捕获 TERM 的后代也必须被持有）；宿主退出同步兜底 force-stop；`terminate()` 是唯一终止动词——SIGTERM → `graceMs` 后 SIGKILL 升级，每次升级前重新探测整树存活（防 pid 复用）。
- **输出 offset 读取器**：tail-keep 内存窗口 + 首次溢出开 spill 文件（`wx` + 0600 私有目录防符号链接种植）；`readFrom(byte)` 非消费性，独立 reader 不互吞输出。
- **终端进程原语**：`spawnTerminal`（node-pty + PassThrough）；Linux 前台进程组探测读 `/proc/<pid>/stat` 的 tpgid、`isStdinWaiting` 读 `/proc/.../syscall` 按架构 syscall 表判断是否在等 fd 0——支撑 send 的 `inferred_idle` wait reason。

### 9.3 Shell seam（`ctx.shell`）

- **request/spec 分离**（"explicit > implicit" 的模板）：`ShellExecutor.resolve(request) → ShellExecSpec`——模型/插件提交 Request（command 必填），executor 显式解析出全字段 Spec（timeoutMs 经 `clampTimeout` 夹到上限），`run/start` 永不 re-default。`ShellRunResult.timedOut/aborted` 由调用方判定（first-cause 语义）。
- **后台 `ShellProcess`**：`status/exitCode/done（永不 reject）/readOutput()（消费性，stderr 以 [stderr] 段合并）/kill()`；**作业语义（job id/owner/notice）属于 `ctx.jobs`**，seam 只给进程句柄；后台进程由 `ctx.subprocess` disposal 而非 executor 停止（executor 热重载不杀后台进程）。
- **bash-local**：`['bash','-c',command]` 经 `ctx.subprocess.spawn`；env 合并 `{...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv}`（dshEnv 最后、不可被顶掉）；**bash-sandbox 是纯叠加**（extends LocalBashExecutor）：danger-full-access 直接 super.run，否则 confine 后 spawn，settle 先判 runnerFailure 再判 denial，`proc.sandbox = {mode, denied, enforcement, runnerFailed}` 盖章。
- **pwsh-local**：逐调用镜像 bash-local；命令作为**单个 argv 元素**给 `-Command`（无中间 shell，不存在 bash 的引号转义层）；`ENCODING_PREAMBLE` 钉死 UTF-8 输出。
- **渲染契约**：`[exit code: N]` / `[killed by signal: X]` 标记的反向解析 `parseExitStatus`（重放只有渲染文本，必须从尾部剥出状态 pill）。

### 9.4 FS seam（`ctx.fs`）

- **不透明标识**：`FsTargetKey`/`FsVersion` branded；消费方禁止解析 targetKey（本地=realpath，远程可能是 URI）。`processPath` 是执行世界的桥——把 fs target 翻译成"该世界子进程可打开的规范绝对路径"。
- **观察策略**（`fs-observation-policy`，事件即策略 seam）：`fs/write-intent` / `fs/edit-intent` 单槽 waterfall（不调 next() 即替换裸行为）+ `fs/observed` 同步记录。**读过的文件才能 CAS 写**（读过 → `replaceIfVersion`；没读过/确认不存在 → 只允许 `createIfAbsent`）；edit 必须先读（`FS_NOT_OBSERVED`）；owner 从 actor 的 `agent.session` 取，WeakMap 弱持有随会话回收。
- **fs-sandbox**：只给两个变更操作加 per-call policy 围栏（读全放行）；workspace-write 下对**fresh canonical path** 做 `isPathUnder` 包含检查（捕获 resolve 后换掉的符号链接祖先），返回"刚检查过的那个 target"去写——没有 check-here-write-there TOCTOU；拒绝是结构化错误 `FS_SANDBOX_DENIED`，工具层映射成模型面 `[sandbox: file access denied under <mode> mode]`。**fence 是可信代码里的策略检查，不是内核边界**（内核级隔离是 bash-sandbox 的活）。
- **tool-fs UI 呈现意图**：read → generic（带 locations）；write/edit → **diff 卡**（`computeHunkDiffs(before, after)` 上下文 diff）；read_image → generic；结果可经 `presentationMeta` 严格校验后还原卡片（非法数据回退 generic）。

### 9.5 终端、code-runtime、LSP、E2B

- **terminal**（`ctx.terminals`）：owner-scoped 持久 PTY 注册表——"后端拥有终端机制，服务拥有 id、发布、授权与清理"；send 是排他操作（`TerminalWaitReason`）；清理三路径（kill / owner dispose / 服务 dispose best-effort）；**PTY 打开期间禁止切换 sandbox 模式**（进程树无法随模式重新约束）。
- **code-runtime**（`ctx.codeRuntime`）：`CodeRunRequest{program, bindings, signal}`；`CodeRunFailure.kind` 六种；**error 是结果字段，run() 永不 reject**；跨后端统一的保留集（`RESERVED_BINDING_GLOBALS`、`PORTABLE_RESERVED_WORDS` 为 ECMAScript ∪ Python 保留字并集——加新语言必须审查拓宽）；worker-thread 后端每 run 一个全新 Worker（`env: {}`、无 loader hooks、内存上限）、`computeMs` 用事件循环**忙时**计量（不可游戏化）、hostile-peer 端口防御、teardown 等每个 worker 退出。
- **LSP**：操作是闭集（`goToDefinition|findReferences|goToImplementation|hover`）；`lsp-stdio` 通过 `ctx.fs` 解析 workspace（`processPath` 作子进程 cwd、`fileUrl` 作初始化 URI）——**LSP 主机显式站在 fs/subprocess 共享执行世界**。
- **E2B**：远程沙箱作为 provider 整体替换——`fs-e2b` + `subprocess-e2b` 共享同一远程 `Sandbox` 句柄（"filesystem and process operations inhabit one remote Linux world"）；替换后 `bash-local`/`tool-fs`/LSP 消费方**零改动**。容器/microVM/远程执行是**整套能力 seam 的兄弟实现**，而不是 `ctx.sandbox` 的 provider。

---

## 10. Agent 级能力层

> 依据研究报告 `research/E-capabilities.md`。所有能力遵循"seam + tool consumer"模式，两条核心纪律贯穿：**fail loud, no silent degradation**（能力不匹配在 start/mount 时即抛类型化错误）与**模型可见 ⟺ 可重放**（状态以会话日志事件为唯一权威，UI/恢复端从日志 fold，无活镜像）。

### 10.1 子代理（`ctx.subagents`）

- **命名 provider 注册表**（仿 LLM adapter registry，非 bash 单服务模型）：`SubagentProvider {name, capabilities, inheritsParentContext, start(), prepareContinuable?}`；`assertCapabilities` 在 start 前逐项校验（缺 `outputSchema`/`depthLimit`/`toolFilter`/`persona` 即抛 `UNSUPPORTED_CAPABILITY`）。
- **进程内后端**：`spawn`（全新子代理，零父上下文）与 `fork`（**继承父日志到最后一个 `turn/end` 的平衡前缀**作为 seed——进行中的工具调用轮不平衡，不能作为合法子会话重放）。共享 `in-process-driver`：深度预算（以持久化父 header 为单调下界）、委托策略捕获（子代理权限范围固定、不可加宽）、`subagent/descriptor` 事件（持久身份，cold resume 只需日志+代码）。
- **结构化输出**：子作用域注册 `structured_output` 捕获工具 + 尾部提示；两阶段提交（工具暂存 → 权威 `tools/result` 通知时才落 `captured`）；后续工具调用被单调 guard 拦截。
- **可续对话（continuable）**：可续子 = 持久 Session + **至多一个进程内 Activation**（residency epoch）；消息顺序唯一（Agent inbox 是唯一队列）；状态从"Agent 静止性 + owned-children"推导（无第二套状态机）；`followup` 按驻留性路由（running 入队 / waiting 唤醒 / 无 Activation 则 coldResume：`persistence.inspect` → 授权持久化 header 的直接父 → 只 fold 子日志自己的后缀 → `agents.resume`）；settlement 通知在释放 ownership **之前**投递（父静止则 followup、忙则 steer、teardown 中则 inject）。
- **工具面**：`tool-subagent`（provider 绑定，`backgroundMode: one-shot | continuable`；挂载时校验能力——配置错误在挂载失败而非首次委托失败）、`tool-subagent-control`（全局 `send_message`/`interrupt_agent`/`list_agents` 薄适配器）、`tool-subagent-report`（子作用域 `report` 工具，经 `registerContinuableSetup` 装进每个可续子）。
- **进程外后端**：ACP / Claude Code / Codex 经 `ctx.subprocess.spawn`（共享 env 擦除、树 teardown）；`NO_START_CAPABILITIES` 全 false——进程外孩子无法兑现的能力**全部声明为 false**，服务在 start 前拒绝，绝不接受后忽略；DSH SDK 后端例外（SDK 自 spawn，自行 scrub）。

### 10.2 工作流引擎（`ctx.workflowEngine`）与 Ralph

- 每 context 一个引擎（与 bash 同款，无 provider 注册表）；`WorkflowStartRequest{script, meta, args, subagentProvider, maxTotalAgents, parent, signal}`；`WorkflowRun.result` 永不 reject。
- **worker-thread 后端**：每 run 一 Worker + vm 隔离 realm；hooks 以冻结函数安装：`agent()/parallel()/pipeline()/phase()/log()`；选项白名单（`label/phase/schema/provider/model`，`effort/isolation/agentType` **点名拒绝**）；取消是"下一个 hook 边界"（`throwIfCancelled` 在每个 hook 入口）；**fatal 错误必须杀死脚本**（`WorkflowError.fatal`：`parallel()`/`pipeline()` 遇 fatal 即死，普通子失败只把该项化为 `null`）；worker 死亡时用 liveAgents 账本合成缺失的 agent-end——"每 started child 恰好一个 end"在每条 stop path 成立；**线程绝不比 run 活得久**。
- **tool-workflow**：把 `workflow/*` 事件投影为父会话的 `tool-workflow/*` log-only 事件（UI 与重放从日志读）；`maxResultChars` 封顶。
- **tool-ralph**：**部署方固定的脚本**（模型只提供 objective/maxRounds）；每轮打开无父会话、无先前子会话的全新子代理（`requireFreshProvider` 要求 `inheritsParentContext === false`——fork 型 provider 被拒绝，从结构上保证 fresh）；目标不可变；只有有界结构化报告跨轮（`{status, summary, evidence[], nextSteps[], blocker}` 规范化校验）；`complete/blocked/轮数上限` 三终局。

### 10.3 目标（`ctx.goals`）与 Plan mode

- **数据模型**：`GoalRef{id, revision}`（CAS）；`GoalPhase = active|paused|blocked|complete`；`GoalBlockReason{code, message}`（code 为稳定 kebab-case 分类）；**`GoalActivation = armed|disarmed` 是进程本地的、从不持久化**——持久 phase 回答"目标怎么了"，进程内激活回答"续跑消费者能否开新一轮"；重启后默认 disarmed（resume 需人类再授权）。
- 持久化：每次变更 = `goal/change` 会话事件（完整 post-change 快照或 tombstone），严格重放 fold 逐字段校验；`commit` 在同步 append 边界把"意图激活"与事件 seq 配对（不匹配回退 disarmed）。
- **goal-round-driver**：`readyToDrive`（fiber ACTIVE、agent 精确存活且 idle、无竞争消息）→ armed + active + 预算内 → `<goal_round>` prompt 经 `GoalMessageSource` 消息 `followup`；**入场防护**是核心：`agent/pre-step` 监听器核对六项（fiber/attempt/内容来源/goal id+revision/phase armed/round === roundsStarted+1），任何不符 reject 该轮并恢复其它 claimed 消息；`roundsStarted` 只在被接受的 goal 来源 `user/message` 落地时递增。
- **tool-goal 执行权威**：edit/pause/resume 要求当前根代理轮内有 `user` 来源消息（直接人类）；complete/blocked 要么直接人类、要么当前 goal 的精确已接受轮；blocked 在轮权威下还要求 `roundsStarted >= 3`（默认）。
- **plan-mode**：`plan/mode` log-only 事件（whole-value、绝不进模型 transcript）；fold 恢复无活镜像；轮内切换记入 `pendingIntents` 等下一个被接受的 pre-step；`exit_plan_mode` **常驻注册**（plan mode 只改 prompt 节不改工具目录），执行要求以 `# ` 开头 + 经 user-questions seam 发起 `plan-review` 审查（approve → 静默 pending exit，keep planning → 抛错带反馈让模型修订）。

### 10.4 压缩、溢出、技能、任务、会话查询

- **compaction**（`ctx.compaction`）：`compaction/start|summary|end|prune` 全部 log-only（锁/摘要/影子价格）；崩溃留下"无配对 start"作可检测孤儿锁；摘要必须**严格变小**（token meter 验证）；`selectCompactableRange` 保留定价尾部且**绝不劈开工具调用/结果对**；`compaction-basic` 触发：`agent/pre-step` 压力 + `agent/request-error` 的 `CONTEXT_WINDOW_EXCEEDED` 溢出恢复（先 model-free prune 再压缩，成功返回 `{kind:'retry'}`）；摘要用 `ctx.llm.stream()` 直接生成（前缀复用会话自己的 system/tools/messages，不失效 provider KV cache）。
- **tool-result-pruner**：按 Unicode code point 修剪超预算工具结果，先 append `compaction/prune` 影子价格再 surface replace（计量事件与替换同步相邻）。
- **spill**（`ctx.spillStore`）：`saveText(input): Promise<SpillRef>` 唯一动词；`spill-policy` 是 `tools/post-execute` 变换器（超大纯文本结果 → 头/尾预览 + locator；`read` 工具跳过防 read→spill→read 循环）；**best-effort**——spill 失败绝不把成功工具调用变成 isError。
- **skill**（`ctx.skills`）：provider 注册表 + 分层合并（最近层同名直胜）；`tool-skill` 提供会话前缀目录（模型目录只含 name/description，绝不含 body 或绝对路径）。
- **jobs**（`ctx.jobs`）：抽象注册表 + `jobs-local` 进程内实现；owner session id 围栏（**授权而非保密**——id 可预测）；`job_output` 有界等待超时返回 `[status: running]` 而非 TOOL_TIMEOUT；`maxConsecutiveWakes` 防自激通知链。
- **session-query**（`ctx.sessionQuery`）：精确读/过滤/追踪后端无关；SQLite 后端 FTS5 全文检索；`tool-session-query` 五个模型工具（`session_search`/`session_event_search`/`session_trace`/`session_event_trace`/`session_event_read`）。
- **其他**：`agent-instructions`（AGENTS.md 兼容指令注入）、`session-reference`（跨会话快照）、`time-context`/`tmux-context`（时间/终端上下文）、`schedule`（无 ctx seam，状态全来自 `schedule/change` 事件，到期等 agent 完全空闲后 `followup`，绝不打断当前轮）、`message-feedback`（生命周期绑定反馈）、`attachment`（内容寻址图片存储）、`mcp-client`（外部 MCP 服务器工具注册进 `ctx.tools`，`mcp__<server>__<name>` 命名，图片经 `ctx.attachments` 持久化）。

---

## 11. 组合与配置体系

### 11.1 Profile / Bundle / Patch 三层模型

运行中的 `dsh` 是一棵插件树，按有序分层装配（`docs/architecture.md` + `packages/boot/app-boot`）：

1. **profile**：Harness home 中的命名组合（列出叠加哪些 bundle、安装的树外插件、用户自己的 `cordis.patch.yml`）。`web`、`headless` 是随附模板。
2. **bundle**：Cordis 配置行 + 它们挂载的代码的分发格式——任何插入物都可被上层 patch。`dsh-base`（每个 profile 的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测）、`dsh-web-app`（浏览器应用）、`dsh-headless`（一次性运行器）为三大随附 bundle。
3. **patch**：按行 id 寻址；**整行替换 config**（不合并）或插入新行。叠加顺序：bundle 依 profile 所列顺序 → profile 的 `cordis.patch.yml` → home 级 → `--patch` overlay。最后写入者胜。

`package.json` 的 `dsh` 字段声明身份：`dsh.profile`（列出 bundle）、`dsh.bundle`（指向 bundle 的 patch 文件）。

`dsh --profile web --dump-config` 打印机器实际启动的树；任何一行都可以被你的 patch 替换。

### 11.2 base bundle：默认组合解剖

`packages/bundle/base/cordis.patch.yml`（451 行）是**所有 profile 的共享底座**，值得通读。要点：

- **模型适配**：`llm`（seam 服务）+ `llm-deepseek`（官方适配器，零内联密钥——"No key or endpoint is inlined: both resolve per request"）+ `llm-pi-ai`（多 provider 双胞胎，休眠挂载：设置节提供 profile 才激活路由）。
- **默认模型**：`agent-default-model`（`provider: deepseek-official`、`model: deepseek-v4-flash`）。
- **持久化**：`session-persistence-jsonl`（`root: !!js dshHomePath('sessions')`）、`session-query-sqlite`（`openAt: never` 默认禁用全文搜索）、`attachment-local`、`session-projection`、`session-telemetry-otel`（`mode: !!js process.env.DSH_TELEMETRY_MODE || 'DISABLED'`）。
- **执行世界**：`subprocess-local`、`sandbox-local` + `sandbox-policy`（`mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，`workspaceRoot: !!js process.cwd()`）、`bash-sandbox`（`disabled: !!js process.platform === 'win32'`）、`pwsh-sandbox`（反之）。
- **审批**：`user-approval`（`policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`）+ `permission-presets`（`read-only` / `workspace-write` / `danger-full-access` 三档预设，把沙箱模式与审批策略打包）。
- **工具与能力**：`tool-bash`（Windows 禁用）、`tool-pwsh`（非 Windows 禁用）、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`、`tool-todo`、`tool-goal`、`tool-web`（`fetch: false`——fetch provider 未挂载，SSRF 防护延后）、`web-search-deepseek`、`tool-skill`、`tool-jobs`、`tool-subagent`（`provider: spawn`、`backgroundMode: continuable`）、`tool-subagent-fork`（one-shot）、`tool-subagent-control`、`tool-subagent-report`、`tool-ralph`、`tool-workflow`、`workflow-worker-thread`、`spill-local` + `spill-policy`（`maxInlineBytes: 50000`）、`compaction-basic`、`tool-result-pruner`、`timeout-policy`、`repeat-tool-reminder`、`session-checkpoint-policy`、`agent-instructions`、`commands`、`command-feedback`、`command-goal`、`command-compact`、`plan-mode`（含完整 plan-mode 系统提示词文本）、`goal` + `goal-round-driver`、`token-meter`、`skills` 三件、`shell-env`、`tools`、`system-prompt`（`persona: ''`）、`agent-loop`（`agents: []`——base 不创建任何 agent）、`fs-sandbox`。

> **设计要点**：行顺序不承载加载语义（激活是服务可用性驱动的）；一行只属于一个 bundle 层 + 用户层（模式差异的行放各模式 bundle，base 只留共享身份与中性默认）；`disabled` 表达式在每次挂载决策时求值。

### 11.3 web-app bundle：浏览器面如何叠加

`packages/bundle/web-app/cordis.patch.yml` 在 base 之上：

- **覆盖**：`system-prompt`（persona 模板 `You are a coding agent powered by the {{model}} model...`）、`hmr`（`disabled: true`——TODO 重新启用）、`tools`（临时 `DSH_TOOLS_MODE` 环境缝）、`session-query-sqlite`（内存索引）。
- **插入（host 平面）**：`code-runtime-worker-thread`、`storage` + `storage-json` + `storage-domain`、`message-feedback`、`session-log-download`、`workspace`、`session-projection-cache`、`session-stats`、`directory-picker-auto`、`plugin-inventory`、`api-gateway`（apiproxy）、`cordis-host-runner`、`web-startup`、`webserver`（host/port 来自 `ctx.webStartup`，默认 3080）、`web-runtime`、`client-hmr`、`modules`、`connection`、`api-remotes`、`client-runtime`、`cordis-client-runner`、全部 `ui-*` 浏览器插件（约 30 个）。
- **agent 平面后移**：Web 模式下每个会话用 **agent preset** 组合自己的工具/提示词，因此 base 中一组 host 级工具行在此 `disabled: true`（`tool-bash`、`tool-pwsh`、`tool-jobs`、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`、`skill-filesystem`、`tool-skill`、`tool-goal`、`plan-mode`、`compaction-basic`、`command-compact`、`tool-result-pruner`、`tool-subagent*`、`workflow-worker-thread`、`tool-workflow`、`tool-ralph`、`agent-instructions`、`tool-todo`、`tool-web`），并插入 `agent-presets`（`default: standard`）。
  - **注释本身就是架构文档**：每行 `disabled` 都附有 host-plane 归属判据（"injection is not the only host relationship a Service can have"、"a Service a row outside its realm READS belongs to the plane both can see"），并链接 Agent Note `host-plane-ownership-after-presets`。
  - 禁用而非删除是刻意的：base 共享，行若从 overlay 消失会在将来重排组合时悄悄复活。

### 11.4 设置与凭据

- **`ctx.settings`**（seam）：插件注册 `SettingsNamespace`（zod schema），分层解析（defaults → 组合 `base` → 用户文档 `$DSH_HOME/settings.yaml`，热重载）；Web Models 页写的就是用户层。LLM 适配器把入口 config 注册为组合 base。
- **`ctx.credentials`**（seam）：配置只携带 `CredentialRef` **引用**（绝不内联值）；provider 持有值；消费者每次操作解析——轮换的凭据即刻到达下一次请求；Web 网关只暴露无值视图与只写存储。来源分层：继承环境 → 管理的 `$DSH_HOME/.credentials.yaml` → 项目/用户 `.env`。

### 11.5 Agent Preset：每会话组合

- `ctx.agentPresets`：在可信根（随部署的 `config/agent-presets/`）与用户根（`$DSH_HOME/.agent-presets`）发现 preset 目录，会话创建时挂载一个 preset 的 `cordis.yml` 到 agent 作用域。
- 要求：preset 中的服务行需要 `isolate` realm（否则拒绝——"rejecting a row that never activates or that publishes into the root service realm"）。
- `agentPreset` 持久化在 `SessionHeader` 中——恢复时必须恢复相同的工具/提示词组合。
- 一个 preset 就是一个组合（"a preset IS a composition"），所以它享有与 shell 访问相同的信任等级。

---

## 12. 交互与审批

### 12.1 `ctx.approval`：一次性审批 seam

**核心文件**：`packages/interaction/user-approval/src/{index,types}.ts`

- `ApprovalOutcome` 是**闭集且 fail-closed**：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`——唯一放行是 `allowed-once`，且只针对被问的那一个动作（一次性授权）。
- `ApprovalRequest{agent, toolName, callId?, reason?, signal?}` **刻意不含工具参数**（`callId` 让 UI 把问题挂到已流式展示的工具调用上）。
- `ApprovalPolicy = 'ask' | 'never'`：`never` 在**任何 dispatch 之前**由服务自身确定性返回 `rejected`（注释解释为什么 gate 不能是监听者形态——`prepend: true` 的监听者会坐在 gate 前面）。
- **per-session 策略即日志状态**：`approval/policy` 是持久化会话事件（log-only、可重放），从日志倒序折叠最后一个 switch；`setApprovalPolicy` 会 `agent.inject()` 一条用户消息让模型下一轮看到切换。
- `approval/request` 是 **waterfall**（scope 过滤到该 agent）；答案者返回 outcome 即认领，或 `next()` 委托；缺席兜底 `unavailable`；异常/越界返回值统一归一为 `unavailable`。审计事件 `approval/asked` + `approval/decided`（log-only，不进模型 transcript，"每次 ask 恰好一条 decided"由服务保证）。
- 答案者实例：Web UI（人类）与 ACP 桥（机器一次性选择，绝不把未知客户端响应推断成持久授权）。

### 12.2 permission-presets：把模式+策略打包成用户可见开关

`packages/interaction/permission-presets`：预设表 `Config.presets`（默认 `workspace-write` = 沙箱 workspace-write + 审批 ask；`danger-full-access` = danger-full-access + never）；**不拥有执法权**——执行、prompt、重放继续读各自的 knob 折叠（`sandbox/mode`、`approval/policy`），预设切换只是"记录意图 + 经每个 knob 的 canonical setter 写入"；当前值从 knob 折叠**推导**（不匹配任何预设 → 派生的 `custom`，仅可显示、永不可切换）；加载期 misconfiguration fails loud（表项占保留名 `custom` 抛错；`ctx.shell` 无 `sandboxMode` capability 抛错）。

### 12.3 `ctx.commands`：人类命令

`CommandRuntime extends TypertRemoteService`：`register(definition)`（注册边界校验名称 `^[a-z][a-z0-9_-]*$`）；`execute(agent, line, signal)` **不发给模型**直接调 handler；`command/run` + `command/done` 事件以 `commandId` 配对（log-only，不包 turn）；经 `@Remote` 暴露给浏览器。消费者：`/permission`、`/goal`、`/compact`、`/export`。

### 12.4 ask-user：暂停工具调用等人

- `ctx.userQuestions`：单活跃 UI provider；`ask()` 前做守卫（signal 中止 → `ASK_ABORTED`；带 agent 必须精确等于当前 live 实例 `CALLER_NOT_LIVE`；owned 子 agent 无人可问 → `DELEGATED_CALLER` 拒绝；无 provider → `NO_PROVIDER`）。**`await this.provider.ask(request)` 就是暂停点**。
- `ask_user_question` 工具：`execute` 调 `ctx.userQuestions.ask(...)`，答案折回**普通工具结果**进入 agent loop——模型侧完全无感，只是"一个等得比较久的工具"。

---

## 13. 通信层：Typert RPC 与 SDK

### 13.1 两套正交通道

1. **Typert / API Gateway（Host ↔ Browser）**：以 Cordis 服务为接收方、以"类型图生成"为核心的 unary RPC。分层：`remotes(api/remotes) → gateway(api/gateway) → connection(client/connection) → webserver(host/webserver)`。
2. **SDK（进程外程序 ↔ Host 运行时）**：`dsh-jsonrpc-agent` 独立子进程 + stdio 新行分隔 JSON-RPC 2.0（`packages/sdk/{protocol,server,client}` + `python/sdk`）。

### 13.2 Typert："类型即契约"的代码生成系统

- **生成器流水线**（`packages/typert/generator`，约 5000 行）：Analyzer（把 `ts.Program` 抽象为编译器无关模型 `FaceModel` + `TypeGraph`）→ Renderer（类型节点渲染回 TS 源码文本）→ Emitter（按包产出 JS + d.ts，公开类型与调用边界投影为 **zod v4 schema**）→ tsdown 插件（构建期写入包 `lib/`）。
- **产物**：`lib/typert.host.{js,d.ts}`（Host 运行时反射/校验描述符）、`lib/typert.remote-client.{js,d.ts}`（Client 可挂载贡献 + 声明合并）、`.d.ts.map`（编辑器从 Client 调用导航回 Host 源码）。package.json 约定 `./typert`、`./remote` 导出，由生成器强制校验。
- **声明**：业务服务继承 `TypertRemoteService`（`super(ctx, serviceKey)`），方法标 `@Remote` / `@RemoteScope(key)`；`Agent` 参数经 `TypertLookupMap` 声明投影为 wire 字段 `agentId`，`TypertContextMap` 提供 scoped Context 解析。严格约束：public、非 static、非泛型、无 rest/默认值/解构，可选取消参数必须是末位全局 `AbortSignal`。
- **`InvocationDescriptor` 是"本地反射"而非线上消息**——线上只传端点 `<namespace>/<method>` + 命名 `args`。
- **`ctx.typert` 注册表**：四个子注册表（`local` 描述符、`remotes` Client 贡献、`lookups` Host 对象↔wire 身份、`contexts` scoped Context）；`typert-loader` 监听 Loader 生命周期自动注册/撤回每个插件包的 `./typert` 产物（注册是 effect）。
- **`ctx.typertGateway`**：把自己注册为 Connection `/api` 通道的 interceptor（`claimsEndpoint` 只认领有严格描述符或活动 SRC marker 的两段式端点，未认领的落到 API Proxy）；`invoke` 流程：解析描述符（严格 → 曾注册已撤回则拒绝降级 → SRC 回退）→ `assertExactArguments`（精确匹配）→ 解析接收方（direct root ctx / context 经 `ctx.typert.contexts`）→ `ctx.get(service)` + binding 校验 → 逐参数 codec decode / lookup 解析 → 执行业务方法 → 结果 codec 校验 + JSON 安全断言。错误码 17 种。
- **Client 投影 `ctx.remote`**：普通对象上的具体方法（无 JS Proxy）；`ctx.remote.goals.create(agentId, {...})` 类型精确；scoped 面 `agentCtx.remote.goals.create({...})` 自动省略身份参数。`$mount(contribution)` 挂载，卸载逆序撤销并 abort 在途调用。
- **SRC 开发回退**：`node --import tsx` 启动时无生成器，装饰器 initializer 记入 `WeakMap` + 函数源码解析参数名构造弱描述符；但 Client 拒绝装载无 strict codec 的 SRC 描述符——Client 类型永远来自生成产物。
- **事件转发**：`api/remotes` 的白名单（11 个事件）经 `satisfies readonly TypertForwardableEvent[]` 编译期形状门；浏览器 `ctx.remote.$on('commands/change', ...)` 拿到与 Host 一致的签名。

### 13.3 SDK：JSON-RPC over stdio

- **协议**（`packages/sdk/protocol`）：`JsonRpcLineTransport`——新行分隔 JSON-RPC 2.0；坏行忽略；错误码 `-32601`（未知方法）/ `-32603`（handler 抛错）；线类型：`initialize{cwd, provider, model, maxTokens?}`、`session/prompt`（入队回执 `{messageId}`）、`shutdown`；通知 `session.event` / `session.status` / `subagent.started` / `subagent.finished`。
- **服务器**（`packages/sdk/server`）：`inject: ['agents']`；`prompt` 按 `sessionId` 惰性 `ctx.agents.create` + `followup` 入队；stdout 只承载协议帧。
- **TS 客户端**（`packages/sdk/client`）：`HarnessClient`（spawn 子进程、initialize/prompt、subscribe）→ 高层 `DeepSeekHarness.run()`（从入队回执等到下一个 agent `idle`，产出 `RunResult`）。与 Python SDK 是"设计孪生"，共享同一运行时协议。

---

## 14. Web 宿主与浏览器客户端

### 14.1 全景：一条启动链，两个构建面，三种消费者

1. `dsh` CLI → profile 的 bundle 层与 patch 层叠成 Cordis 入口列表 → `boot()` 挂载插件树（纯 Node 进程）。
2. `webserver` 监听（默认 3080）；`frontend-static` 认领 fallback 席位服务 SPA；`client-modules` 扫描声明了 `dsh.client` 的包并注入 `window.__DSH_BOOT__`。
3. 浏览器 → 按 `__DSH_BOOT__` 插件图拉取各插件 `/plugins/<id>/client.js` → **在浏览器里再跑一棵 Cordis 插件树**。
4. 浏览器树经 `/api/*`（HTTP POST RPC）+ WebSocket 下行流与 Node 侧通信——**浏览器是宿主插件的另一个消费者**。

### 14.2 启动链细节

- **参数归属分层**：launcher 只解析自己的旗标（`--profile`、`--patch`、`--dump-config`）；其余参数原样透传，由树内插件经 `ctx.cmdlineArgs` 自己解析（`dsh --profile web --port 8080` 里 `--port` 属于 web app）。
- `loadLayeredEnv`：继承环境 > 调用目录 `.env` > `$DSH_HOME/.env`，拒绝 bootstrap-only 变量名，快照经 `ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY)` 注入。
- `composeProfile`：5 个有序 patch 层（bundle 层 → profile 用户层 → home 层 → `--patch` → telemetry/预设补丁）；profile 首次使用自动初始化模板（`web: [dsh-base, dsh-web-app]`）。
- `boot()`：`new Context()` → 挂 Loader → prepare 钩子 → `mountRootInclude`（`cordis:include` 根条目 + patches）→ `loader.await()` → **`assertEntriesActivated`**（每个启用 entry 必须有 ACTIVE fiber，否则报出每个失败插件的原始栈/缺失服务）。
- **用户层热更新**：`watchUserPatches` 盯 profile/home 两个 `cordis.patch.yml`，改动时事务性重放 patch 列表（用户编辑永远挤不掉 bundle 层）。
- `--dump-config`：**不启动、不求值 `!!js`**，纯离线合成——用与真实 boot 相同的 `applyEntryPatches` 逐层快照 diff，输出带来源注释的可加载 YAML。

### 14.3 Web 宿主

- **webserver**（纯 `node:http`，不认识任何 harness 概念）：三张路由表（exact / prefixes / upgrades）+ 单 fallback 席位 + index taps；匹配顺序 exact → 最长前缀 → fallback；路由注册顺序无语义。
- **frontend-static**：非 GET/HEAD → 405；路径越出 dist 根 → 403；`/` → `applyIndexTaps(readFile(distIndex))`；SPA 回退（文件缺失 → index.html + 200）。
- **apiproxy**（`ctx.apiProxy`，传输无关网关）：浏览器路径由 connection 包接线——`/api` 前缀路由 → 信任围栏 `isTrustedApiRequest`（DNS-rebinding 防御）→ `PRIVILEGED_METHODS`（settings.*、credentials.* 等钉死 loopback）→ `toFetchHandler`；**业务错误永远是 200 + 信封**；`UNARY_ROUTES` 由 `RpcMethodMap` 编译器锁死。
- **事件推送两条路**：业务事件 = **每订阅者独立流**（`events.mux`/`events.host`，每个流先推基线再订阅，N 个标签 = N 条流，下行专用 WebSocket——上行只走 HTTP）；HMR 通知 = 真广播（`/plugins/events` SSE）。

### 14.4 浏览器客户端

- **`window.__DSH_BOOT__`**：`{rev, entries: [{id, url, rev, inject?, immediately?}]}`——是宿主 Loader 树的投影；`rev` 作缓存破坏；`<` 转义防脚本逃逸；`/plugins/<id>/client.js` 未知 id 响亮 404（绝不让 SPA fallback 把 HTML 当 JS 发）。
- **引导内核**（`client/web/src/boot.tsx`）：`parseBootManifest` → `ClientModuleSystem`（懒 CJS 模块表）→ 渲染加载页 → 并行 prefetch immediately 层 + `new Context()` → 注入 `loader.internal = modules` → 并发 `loader.create()` 全部 entry → `assertEntriesActive()` 全量扫 fiber。settle 后 `ctx.slots.renderSlot('root', {})`——整棵 UI 树挂在内置 root 槽上。
- **连接**：上行 = `POST /api/<method>`（信封 + rpcId 回声校验 + 业务值 schema 校验，互为镜像）；下行 = 每流独立 WebSocket（坏帧丢弃不杀流）；`ConnectionController` 一代 = 两条流 + `host.describe` 握手，断线指数退避重连。**没有 SSE/轮询**。
- **客户端插件注册**：`dsh.client` 字段（platform/inject/immediately）+ `exports["./client"]`；bundle 执行时只调用 `__ModuleLoader__.load({id, factory})` **注册 factory 不跑模块体**；`inject` 边让浏览器里的插件激活顺序与 Node 侧完全同构（服务依赖等待）。
- **HMR**：Node 半轮询 stat bundle（网络挂载无 inotify）；浏览器半收 SSE `rebuilt` 帧 → invalidate → prefetch → **registry-first teardown** → `entry.refresh()` 原地换 fiber，下游以 provider fiber uid 作激活纪元自动级联。

### 14.5 UI 插件体系

- **ui-slots**：`SlotMap` 空接口 + 声明合并（每个 UI 包贡献槽位契约，注册点与 props 全部类型推导）；槽轴 `single | list | keyed | chain` × `root | session-maybe | session`；`register({name, children})` 声明子槽即授予独占渲染权；组件 props 是四份额交集（运行时份额 + 子槽渲染 + store + inject 面）。
- **ui-layout**：一次 `register('root', {children: {sidebar, conversation, details, shell.overlay}})` 同时占据 root 槽、声明四个子槽、座入布局 store、接进 `ctx.layout` 服务。
- **典型插件 ui-goal**：`inject = ['slots','sessions','remote','remote.goals','locale','conversationEvents']`（fiber 注入等待决定激活时机）→ `ctx.slots.inject('conversation.chat.node', ...)` 注册 keyed 单元 → 业务面读 `session.projections.faceOf('goal')` 投影拿 `{id, revision}` 作 CAS ref → `await ctx.remote.goals.edit(sessionId, ref, {...})`。**插件没有 store、没有刷新链、没有事件监听**——全部来自投影 + Remote。

---

## 15. 扩展与自我修改

### 15.1 动态 Cordis 插件：agent 自我修改运行时

- **分工**：`cordis-host-runner`（Host 半：定义注册表 + 生命周期 + **node:vm 沙箱** + 审批往返）、`cordis-client-runner`（浏览器半）、`tool-cordis`（7 个模型工具：`cordis_inspect_*`、`cordis_define/run/stop/undefine`）、`ui-cordis`（浏览器面板）。
- **定义**：Plugin（稳定 `pluginId`）拥有若干**不可变 Package**（`packageId`，含 host/client 双半代码）；"修改" = 追加新 Package，旧版本永远可回滚；`cordis_define` 只校验语法（`new Script` 编译不执行）**不请求审批**——激活是 `cordis_run` 的事。
- **vm 沙箱**：新鲜 realm，globals 只有 console（带 `[cordis:<id>]` 前缀）、`harness.handle/defineTool/registerTool`、btoa/atob/TextEncoder 等；**Node API 陷阱**——`require/setTimeout/fetch` 被替换为抛出"重定向教学错误"的函数（指向 `ctx.fs`/`ctx.web`/`ctx.bash`）；注释明言"这不是 containment，只是可检查可释放的协作式沙箱"。语法错误带行号+脱字符+"这是纯 JS 不是 TS"教学提示。
- **request-run 往返**：有 client 半的插件激活需用户审批（`cordis/request-run` 事件 → 浏览器 approve/decline → `resolveRequestRun`）；工具调用不等待最终结果——异步结果经 `steerRunOutcome` 以用户消息回灌模型；失败/渲染错误 steer 回模型自修（inspect → define → update 闭环）。`demo:cordis` 演示的就是这个自我修改闭环。

### 15.2 Hook 桥（Claude Code / Codex）

- `hook-protocol`：`runHook` 经 `ctx.shell` 执行 hook 命令（享受凭据擦洗/进程组取消/超时）；stdin = payload JSON；`parseHookOutput` 产出方言中立的 `HookOutput`（把 CC 的 `decision` 与 `hookSpecificOutput.permissionDecision` 归一为中性 `approve|allow|block|deny|ask`）；log-only 审计事件 `hook/invoked` + `hook/result`（随会话日志持久化、可重放、不进模型 transcript）。
- **映射表**：`SessionStart → agent/session-start`、`UserPromptSubmit → agent/pre-step`（deny→reject）、`PreToolUse → tools/pre-execute`、`PostToolUse → tools/post-execute`、`Stop → agent/turn-stopping`（deny → `agent.steer` 强制续跑）、`SubagentStart/Stop → subagent/*`——**外部 IDE 的钩子被桥进 DSH 的扩展点事件**，而扩展点本身零改动。

### 15.3 ACP 服务器

`packages/acp/acp`：automation-only 的 Agent Client Protocol 服务器（JSON-RPC over stdio）；`newSession → ctx.agents.create(...)`（每个 ACP 会话 = 一个全新 DSH agent）；`prompt` 单 in-flight 槽 → `agent.followup(message)` → `settleAfterQuiescence`（等 admission + `whenIdle()` + outputTail 全安静）；只转发 committed assistant text/image（raw chunks/reasoning/tools 不上自动化线）；`approval/request` 监听把客户端 `allow_once/reject_once` 映射回 `allowed-once/rejected`（一次性选择）。

### 15.4 Python SDK

- `python/sdk`（`deepseek_harness`）：高层 `DeepSeekHarness`（可复用同步句柄，lazy 启动子进程）+ `Session.run(input)` + `RunResult`；低层 `HarnessClient`。
- `python/sdk-runtime`：捆绑的运行时二进制（hatch 构建从平台矩阵下载/打包对应平台运行时）。
- 经 stdio JSON-RPC 驱动运行时子进程（与 TS SDK 同一线协议）；`initialize(cwd, provider, model, max_tokens)` 对应 jsonrpc-demo 的初始化请求；配置经环境注入（`DSH_CORDIS_CONFIG`/`DSH_SESSION_ROOT`/`DSH_CWD`/`DEEPSEEK_API_KEY`）。

### 15.5 示例：最小 agent 组合

`agent-spine-demo`（代码 bundle：无 executor、无 UI 的 agent 脊柱）+ `examples/headless-agent/cordis.yml`（约 40 行：spine + `llm-deepseek` + `bash-local`/`subprocess` + `persistence` + subagent/fs 族）构成一个能跑的编码 agent；入口 `dsh --profile headless "<task>"`。"bundle 拥有共享脊柱，叶子拥有后端，app 包拥有入口"——Service Definition / Provider / Consumer 分离在组合层的落地。

---

## 16. 二次开发指南

> 官方 cookbook（`docs/cookbook/`）是权威操作手册。本节给出按扩展点分类的路径图。

### 16.1 先决心智模型

- **改行为，先找扩展点**：新行为挂到文档化扩展点（事件/服务/组合层）；**改 agent-loop 本身需要更新 `docs/architecture.md`**（仓库硬性约定）。下表是 `docs/architecture.md` 的"Where new behavior goes"的浓缩版：

| 目标 | 机制 |
|---|---|
| 加模型 provider | `ctx.llm.registerAdapter(...)`（参考 `llm-deepseek` 四层布局 + cookbook） |
| 加模型面向能力 | `ctx.tools.register(ToolDefinition)`——schema 自动进提示词 |
| 给某会话不同能力集 | 组合 agent preset（服务行需 `isolate` realm） |
| 加 shell 执行 | 注册 `ctx.shell` 后端；本地实现经 `ctx.subprocess` spawn |
| 加持久终端 | 注册 `ctx.terminals` 后端 + `dsh-tool-terminal` |
| 加人类命令 | `ctx.commands.register(...)`（不经模型轮次） |
| 加后台工作 | `ctx.jobs` 注册；`job_*` 工具收集/停止 |
| 加文件系统/策略 | 注册 `ctx.fs` provider 或监听 `fs/*` 事件 |
| 约束子进程 | `ctx.sandbox` 后端；消费者 spawn 前 wrap argv |
| 拦截请求/工具/轮次 | `agent/*`、`tools/*` 事件；`agent/turn-stopping` 停轮 |
| 加模型可见上下文 | `agent.inject()`（下一个被接受的请求落地） |
| 加 UI/编辑器集成 | 驱动 `ctx.agents`，从 `session/event` 渲染 |
| 加 Web Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染与重放 |
| 管理同会话目标 | `ctx.goals`；经 `agent/*` 续跑 |
| Fork 活会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 作用域注册 | 用该 agent 的 `agent.ctx` |

### 16.2 新增一个工具（最小路径）

参考 `docs/cookbook/adding-a-tool.md` 与 `tool-todo`/`tool-goal` 的源码：

```ts
// packages/my-tool/src/index.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'my_tool',
    description: 'Does something useful',
    parameters: { myArg: { type: 'string', required: true } },
    output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) { return { ok: true, ...args } },
    // 可选：presentCall/presentResult 声明 UI 卡片意图（generic/terminal/diff）
    // 可选：timeoutMs、isConcurrencySafe、finalizeContent
  }))
}
```

要点：工具 schema 是自研 DSL（非 zod）；`output` 必填；UI 呈现意图是设计的一部分；执行结果必须 lossless-JSON 可序列化；权限/审批/沙箱由管线统一处理，工具本身**不需要**写策略代码。

### 16.3 新增一个 LLM provider

四步（cookbook + `llm-deepseek` 参考布局）：① 继承 `LlmAdapter` 实现 `stream()`（唯一必选；遵守 StreamChunk 协议纪律：usage 在 finish 前、finish 后无 chunk、arguments 全程 raw JSON、错误两条路）；② Cordis 插件声明 `inject: ['llm']` + schemastery `Config`；③ `apply` 里 `ctx.llm.registerAdapter(['my-provider'], adapter)`；④ 可选面：`providerRetryPolicy`/`listModels`/`resolveModel`/`registerConfigurableProviders`/`registerModelDiscovery`。线协议与 chunk 翻译拆独立模块（serialize/sse/translate/adapter 四层）。

### 16.4 新增一个 capability seam（完整三件套）

按 `docs/cookbook/extension-cookbook.md`：Service Definition 包（抽象 `Service` + `ctx.<key>` 声明合并 + 类型词汇 + 契约 JSDoc）→ Provider 包（实现并注册同名服务；可多个并存/替换）→ Consumer 包（`tool-*` 或 `command-*` 把能力变成模型/人类可调用表面）。契约测试共享（如 `runPersistenceContract`）让"换 provider = 换包 + 跑同一套测试"。

### 16.5 新增 UI 插件（浏览器面）

1. 包内 `src/client/index.ts`（浏览器面）+ `src/index.ts`（Node 面，常为空壳或 host 半）；
2. `package.json`：`"dsh": { "client": { "platform": "web", "inject": [...] } }` + `exports["./client"]`；
3. `apply(ctx)`：`ctx.slots.register({name, children?}, Component)` 或 `ctx.slots.inject(parentSlot, ...)`（参考 `ui-goal`：inject 依赖 → slots.inject 注册 keyed 单元 → 业务面读投影 + `ctx.remote.<域>` 调 host RPC）；
4. 在 web-app bundle 或你的 profile patch 里加一行 `- id: my-ui ... name: '@scope/dsh-my-ui'`；
5. 构建后 `pnpm run dev:web` 热更新（或重建 + 刷新）。

### 16.6 新增一个 bundle / profile / 平台适配

- **bundle**：包内 `cordis.patch.yml`（insert 或按 id 覆盖）+ `package.json` 的 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`；patch 整行替换 config，模式差异的值必须由各模式 bundle 自己重申。
- **profile**：`$DSH_HOME/profiles/<name>/`（manifest 列 bundle + 用户 patch）；`dsh --profile <name>` 启动；`--dump-config` 离线验证组合。
- **平台适配**：base 已示范（bash/pwsh 双胞胎 + `!!js process.platform` 门控）；注意"禁用一族必须启用另一族"的完整性配方。

### 16.7 给 DSH 仓库本身贡献代码

- 先读 `docs/development.md`、`docs/testing.md`、`docs/defensive-patterns.md`、`AGENTS.md`、`CONTRIBUTING.md`；
- 新增包：`packages/<group>/<pkg>`，注册到 `tsconfig.host.json` 或 `tsconfig.client.json` 之一（`docs/cookbook/adding-a-package.md`）；
- 非平凡变更必须附 Agent Note（`.agents/notes/`）；
- 质量门：`pnpm run typecheck` / `lint` / `test` / `doc-sync` / `hygiene`；CI 拥有全量矩阵。

---

## 17. 工程实践与质量体系

- **构建**：`tsc -b` 先发类型 → `tsdown`（`DSH_BUILD_FACE=host|client`）打包；Typert 只在 Host tsdown 运行；`api/remotes` 是唯一拆分 TS 面的包。静态分析/测试走 tsconfig `paths` 到 `src`；消费构建产物的门禁显式声明依赖。
- **测试策略**（`docs/testing.md`）：行为测试（vitest）+ **快照测试**（keyless，ACP/headless 回放 vs 预期输出，`test:snapshot`）——"Every non-trivial model- or product-user-visible behavior change adds or updates a keyless snapshot through a real runnable example in the same PR"；真实 API e2e（`test:e2e`，无 key 自跳过）；CI 覆盖率门按文件 100%（`test:coverage`）。
- **文档纪律**：英中双语配对（`.i18n.yaml` 记录 + 翻译门禁）、`verify-*` 系列门禁（类型等价、导出 JSDoc、md 链接、mermaid、模块图等约 30 个）、生成的 catalog（tool/config/persistence/cordis 等）由脚本生成并被 `verify-*` 校验新鲜度。
- **Agent Notes**：`.agents/notes/` 是架构决策的持久记录（implemented/archived 分层）；"非平凡变更 MUST 附 Agent Note"。
- **自举**：DSH 用自己（AGENTS.md 约束 agent、demo:cordis 让 agent 改自己的运行时、快照测试让模型行为可回放）。
- **发布**：pre-release 立场（"foundation over blast radius"——未发布期自由重构，后端拒绝旧格式）；`pnpm run release:*` 脚本族（bump/verify/pack/publish）。

---

## 18. 术语表

| 术语 | 含义 |
|---|---|
| **seam** | 可替换能力，三角色：Service Definition（`ctx.<key>` 抽象）+ Service Provider + Consumer（通常是模型工具） |
| **scope** | 每 agent 注册单元：全局或恰好一个 scope key；`agent.ctx` 即 agent 作用域上下文 |
| **shadowing** | 最近者胜：scoped 工具/提示词段替换同名 global（per-agent 变体机制） |
| **setup window** | 创建槽：`CreateAgentOptions.setup`——scope 与 agent 对象已存在、但发布/首 prompt 之前，只注册不驱动 |
| **lineage** | 父子事实（`parentSession`、`delegationDepth`、`subagentDepth`）作为数据，不影响可见性 |
| **turn / step / round** | turn=一次输入排空（0+ step）；step=一次模型请求+其工具执行；round=外层策略迭代（goal round / Ralph attempt） |
| **goal** | 同会话持久目标：revisioned `active/paused/blocked/complete` phase + 轮次上限；激活（armed/disarmed）进程本地 |
| **human command** | `/` 前缀指令，经 `ctx.commands` 直接执行，不成为模型消息 |
| **Ralph loop** | 前台 fresh-agent 工作流循环：每轮全新子会话、不可变目标、有界结构化 handoff |
| **bundle / profile / patch** | bundle=配置行+代码的分发包；profile=命名组合；patch=按 id 整行替换/插入/禁用的操作列表 |
| **Capability seam 三件套** | Service Definition / Service Provider / Consumer——一个 seam 完整包含三角色 |

## 19. 参考资料索引

**官方文档（仓库内）**：
- `docs/architecture.md`（架构总纲，必读）· `docs/agent-lifecycle.md`（turn/step 时序图）· `docs/capability-seams.md`（全部 ctx 服务图）· `docs/tool-execution-pipeline.md`（工具管线图）· `docs/event-producer-consumer.md`（事件矩阵）· `docs/api-gateway.md`（Typert RPC 权威文档）· `docs/cordis-primer.md` + `docs/cordis-tutorial/`（Cordis 入门）· `docs/config-catalog.md`（全部配置字段）· `docs/tool-catalog.md`（全部模型工具）· `docs/module-graph.md`（包依赖图）· `docs/subsystems/`（每个子系统的类型+事件参考）· `docs/cookbook/`（adding-a-tool / adding-an-llm-adapter / adding-a-package / adding-a-conversation-node / adding-a-settings-card / extension-cookbook）· `docs/development.md` / `docs/testing.md` / `docs/defensive-patterns.md` / `docs/glossary.md` · `docs/postmortem/`（事故复盘）
- `AGENTS.md`（开发者约定）· `packages/*/README.md`（每包自述）· `.agents/notes/`（架构决策记录）

**本分析的研究报告（`research/` 目录）**：A-core（spine 六包）、B-llm-persistence（LLM+持久化）、C1-rpc（Typert/SDK）、C2-web（Web 宿主/客户端）、D-execution（执行世界）、E-capabilities（能力层）、F-composition（组合/交互/扩展）——含精确的 文件:行号 引用与代码摘录，可与本文档互相补充。

**外部资源**：Cordis（github.com/cordiverse/cordis，论文 *A Programming Paradigm for Spatiotemporal Composability*）· Agent Client Protocol（agentclientprotocol.com）· Claude Code hooks（docs.anthropic.com）· DeepSeek API（platform.deepseek.com）

---

*本文档由 DeepSeek Harness 自身的编码智能体（基于本仓库 checkout）分析生成：7 个并行研究子智能体 + 主智能体综合，引用源码约 60 个包、官方文档 30+ 篇。文档版本 1.0，对应仓库 `@deepseek-ai/dsh-root@0.1.0-rc.7`。*
