# DeepSeek Harness 二开方法分析
## 1. 二次开发指南

> 官方 cookbook（`docs/cookbook/`）是权威操作手册。本节给出按扩展点分类的路径图。

### 1.1 先决心智模型

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

### 1.2 新增一个工具（最小路径）

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

### 1.3 新增一个 LLM provider

四步（cookbook + `llm-deepseek` 参考布局）：① 继承 `LlmAdapter` 实现 `stream()`（唯一必选；遵守 StreamChunk 协议纪律：usage 在 finish 前、finish 后无 chunk、arguments 全程 raw JSON、错误两条路）；② Cordis 插件声明 `inject: ['llm']` + schemastery `Config`；③ `apply` 里 `ctx.llm.registerAdapter(['my-provider'], adapter)`；④ 可选面：`providerRetryPolicy`/`listModels`/`resolveModel`/`registerConfigurableProviders`/`registerModelDiscovery`。线协议与 chunk 翻译拆独立模块（serialize/sse/translate/adapter 四层）。

### 1.4 新增一个 capability seam（完整三件套）

按 `docs/cookbook/extension-cookbook.md`：Service Definition 包（抽象 `Service` + `ctx.<key>` 声明合并 + 类型词汇 + 契约 JSDoc）→ Provider 包（实现并注册同名服务；可多个并存/替换）→ Consumer 包（`tool-*` 或 `command-*` 把能力变成模型/人类可调用表面）。契约测试共享（如 `runPersistenceContract`）让"换 provider = 换包 + 跑同一套测试"。

### 1.5 新增 UI 插件（浏览器面）

1. 包内 `src/client/index.ts`（浏览器面）+ `src/index.ts`（Node 面，常为空壳或 host 半）；
2. `package.json`：`"dsh": { "client": { "platform": "web", "inject": [...] } }` + `exports["./client"]`；
3. `apply(ctx)`：`ctx.slots.register({name, children?}, Component)` 或 `ctx.slots.inject(parentSlot, ...)`（参考 `ui-goal`：inject 依赖 → slots.inject 注册 keyed 单元 → 业务面读投影 + `ctx.remote.<域>` 调 host RPC）；
4. 在 web-app bundle 或你的 profile patch 里加一行 `- id: my-ui ... name: '@scope/dsh-my-ui'`；
5. 构建后 `pnpm run dev:web` 热更新（或重建 + 刷新）。

### 1.6 新增一个 bundle / profile / 平台适配

- **bundle**：包内 `cordis.patch.yml`（insert 或按 id 覆盖）+ `package.json` 的 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`；patch 整行替换 config，模式差异的值必须由各模式 bundle 自己重申。
- **profile**：`$DSH_HOME/profiles/<name>/`（manifest 列 bundle + 用户 patch）；`dsh --profile <name>` 启动；`--dump-config` 离线验证组合。
- **平台适配**：base 已示范（bash/pwsh 双胞胎 + `!!js process.platform` 门控）；注意"禁用一族必须启用另一族"的完整性配方。



## 2. 术语表及含义

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


## 3. 代码阅读顺序

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