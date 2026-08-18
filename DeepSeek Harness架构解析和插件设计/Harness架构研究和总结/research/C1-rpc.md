# C1 研究报告：DeepSeek Harness 的 RPC/API 层（Typert + SDK + API Gateway）

> 仓库根目录：`E:\WorkSpace\LLM_Projects\deepseek-harness`。本文所有引用均为仓库内相对路径（`packages/...` 形式），行号以源码为准。
> 范围：`packages/typert/*`、`packages/api/gateway`、`packages/api/remotes`、`packages/sdk/*`、`packages/util/brand`、`packages/util/native-command`，以及官方文档 `docs/api-gateway.md`、`docs/subsystems/typert.md`（`docs/subsystems/api-gateway` 不存在，唯一权威文档是 `docs/api-gateway.md`）。

---

## 1. 总体架构与分层

DSH 的远程调用栈分为两套**正交**的通道：

1. **Typert / API Gateway（进程内 Host ↔ Browser/Client）**：以 Cordis 服务为接收方、以"类型图生成"为核心的 unary RPC。Host 侧业务服务用装饰器声明 Remote 方法，构建期由 Typert 生成器产出描述符与类型，运行期由 `ctx.typertGateway` 通过 Connection RPC carrier 的 `/api` 通道分发。
2. **SDK（进程外程序 ↔ Host 运行时）**：以 `dsh-jsonrpc-agent` 独立子进程为载体、基于 stdio 的新行分隔 JSON-RPC 2.0。`packages/sdk/protocol` 定义线协议，`packages/sdk/server` 是服务插件，`packages/sdk/client` 是 TS 客户端。

分层关系（`docs/api-gateway.md:158-162`）：

```
remotes(api/remotes) → gateway(api/gateway) → connection(client/connection) → webserver(host/webserver)
```

| 维度 | Typert / API Gateway | SDK（JSON-RPC） |
|---|---|---|
| 用途 | Host ↔ 浏览器/Client 的强类型 unary 调用 | 进程外程序驱动独立 runtime 子进程 |
| 传输 | Connection carrier（HTTP 桥 `POST /api/<ns>/<method>` / websocket 下行） | stdio 上的新行分隔 JSON-RPC 2.0 |
| 身份 | `ctx.remote.<namespace>`（Client）/ `ctx.typertGateway`（Host） | `DeepSeekHarness` / `HarnessClient`（TS）、Python SDK |
| 契约来源 | 构建期类型图生成（Typert） | 手写线协议类型（`sdk/protocol`） |
| 验证 | zod schema 双侧边界验证 + 描述符精确匹配 | 客户端形状校验（`SdkProtocolError`）+ 错误码规范化 |

- `@deepseek-ai/dsh-typert-protocol`：仅类型与装饰器，无任何运行时注册（`packages/typert/protocol/src/index.ts:1-4`）。
- `@deepseek-ai/dsh-typert-generator`：构建期分析 + 产物生成，运行时不参与。
- `@deepseek-ai/dsh-typert-registry`：运行期注册表 `ctx.typert`。
- `@deepseek-ai/dsh-typert-loader`：把已挂载插件包的 `./typert` 产物自动注册进 `ctx.typert`。
- `@deepseek-ai/dsh-api-gateway`：Host 分发器 `ctx.typertGateway` + Client 投影 `ctx.remote`。
- `@deepseek-ai/dsh-api-remotes`：应用级 BFF，负责 Agent/Session Identity 策略与转发事件白名单。

---

## 2. Typert 是什么、解决什么问题

Typert（"type + export/remote"）是一个**"类型即契约"的代码生成系统**：开发者只在 Host 侧用 TS 类型 + 装饰器声明一次业务 API，构建期自动为 Host 侧生成运行时反射/校验描述符、为 Client 侧生成强类型调用面，使跨进程（Host ↔ 浏览器）调用获得端到端类型安全，且验证（schema 校验）在边界两侧都发生。

### 2.1 类型图生成器工作流（输入 → 输出）

流水线位于 `packages/typert/generator/src/`，分四步：

1. **Analyzer**（`analyzer.ts`，3113 行）：以 `ts.Program`（种子为 `tsconfig.host.json` / `tsconfig.client.json`）为输入，把 TS 的 AST/Symbol/Checker 抽象为**编译器无关模型** `FaceModel` + `TypeGraph`（`model.ts:177-187, 430-433`）。模型保留：包导出、Cordis 服务/事件、`@typert` 标记的对象与 schema、调用描述符 `InvocationModel`（`model.ts:128-152`）、类型声明图 `TypeNodeModel`（`model.ts:350-388`，覆盖 keyword/literal/reference/union/array/tuple/object/mapped/template-literal 等）。
2. **Renderer**（`renderer.ts`）：`TypeGraphRenderer` 只读模型，把类型节点渲染回 TS 源码文本（供 `.d.ts` 输出），emitter 不再触碰 TS AST（`renderer.ts:1-5`）。它同时维护节点/声明/成员索引与类型参数作用域（`renderer.ts:26-46`），供 emitter 的 `renderType/renderDeclaration/renderSignature` 使用。
3. **Emitter**（`emitter.ts`）：`FaceModelEmitter.emit()` 按包产出 JS + d.ts；Host face 且含 Remote 方法时额外产出 `remote` 产物（`emitter.ts:104-128`）。`SchemaEmitter` 把公开类型与调用边界投影为 **zod v4** schema（`emitter.ts:512-568`；`typeSchema` 开关 `emitter.ts:600-642`；keyword 映射 `emitter.ts:783-798`：`any→z.any()`、`Date→z.date()`、递归引用→`z.lazy` 等）。递归类型用 `z.lazy(() => name)` 延迟求值（`emitter.ts:655-658`），继承用 `z.intersection`（`emitter.ts:593-597`），`symbol` 成员从 JSON 形状中擦除（`emitter.ts:739-742`）。
4. **Workspace 生成器 + tsdown 插件**：`WorkspaceTypertGenerator.generate()` 批量执行发现→分析→发射（`workspace.ts:46-66`），并校验 package.json 的 `exports`/`files` 是否符合约定（`workspace.ts:68-126`）。`typertPlugin`（`tsdown-plugin.ts:38-101`）挂在 tsdown（rolldown）上：`transform` 阶段先对带装饰器的 TS 依赖做 `ts.transpileModule` 降级（`tsdown-plugin.ts:43-59`），`writeBundle` 阶段把产物写入包 `lib/`（`emitArtifacts`，`tsdown-plugin.ts:103-124`）。

**包发现规则**（`generator/README.md:7`）：`package.json#exports` 是跨包公共边界；只有显式导出（含 `./typert`、`./client/typert`、`./remote`）或 Cordis `Context`/`Events` 增强可达的包才成为贡献者（`analyzer.ts:510, 726, 1776`；`tsdown-plugin.ts:133-138`）。跨 face 的引用（Host 包 import Client 包的类型）被建模为 `CrossFaceLink`（`model.ts:167-174`），类型归属 NPM 依赖（含 `@types`）时保持 `external` 引用而不展开。

**分析模式**：`WorkspaceAnalyzerOptions.mode` 为 `'check'`（默认，任何 TS 诊断/缺注解/私有跨包引用都失败）或 `'write'`（自动插入 checker 推导的注解后重建 program 再干净分析；`analyzer.ts:55-58`）。`WorkspaceCaches` 可在多次分析间复用解析（`analyzer.ts:76-78`）。

### 2.2 产物形态（目录与格式）

每个参与包的 `lib/` 目录产出（`docs/api-gateway.md:103-113`）：

| 文件 | 消费方 | 内容 |
|---|---|---|
| `lib/typert.host.js` / `.d.ts` | Host Loader | `TYPERT` 清单：package/face/schemas/invocations/model（`emitter.ts:186-216`） |
| `lib/typert.client.js` / `.d.ts` | Client 端 | Client face 的同类清单（本项目当前主要用 host face） |
| `lib/typert.remote-client.js` | `api-remotes` | `TYPERT_REMOTE`：`{ package, descriptors: InvocationDescriptor[] }`（`emitter.ts:245-272`） |
| `lib/typert.remote-client.d.ts`(+`.map`) | Client 类型系统/编辑器 | 对 `@deepseek-ai/dsh-typert-protocol` 的 declaration merge + 源码映射（`emitter.ts:331-396`） |

package.json 约定（`workspace.ts:74-126`，被 `WorkspaceTypertGenerator.validateExport` 强制校验）：
- host face：`"./typert"` → `lib/typert.host.{js,d.ts}`；
- client face：`"./client/typert"` → `lib/typert.client.{js,d.ts}`；
- 有 Remote 方法的 host 包：`"./remote"` → `lib/typert.remote-client.{js,d.ts}`（`.d.ts.map` 不发布，仅编辑器导航）。

真实产物示例（`packages/interaction/commands/lib/typert.remote-client.js`，由 `@Remote` 方法 `list`/`execute` 生成）：

```js
export const TYPERT_REMOTE = {
  package: '@deepseek-ai/dsh-commands',
  descriptors: [
    {
      id: '@deepseek-ai/dsh-commands#commands/execute',
      service: 'commands',
      namespace: 'commands',
      method: 'execute',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
          codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
                   schema: /* zod 实例 */ } },
        { name: 'line', wire: 'line', source: 'json',
          codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-commands#commands/execute:line',
                   schema: z.string() } },
      ],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-commands#commands/execute:result',
                schema: /* zod 实例 */ },
      sourceLocation: { file: 'packages/interaction/commands/src/index.ts', line: 297, column: 9 },
    },
    // ... list
  ],
}
```

对应的 `typert.host.js` 头部（`lib/typert.host.js`）展示了边界 zod schema 的实际生成形态——`execute` 的 `agent` 参数（`SessionId`）投影为 `z.intersection(z.string(), z.unknown())`（branded string 的宽松投影），`line` 投影为 `z.string()`，返回值投影为 `z.union([z.undefined(), z.object({...})])`（`CommandExecution | undefined` 的显式 undefined 分支）；`TYPERT.invocations` 数组里的描述符与 `TYPERT_REMOTE.descriptors` 结构一致（同一 `invocationLiteral` 发射器，`emitter.ts:274-329`）。

`typert.remote-client.d.ts` 通过对 `@deepseek-ai/dsh-typert-protocol` 的模块增强，把方法签名注入 `TypertRemoteMap`（flat 端点）、`TypertRemoteNamespaceMap`（`ctx.remote.<namespace>`）与 `TypertRemoteScopeMap`（scoped 面），参数名用 wire 字段（`agentId`）、类型引用业务包的 Client-safe 导出（`CommandExecution` 等）：

```ts
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$636f6d6d616e6473 {
    execute: (agentId: SessionId, line: string, signal?: AbortSignal) => Promise<RemoteResult<CommandExecution | undefined>>
    list: (agentId: SessionId) => Promise<RemoteResult<readonly CommandDescriptor[]>>
  }
  interface TypertRemoteMap {
    'commands/execute': (agentId: SessionId, line: string, signal?: AbortSignal) => Promise<RemoteResult<CommandExecution | undefined>>
    'commands/list': (agentId: SessionId) => Promise<RemoteResult<readonly CommandDescriptor[]>>
  }
  interface TypertRemoteNamespaceMap {
    'commands': TypertRemoteNamespace$636f6d6d616e6473
  }
  interface TypertRemoteScopeMap {
    'agent:commands/execute': (line: string, signal?: AbortSignal) => Promise<RemoteResult<CommandExecution | undefined>>
    'agent:commands/list': () => Promise<RemoteResult<readonly CommandDescriptor[]>>
  }
}
```

**关键设计**：`InvocationDescriptor` 不是线上消息，而是"本地反射"（`docs/subsystems/typert.md:41`）；线上只传端点 `<namespace>/<method>` + 命名 `args`。生成器对 Remote 方法有严格约束（`analyzer.ts:982-1007`）：public、非 static、非泛型、参数必须是简单标识符、禁止 rest/默认值/解构，可选取消参数必须是末位的全局 `AbortSignal`。`InvocationModel.id` 的形态是 `<package>#<namespace>/<method>`（`analyzer.ts:1111`），作为跨 Host/Client 的稳定全局身份。

**Host 侧 `typert.host.js` 与 Client 侧 `typert.client.js` 的区别**：两者都导出 `TYPERT` 清单（`{ package, face, schemas, invocations, model }`），Host 版由 Loader 注册进 `ctx.typert`（含 `invocations` 供网关分发）；Client 版供 Client 端注册表使用。清单里的 `model` 是反射元数据（服务/事件/对象成员签名），`schemas` 是 `{ name, schema }` 对（`emitter.ts:199-215`）。生成 d.ts 时把 `TYPERT` 声明为 `unknown`（`emitter.ts:241`），使业务包不依赖运行时注册表类型。

**生成器的已知边界**（`generator/README.md:35-40`）：包导出模式（`./src/*` 通配）跳过；跨 face 的 namespace 再导出暂不支持（`TypeTargetModel` 无法无损表示模块命名空间）；zod 发射器只支持 TS 图的可投影子集——泛型 schema 声明、条件/映射类型根会在生成期失败而不是静默弱化；发现只沿公共导出可达的源码。这些限制把"不可投影"从运行期错误提前到了构建期错误。

### 2.3 代码摘录 A：描述符与 codec 的类型契约

`packages/typert/protocol/src/types.ts:139-163`：

```ts
/** Codec attached to one invocation parameter or result. */
export type TypertCodec =
  | {
    readonly mode: 'strict'
    readonly typeSymbol: string
    readonly schema: TypertSchema
  }
  | {
    readonly mode: 'src-json'
  }

/** One ordered business parameter in a Remote invocation. */
export interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string
  /** Required key in the wire `args` object. */
  readonly wire: string
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup'
  /** Lookup key when `source` is `lookup`. */
  readonly lookup?: string
  /** Boundary codec for the wire representation. */
  readonly codec: TypertCodec
  /** Missing wire fields decode to `undefined` only for an explicitly declared `T | undefined`. */
  readonly acceptsUndefined?: true
}
```

`TypertCodec` 的两种模式贯穿全局：`strict`（生成器产物，携带 zod schema + 规范类型符号）与 `src-json`（SRC 开发回退，只保证 JSON 安全）。完整的 `InvocationDescriptor`（id/service/namespace/method/implementation/invocation/scope/parameters/cancellation/result/sourceLocation）见 `types.ts:172-211`；全局端点键是 `<namespace>/<method>`，由 `typertEndpoint()` 计算（`registry/src/service.ts:67-69`）。

---

## 3. `ctx.typert` 运行时注册表

### 3.1 结构

`TypertRegistry` 是一个 Cordis `Service`，注册键 `'typert'`（`registry/src/service.ts:446-464`），在 `@deepseek-ai/cordis` 的 `Context` 上以 `ctx.typert: TypertRegistryContract` 暴露（`protocol/src/types.ts:487-491`）。契约含四个子注册表（`protocol/src/types.ts:480-485`）：

- **`local`**（`TypertLocalRegistry`，`types.ts:332-353`）：当前环境（Host）的调用描述符，按端点 `get/list/subscribe`，`hasSeen` 记录"曾注册过"（用于禁止热卸载后降级为 SRC）。实现 `DescriptorStore`（`service.ts:107-180`）：注册/撤回都是 Cordis effect 生命周期，重复端点/重复 id 整体拒绝（`validate`，`service.ts:120-135`）。观察者订阅经 `ChangeSource`（`service.ts:83-105`）：`ctx.effect` 注册、逐个隔离（某观察者抛错只记 `logger.warn` 不影响其他观察者）。
- **`remotes`**（`TypertRemoteRegistry`，`types.ts:356-377`）：Client 显式选中的 Remote contribution 注册表，`register(contribution)` 按包去重并原子提交（`RemoteStore`，`service.ts:182-214`）。
- **`lookups`**（`TypertLookupRegistry`，`types.ts:380-424`）：Host 对象↔wire 身份解析。`register(key, provider)` 登记"稳定 wire 声明 + 默认解析器"（`LookupStore.register`，`service.ts:290-322`）；`configure(key, resolver)` 让组合方以 effect 作用域覆盖默认策略（`service.ts:263-288`）。`get()` 合并两者（配置存在时用配置的 resolver，`service.ts:249-261`）。
- **`contexts`**（`TypertContextRegistry`，`types.ts:427-477`）：scoped Context 解析。`registerHost/configureHost` 提供"wire 身份 → scoped Context"，`registerClient` 提供"调用方 Context → wire 身份"（Client binder）（`ContextStore`，`service.ts:336-435`）。

另外 `TypertRegistry` 本身还提供 schema 仓库：`register(contribution)`（`service.ts:499-520`）原子注册包 face、schema（键 `<package>#<name>`，`typertKey`，`service.ts:48-50`）与 local 描述符；`get/resolve/list/toJSONSchema`（`service.ts:527-589`）供其他系统（如工具目录）投影 JSON Schema。`resolve` 失败时区分三种原因并给出不同错误消息（键格式错 / 包已注册但无此 schema / 包未注册，`service.ts:537-551`）。`list(filter)` 支持按 `package`/`face` 过滤，按注册顺序返回（`service.ts:558-560`）。

**local 与 remotes 的区别**：`local` 是"当前环境自己的描述符"（Host 由 Loader 自动注册、卸载即撤回），网关用 `local.get/hasSeen` 决定认领；`remotes` 是"消费者显式选中的远端贡献"（Client 由 `$mount` 注册），二者都使用 `DescriptorStore` 的端点/id 唯一性校验，但存储实例相互独立（`service.ts:460-461`）。

### 3.2 注册 API（Loader 自动接线）

`packages/typert/loader/src/index.ts` 是一个 `inject: ['typert', 'loader']` 的插件（`loader/src/index.ts:44`）：监听 Loader 的 `internal/plugin` 生命周期，为每个挂载的插件包解析 `package.json`，若导出 `./typert` 就动态 import 其 `TYPERT` 清单、用 `validateTypertManifest`（`loader/src/index.ts:83-142`，逐字段校验、zod v4 探测 `'_zod' in schema`）收紧后 `ctx.typert.register(manifest)`，插件卸载时撤回（`loader/src/index.ts:368-390`）。嵌套插件的包用配置 `packages` 显式声明。手动 `ctx.typert.register()` 仍可用于手写 wire schema 的场景。

**描述符的运行时形状校验**（`registry/src/service.ts:638-695` `validateInvocation`）：id 非空、service/namespace/method 必须匹配 RPC 端点段字符集（`^[A-Za-z0-9_$.-]+$` 且非 `.`/`..`，`validateWireName`，`service.ts:705-709`）、`lookup` 参数必须带 key 且不得声明 `acceptsUndefined`、`scope` 必须选择唯一的 lookup 参数且与 Context 键一致、context 接收者的 wire 字段不得与参数冲突、codec 必须有 `parse()`（`validateCodec`，`service.ts:697-703`）。这一层保证即使手写描述符也满足网关的全部假设。

### 3.3 代码摘录 B：注册是 effect 作用域的生命周期

`packages/typert/registry/src/service.ts:499-520`：

```ts
register(contribution: TypertContribution): TypertDisposer {
  const packageRecord = this.validatePackage(contribution)
  const schemaRecords = this.validateSchemas(contribution)
  const invocations = contribution.invocations
  this.localStore.validate(invocations)
  const owner = {}
  const { schemas, packages, localStore } = this
  return this.ctx.effect(function* () {
    packages.set(packageRecord.key, packageRecord)
    for (const record of schemaRecords) schemas.set(record.key, record)
    localStore.commit(owner, invocations)
    yield () => {
      /* ... 卸载：删除包记录、schema 记录、撤回描述符 */
      localStore.withdraw(owner, invocations)
    }
  }, 'typert.register()')
}
```

### 3.4 Identity 解析（lookups / contexts 的运行时提供）

业务包在**类型层**通过 declaration merging 声明"Host 对象 ↔ wire 身份"：

- `TypertLookupMap {}`：如 `Agent ↔ SessionId`（`protocol/src/types.ts:33-34`）。
- `TypertContextMap {}`：如 scoped `agent` Context ↔ `SessionId`（`protocol/src/types.ts:36-37`）。

**运行层**由拥有该身份的包注册 provider。DSH 的标准实现是 `packages/api/remotes/src/agent-lookup.ts:199-208`：

```ts
ctx.inject(['typert'], (typeCtx) => {
  const resolveAgent = async (sessionId: SessionId): Promise<Agent> => {
    const found = await agentFor(sessionId)
    if ('error' in found) throw new TypertLookupFailure(found.error)
    return found.agent
  }
  typeCtx.typert.lookups.configure('agent', resolveAgent)
  typeCtx.typert.lookups.configure('session', async sessionId => (await resolveAgent(sessionId)).session)
  typeCtx.typert.contexts.configureHost('agent', async sessionId => (await resolveAgent(sessionId)).ctx)
})
```

策略（`createApiRemoteAgentResolver`，`agent-lookup.ts:121-211`）：复用活的 Agent → 冷 session 自动 resume（按 id 去重并发、`inspectApiRemoteSession` 预检持久化）→ subagent 拥有的身份走既有 `agent-busy` 围栏（`hasApiRemoteSubagentOwner`，`agent-lookup.ts:62-72`）。拒绝以 `TypertLookupFailure`（`protocol/src/index.ts:25-38`）携带适配器自有错误，网关适配层原样透传而不折叠成 `internal`（`api/gateway/src/index.ts:478-480`）。

### 3.5 运行期安装

`TypertRegistry` 是带 `@typert service typert` 标记的 Cordis 服务（`service.ts:441-446`），Host 面由业务包/组合显式 `new TypertRegistry(ctx)` 安装，Client 面用同一个实现（`registry/src/client/index.ts:13-15`：`apply(ctx){ new TypertRegistry(ctx) }`，`inject: []`）。网关 `TypertGatewayService` 声明 `static inject = ['typert']` 并在构造里注入 `connection`（`index.ts:91, 104`）——即网关必须在注册表与 Connection 都已就绪后才能完成 `/api` interceptor 注册。`api-remotes` 的 Host BFF 在 `ctx.inject(['typert'])` 内配置 agent/session lookups，保证 provider 先于任何 Remote 调用存在（`agent-lookup.ts:199-208`）。

---

## 4. api-gateway：`ctx.typertGateway` 把 Remote 调用路由到活服务

### 4.1 与 Connection RPC carrier 的关系

`TypertGatewayService`（Cordis `Service`，键 `'typertGateway'`，`inject: ['typert']`）**不是**自己的传输层：它把自己的 Host 分发器注册为 Connection `/api` 通道上的 interceptor（`api/gateway/src/index.ts:99-120`）：

```ts
constructor(ctx: Context) {
  super(ctx, 'typertGateway')
  ctx.on('internal/service', () => {
    this.srcClaims = undefined
  })
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.intercept(
      '/api',
      endpoint => this.claimsEndpoint(endpoint),
      (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal),
      { authority: 'trusted-host' },
    )
  })
}
```

- **Connection 负责**：传输、RPC id、响应信封、信任边界、取消、`POST /api/<namespace>/<method>` HTTP 桥（`docs/api-gateway.md:121-123`）。carrier 接口见 `packages/client/connection/src/rpc.ts:47-52`（Host `intercept`）与 `:71-77`（Client `call`）。
- **Gateway 只负责**：Remote 数据协议与业务分发（`docs/api-gateway.md:123`）。
- `claimsEndpoint`（`index.ts:114-120`）：只有严格描述符存在过（`local.get` / `local.hasSeen`）或存在活动 SRC marker 的两段式端点才被认领；未认领的 `/api` 请求落到既有 API Proxy（`packages/host/apiproxy`）。

### 4.2 unary 调用流程（`invoke`，`index.ts:145-184`）

1. 拼 `<namespace>/<method>`，解析描述符：先严格（`local.get`），若"曾注册但已撤回"则**拒绝降级**（`definition-unavailable`，`index.ts:224-235`），否则走 SRC 派生（`resolveSrcDescriptor`，`index.ts:237-357`，从 `ctx.reflect.props` 找 `typertRemote` 绑定 + `remoteMethods()` 装饰器 marker，用 `Function.prototype.toString` 解析参数名，`index.ts:542-576`）。
2. `assertExactArguments`（`index.ts:586-612`）：`args` 字段必须与描述符**精确匹配**（缺失/多余都失败；仅显式 `T | undefined` 或 SRC 的 json 字段可缺省）。
3. 解析接收方：direct → root ctx；context → 用 `ctx.typert.contexts.getHost()` 把 wire 身份解析为 scoped Context（`resolveReceiverContext`，`index.ts:359-405`）。
4. `ctx.get(descriptor.service)` 取活服务，`validateBinding`（`index.ts:495-514`）核对实例上的 `typertRemote` 绑定与 serviceKey/namespace 一致（防止同名服务顶替）。
5. 逐参数解析：`resolveParameter`（`index.ts:407-468`）——`json` 参数用 codec decode；`lookup` 参数经 `ctx.typert.lookups.get(key)` 解析为 Host 对象，并核对 `provider.wire`/`wireTypeSymbol` 与严格描述符一致（`provider-mismatch`）。
6. 取消：`signal` 不进入 `args`，由 carrier 传入（`index.ts:161`）。
7. `Reflect.apply(method, receiver, args)` 执行业务方法；业务异常原样上抛（若 signal 已中止则包成 `RemoteInvocationCancelled`，`index.ts:172-178`）。
8. 结果用 `result` codec decode（`decode`，`index.ts:614-638`），再经 `assertJsonValue`（`index.ts:640-673`）做 JSON 安全校验（有限数字、无环、无 symbol、plain object）。

一次 `ctx.remote.commands.execute(...)` 的完整时序（文字版）：

```
Client ctx.remote.commands.execute(agentId, line, signal)
  └─ RemoteNamespaceService 上的 getter 方法（client/index.ts:475-487）
     └─ invoke(): 组装 args（scope 身份 + 业务字段，client/index.ts:376-398）
        └─ connection.rpc.call('/api', 'commands/execute', { args }, signal)   ← client/index.ts:406
           └─ [Connection] HTTP 桥 POST /api/commands/execute（docs/api-gateway.md:121）
              └─ [Host] 信任检查 → interceptor 序 → gateway.claimsEndpoint?（index.ts:104-120）
                 └─ dispatchRpc → invoke()（index.ts:145-184）
                    ├─ resolveDescriptor: local.get（严格）或 SRC 派生
                    ├─ assertExactArguments → resolveReceiverContext → ctx.get('commands')
                    ├─ validateBinding → resolveParameter（lookup: agentId→Agent）
                    ├─ Reflect.apply(execute, receiver, [agent, line, signal])
                    └─ decode(result) → { ok: true, value }（或 rpcFailure 错误信封）
```

RPC 适配层 `invokeRpc`（`index.ts:194-222`）把成功值装进 `{ ok: true, value }`，把失败映射为 Connection 的错误信封（`rpcFailure`，`index.ts:471-489`）：`cancelled`、`TypertLookupFailure` 原样透传、其余 `internal`。错误码全集 `TypertGatewayErrorCode` 共 17 种（`types.ts:19-37`），可按语义分组：

- **装配类**（调用前）：`arguments-invalid`、`signature-invalid`、`binding-invalid`、`invocation-unavailable`、`ambiguous-endpoint`、`definition-unavailable`、`method-unavailable`、`service-unavailable`；
- **Identity 类**（解析期）：`lookup-unavailable`、`lookup-not-found`、`lookup-failed`、`context-unavailable`、`context-not-found`、`context-failed`、`provider-mismatch`；
- **边界类**（验证期）：`input-invalid`、`result-invalid`。

错误消息**不携带边界值**（构造函数 `index.ts:53-58`：消息只给纠正导向的诊断，敏感值留在 `cause`），避免把 untrusted 输入回显进日志。

**"bind/unbind" 的准确含义**：网关不做服务的动态 bind/unbind——服务绑定是**静态声明**（`TypertRemoteService` 基类或 `bindTypertRemote` 字段），网关每次调用都在 `ctx.get(serviceKey)` 取**活实例**并用 `validateBinding`（`index.ts:495-514`）核对绑定一致性（不缓存业务对象，`docs/api-gateway.md:125`）。描述符的"挂载/卸载"才是动态的：Host 侧由 Loader/插件 effect 决定，Client 侧由 `$mount`/disposer 决定；卸载会 abort 在途调用并使过期方法句柄后续调用一律 reject（`client/index.ts:253-260`）。

### 4.3 Client 侧投影：`ctx.remote`

`api/gateway/src/client/index.ts` 提供 `remote` Service（`client/index.ts:88-96`）：

- **`$mount(contribution)`**（`client/index.ts:100-108`）：把 `TypertRemoteContribution` 的描述符逐个安装为**普通对象上的具体方法**（无 JS Proxy，`client/index.ts:1-5`）。每个 namespace 是一个 Cordis 子服务 `remote.<namespace>`（`RemoteNamespaceService`，`client/index.ts:425-505`，用 `Object.defineProperty` 生成 getter 方法），卸载时逆序撤销并 abort 在途调用（`client/index.ts:174-192, 238-260`）。
- **方法调用**（`invoke`，`client/index.ts:356-415`）：组装命名 `args`（scoped 投影先经 Client Context binder 注入身份，`client/index.ts:376-391`），然后

```ts
const result = await connection.rpc.call('/api', endpoint, { args }, signal)
```

- 结果解析为 `RemoteResult<T>`：`{ ok: true, value }` 或 `{ ok: false, error }`（`client/index.ts:406-414`）；carrier 抛错（离线/中止）也并入 error 分支（`carrierFailure`，`client/index.ts:582-584`）。
- **`$on(event, listener)` / `$dispatch(event, args)`**（`client/index.ts:110-156`）：转发 Host 事件的一对订阅/投递原语。
- 生成器在 `remote-client.d.ts` 里把这些方法签名 merge 进 `TypertClientRemote`（`protocol/src/types.ts:222-250`），于是 `ctx.remote.goals.create(...)` 是**类型精确**的调用。

### 4.4 SRC 开发回退

Host 以源码模式（`node --import tsx`）启动时不执行生成器插件，装饰器 initializer 仍把方法名/调用模式记进模块私有 `WeakMap`（`protocol/src/index.ts:126, 224-246`），`TypertRemoteService`/`bindTypertRemote` 提供显式绑定（`protocol/src/index.ts:135-161`）。网关据此构造弱描述符（全部 `src-json` codec），但 Client 端**拒绝**装载无 strict codec 的 SRC 描述符（`client/index.ts:549-564`）——Client 的类型与 codec 永远来自最新生成的 `typert.remote-client.*` 产物（`docs/api-gateway.md:131-137`）。

SRC 的端点认领集合 `srcClaims` 是**按需缓存**的：`collectSrcClaims`（`index.ts:122-137`）遍历 `ctx.reflect.props` 中所有服务、经 `symbols.original` 解包实例后读 `typertRemote` 绑定 + `remoteMethods()` marker，拼出 `<namespace>/<method>` 集合；`internal/service` 事件（新服务注册/卸载）会清空缓存强制重建（`index.ts:101-103`）。SRC 参数名解析对解构/默认值/rest/重复名一律判 `signature-invalid`（`index.ts:562-576`），`signal` 必须末位（`index.ts:272-283`），lookup 判定复用注册表保留的 `definitions()`（即使 provider 已卸载也能识别出 lookup 参数，`index.ts:288-298`）。

---

## 5. api/remotes：Host Remote 声明与 BFF 策略

### 5.1 声明机制（Host 侧）

业务服务在 Host 侧声明可被 browser 调用的 API，两种形式（`docs/api-gateway.md:15`）：

1. 继承 `TypertRemoteService`（`protocol/src/index.ts:147-161`）：构造时 `super(ctx, serviceKey)` 同时完成 Cordis 服务注册与 `typertRemote` 绑定（默认 namespace = serviceKey，可用 `{ namespace }` 覆盖）。
2. 已有其他基类时：`readonly typertRemote = bindTypertRemote(this, serviceKey, options?)`（`protocol/src/index.ts:135-144`）。

方法级装饰器（`protocol/src/index.ts:168-216`）：
- `@Remote` / `@Remote('exportName')`：direct 调用（接收方是 root ctx 上的服务实例）。
- `@RemoteScope(key, exportName?)`：context 调用（接收方是身份解析出的 scoped Context 上的服务实例）。

生成器严格消费这些声明（`analyzer.ts:1130-1259`）：`gatewayBinding` 校验 `TypertRemoteService` 基类 + 直连 `super(ctx, key)` 或 `bindTypertRemote(this, key)` 字面量；`remoteMarker` 解析装饰器。任何"有 `@Remote` 但没有绑定"都构建失败（`analyzer.ts:960-965`）。

真实例子（`packages/interaction/commands/src/index.ts:225-301`）：

```ts
export class CommandRuntime extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'commands') }

  @Remote
  list(agent: Agent): readonly CommandDescriptor[] { ... }

  @Remote
  async execute(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined> { ... }
}
```

文档中的 `GoalService` 展示了两种调用形态的对比（`docs/api-gateway.md:30-53`）：`@Remote('create') createForClient(agent, request, signal)`——导出名 `create` 别名到实现方法 `createForClient`（描述符记录 `implementation`），带取消参数；`@RemoteScope('agent', 'current') currentForClient()`——接收方是 `agent` Context 上的服务实例，不显式接收 `Agent` 参数。

`Agent` 参数不是 JSON 值：因为 `TypertLookupMap` 声明了 `agent` lookup，生成器把它投影为 wire 字段 `agentId`（`source: 'lookup'`，`analyzer.ts:1023-1042`）；又因 `TypertContextMap` 有同名 `agent` 且 wire 类型一致，生成器附加 `scope: { context: 'agent', wire: 'agentId' }`（`analyzer.ts:1086-1107`），Client 的 scoped 签名自动省略该身份参数（`agentCtx.remote.commands.list()`）。

### 5.2 事件转发（Host → Client 单向通知）

`packages/api/remotes/src/remote-events.ts:17-29` 定义应用级转发白名单（11 个事件：`commands/change`、`credentials/updated`、`settings/document-updated`、`cordis/request-run`、`llm/adapters-updated` 等）。`index.ts:33-41` 用 `satisfies readonly TypertForwardableEvent[]` 做**编译期形状闸门**：`TypertForwardableEvent`（`protocol/src/types.ts:73-77`）只允许"`ThisParameterType` 为 unknown（无 Scope 绑定）且返回 void（单向）"的事件；白名单中的名字同时是 Host 转发循环的选择与消费者 `$on` 的合法键集（`remote-events.ts:9-16`——"加一个事件就是加一个数组条目"）。`types.ts:17-19` 把白名单投影进 `TypertRemoteEventSelection`，从而允许 Client 侧 `ctx.remote.$on('commands/change', ...)` 拿到与 Host 一致的 `Events` 签名。转发是"原样转发"：不投影、不脱敏、不重命名，wire 名即 Host 事件名（`remote-events.ts:10-15`）；未被订阅的帧在 `$dispatch` 静默丢弃（`client/index.ts:135-156`）。

### 5.3 Client 装配（`api/remotes/src/client/index.ts`）

`apply()`（`client/index.ts:105-122`）把五个业务包的 `/remote` 产物（`commandsRemote`、`goalsRemote`、`dynamicRemote`、`pluginInventoryRemote`、`messageFeedbackRemote`）依次 `ctx.remote.$mount()`，逆序卸载；同时 re-export 各包的 Client-safe 类型与 Connection 类型（`client/index.ts:35-88`），使 Client 贡献代码只依赖这一个装配包。Host 侧 `apply()` 为空（`index.ts:43-44`）——Host BFF 只提供 lookup 策略，不装载任何 Client 贡献。

---

## 6. SDK：JSON-RPC over stdio

### 6.1 协议（`packages/sdk/protocol`）

**传输**：`JsonRpcLineTransport`（`transport.ts:62-269`）——新行分隔的 JSON-RPC 2.0 帧：`{id, method}` 是请求、`{id}` 是响应、`{method}` 是通知（`transport.ts:1-5`）；坏行忽略；请求 id 为 `req_<uuid>`（`transport.ts:122`）。

**帧分类**（`transport.ts:201-224`）：

```ts
private async handleLine(line: string): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    // Only JSON syntax errors reach this catch; malformed peer lines are ignored.
    return
  }
  if (!message || typeof message !== 'object') return
  const frame = message as Record<string, unknown>
  const id = frame.id
  const method = frame.method
  if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
    await this.handleIncomingRequest(id, method, objectParams(frame.params))
    return
  }
  if (typeof id === 'string' || typeof id === 'number') {
    this.handleIncomingResponse(id, frame)
    return
  }
  if (typeof method === 'string') {
    this.notificationHandler?.(method, objectParams(frame.params))
  }
}
```

**错误码**（`transport.ts:226-258`）：未知方法 → `-32601`；handler 抛错 → `-32603`；错误响应以 `JsonRpcResponseError`（保留 wire `code`/`data`，`transport.ts:18-28`）拒绝 pending `request()`。通知无 handler 直接丢弃。`params` 非对象（数组/标量）折叠为 `{}`（`transport.ts:272-274`）。

**线类型**（`types.ts`）：请求 `initialize`（`InitializeParams{cwd, provider, model, maxTokens?}` → `InitializeResult{serverInfo}`）、`session/prompt`（`sessionId + contentBlocks` → `{messageId}` 入队回执）、`shutdown`（→ `{}`）；通知 `session.event` / `session.status` / `subagent.started` / `subagent.finished`（`types.ts:92-105`）。`serverInfo.name` 恒为 `deepseek-harness-sdk-runtime`（`types.ts:28-31`）。

### 6.2 服务器（`packages/sdk/server`）

`index.ts` 是 `sdk-jsonrpc-server` 插件（`inject: ['agents']`，`server/src/index.ts:20-22`）：用 `process.stdin/stdout` 构造 transport，`HarnessSdkJsonRpcServer` 处理请求（`server/src/server.ts:190-201`）。`shutdown` 响应 flush 后 `disposeAndExit`：flush → 卸载 root fiber → `exit(0)`（`server/src/index.ts:66-83`）。stdout 只承载协议帧，部署不得配 stdout logger（`README.md:15-17`）。

`HarnessSdkJsonRpcServer`（`server/src/server.ts:53-104`）构造时订阅 `session/event`、`agent/status`、`session/created`、`subagent/end`（仅 `local` 子会话）并转发为通知。`initialize` 校验 maxTokens、记录 cwd/provider/model，必要时自动挂载 `dsh-llm-deepseek` 回退适配器（`server.ts:111-125`）。`prompt` 按 `sessionId` 惰性 `ctx.agents.create` 一个 agent+session（`server.ts:132-143, 218-235`）并 `followup` 入队。

**部署映射**：`successStatus(reason, options)`（`server.ts:43-46`）把停止原因映射为 SDK 结果：`completed → 'ok'`；`max-tokens` 仅在配置 `maxTokensAsSuccess: true` 时算 `'ok'`，否则 `'error'`。`shutdown` 是幂等的（`shutdownTask` 记忆化，`server.ts:62-63, 150-153`），先等所有在途 session 创建、卸载 agent handle 与订阅、再清理回退适配器 fiber（`performShutdown`，`server.ts:155-181`）。**协议缺口**（`server/README.md:43-48`）：无逐会话 close/取消方法、无逐 prompt 结果归属（`messageId` 只是收件回执）；stdout 纯净性靠部署约束。

### 6.3 TS 客户端（`packages/sdk/client`）

两层：

- **`HarnessClient`**（`client/src/client.ts:184-458`）：底层协议客户端，`spawn(command, args)` 启动 `dsh-jsonrpc-agent` 子进程（`client.ts:203-261`），`initialize/prompt/request`（`client.ts:268-333`，超时用 AbortSignal 使 transport 丢弃 pending 项），`subscribe(filter)/subscribeSessionTree(id)` 通知订阅（`client.ts:342-372`，子会话树由 `subagent.started` 血缘边构建）。`close()` 走"协议 shutdown → stdin EOF → SIGTERM → SIGKILL"梯子直到进程真正退出（`client.ts:380-401`），并保留 stderr 尾部（上限 400 行）用于诊断（`closedError`，`client.ts:451-457`）。
- **`DeepSeekHarness`**（`client/src/api.ts:22+`）：高层 `run()` API——`start()` 记忆化 `initialize` 握手（失败则收割并换新实例，`api.ts:62-80`），`run(input)` 从入队回执等到下一个 agent `idle`，产出 `RunResult{sessionId, finalResponse, events, notifications}`（`README.md:24-26`）。TS 端与 Python SDK 为"设计孪生"，共享同一运行时协议（`client.ts:1-13`）。

**请求-响应关联**：`JsonRpcLineTransport.request()` 生成 `req_<uuid>` id 存入 `pending` Map，收到对应 id 的响应帧时 resolve/reject 并解绑 abort 监听（`transport.ts:121-156, 240-254`）；传输关闭（input end/error）时 `failPending` 批量拒绝（`transport.ts:264-268`）。**超时语义**：`requestTimeoutMs` 用 AbortSignal 实现"放弃等待"——pending 项被丢弃、不残留状态，但服务端工作仍会跑完（`client.ts:312-326`；`README.md:31`）；没有线级取消方法，放弃一轮只能关掉整个 runtime（`protocol/README.md:38`）。

**通知订阅语义**：`NotificationSubscription` 是带队列 + waiter 的 AsyncIterable（`client.ts:95-173`）；`close()` 丢弃队列并拒绝等待者，runtime 死亡则保留已投递队列可继续 `tryNext()` 排空（`client.ts:128-141`）。`subscribeSessionTree` 的过滤在客户端进行（runtime 对所有 session 发通知），父子关系从 `subagent.started` 帧累积（`client.ts:408-430`）。

### 6.4 DSH_ 环境与 Web GUI 通道的关系

- SDK 运行时 bin `dsh-jsonrpc-agent` 通过 `DSH_CORDIS_CONFIG`（环境变量优先于 argv）指定外部 `cordis.yml`（`packages/examples/jsonrpc-demo/src/runner.ts:25-36`）；`HarnessClientOptions.env` 可整体替换子进程环境（`client/src/types.ts:23-45`）。`DSH_HOME`/`DSH_AGENTS_HOME` 等是运行时全局事实，`DSH_BUILD_FACE=host|client` 是 tsdown 构建面开关（`packages/client/tsdown.client.ts:100`）。
- **与 Web GUI 的关系是"正交的两条通道"**：Web GUI（浏览器）是 Client Cordis 上下文，通过 Connection carrier 的 HTTP 桥调 `/api/<ns>/<method>`，走 Typert 网关（第 4 节）；SDK 是进程外程序通过 stdio JSON-RPC 驱动一个独立 runtime 子进程。二者共享 Host 侧的业务服务与事件源，但协议、传输、身份完全不同（SDK 无 `ctx.remote`，其会话身份是客户端自己指定的 `sessionId` 字符串）。
- TS SDK 的仓库内消费者是 `subagent-dsh-sdk` 后端（`README.md:7`）——即"子代理通过 SDK 再驱动一个 harness 运行时"；它需要显式 `command`/`args` 启动规格，打包可执行文件的发现逻辑留给了 Python 分发（`client/README.md:7, 46`）。

---

## 7. 快速浏览：util/brand 与 util/native-command

- **`packages/util/brand`**：仅一个类型——`export type Branded<B extends string> = string & { readonly [BRAND]: B }`（`brand/src/index.ts:24-27`），利用 `unique symbol` 做编译期名义类型，运行时零成本。用于跨包边界 id（`SessionId`、`JobId`、`CallId`）防混淆（`brand/src/index.ts:12-19`）。这是 Typert wire 身份类型的基石（如 `SessionId` 作为 lookup wire 类型符号）；构造走各归属包的工厂（`brand/src/index.ts:8-10`），比较/序列化仍按普通字符串。
- **`packages/util/native-command`**：无 shell 的 `execFile` 运行器（`native-command/src/index.ts:25-44`），utf8 stdio 捕获、`AbortSignal` 传播、`windowsHide: true`；非零退出码以携带 `code/stdout/stderr` 的 Error 拒绝。供原生目录选择器/默认应用打开等 Host 原生集成使用；纯库、无 Cordis 依赖（`native-command/src/index.ts:1-7`）。

---

## 8. 设计哲学观察

### 8.1 类型即契约（type graph as contract）

- 单一事实源是 Host 侧的 TS 类型 + 装饰器。生成器把类型图（`TypeGraph`）投影为 zod schema（Host 校验输入/输出）与 TS 签名（Client 编译期检查），**两侧共享同一契约但各自独立编译**（`docs/api-gateway.md:93`）。
- `InvocationDescriptor` 是"本地反射"而非线上消息；线上只有端点 + 命名 args。类型在**双边界**验证：Client 发车前 `codec.schema.parse`（`client/index.ts:566-575`），Host 收包后 decode（`index.ts:614-638`），结果返回后再验证一次——错误被折叠进 `RemoteResult` 的 error 分支，消费者无需 try/catch 业务失败（`emitter.ts:470-473`）。
- 声明合并（`TypertLookupMap`/`TypertContextMap`/`TypertRemoteMap`/`TypertRemoteNamespaceMap`/`TypertRemoteScopeMap`/`TypertRemoteEventSelection`）是"可扩展契约面"：业务包贡献类型，生成器填充方法签名，装配包选择暴露面。

### 8.2 生成代码 vs 手写

- **绝对偏向生成**：`typert.*.js/d.ts` 头部一律 "Generated by … — do not edit."（`emitter.ts:192`）。生成器在 `write` 模式下甚至能回写缺失的注解（`analyzer.ts:58`，`AnalysisMode = 'check' | 'write'`）。
- 但生成物是**数据驱动**而非魔法：Client 方法用 `Object.defineProperty` 生成普通函数（无 Proxy），描述符是纯 JSON 数据（可校验、可序列化、可审计）。
- 手写只保留在三处：协议级类型（`dsh-typert-protocol`）、运行期注册/解析策略（registry/gateway/agent-lookup）、线协议（sdk-protocol）。所有跨包边界的"魔法"都被显式数据或显式注册取代。

### 8.3 Host/Client 双面构建（tsconfig.host.json / tsconfig.client.json）

- 根目录两个聚合 `tsconfig`：Host 面（含 `packages/api/gateway/src/index.ts` 等）与 Client 面（含 `packages/client/*`、`api/remotes/client` 等）**互不进入同一 `ts.Program`**（`tsconfig.host.json:1-8` 注释：两侧在同一键下 merge `Context`，一个 program 无法同时看见）。
- 构建顺序强制 `host → client`（`docs/api-gateway.md:97`）：Host tsdown 跑 Typert 生成器（`--env.DSH_BUILD_FACE host`）产出 `typert.remote-client.*`；Client tsdown 消费这些新产物但**不再启动 Typert**（`generator/README.md:21`）。`api/remotes` 是唯一拆分 TS 面的包（`api/remotes/tsconfig.host.json` / `tsconfig.client.json`）。
- 意义：Client 代码（含 Web GUI）在编译期看到的是"Host 声明过的 Remote 契约"的投影，天然不可能调用未导出的方法；Host 与 Client 的 `Context` 增强互不污染。

### 8.4 跨进程边界的验证位置

验证发生在**每一道边界**：
1. 生成期：analyzer 严格诊断（`analyzer.ts:982-1007` 等）+ emitter 拒绝不可投影类型（`emitter.ts:824-830`）+ `workspace.ts` 校验包导出约定。
2. 装载期：loader `validateTypertManifest` 逐字段校验（`loader/src/index.ts:83-142`）+ registry `validateInvocation` 校验描述符形状（`service.ts:638-695`）。
3. 调用期（Host）：`assertExactArguments`（精确参数）、codec decode、`assertJsonValue`（JSON 安全：有限数/无环/无 symbol/plain object）、binding 一致性、provider wire/typeSymbol 一致性（`index.ts:586-673`）。
4. 调用期（Client）：`requireStrictDescriptor` + `parse`（`client/index.ts:549-575`）。
5. 传输层（SDK）：`JsonRpcLineTransport` 坏帧忽略、错误码规范化；客户端 `SdkProtocolError` 校验响应形状（`client.ts:268-290`）。

### 8.5 信任边界与"权威"模型

- Connection 的 RPC 通道带显式权威声明：`ConnectionRpcAuthority = 'trusted-host' | 'loopback'`（`packages/client/connection/src/rpc.ts:6`）。Typert 网关以 `authority: 'trusted-host'` 注册（`index.ts:109`）——浏览器经本地 webserver（loopback）到达 Host 后，信任检查由 Connection 统一完成，网关不再重复鉴权（`docs/api-gateway.md:123`）。
- 网关错误消息不回显边界值（见 4.2），`TypertLookupFailure` 把适配器自有错误（`agent-busy`/`session-not-found`）原样透传，保持业务错误语义不丢失。
- SDK 通道的信任模型是"进程边界即信任边界"：客户端提供完整 `env` 替换接口，由调用方自行决定凭据策略（`README.md:34`）；runtime 由外部 `cordis.yml` 定义其能力范围。

---

## 9. 关键文件索引

| 关注点 | 文件 |
|---|---|
| 描述符/codec/注册表契约类型 | `packages/typert/protocol/src/types.ts:129-211, 322-491` |
| 装饰器与绑定（`@Remote`/`@RemoteScope`/`TypertRemoteService`） | `packages/typert/protocol/src/index.ts:126-280` |
| 类型图模型 | `packages/typert/generator/src/model.ts:128-187, 350-433` |
| 分析器（服务/调用/绑定发现） | `packages/typert/generator/src/analyzer.ts:974-1259` |
| 产物发射（TYPERT / TYPERT_REMOTE / zod schema） | `packages/typert/generator/src/emitter.ts:104-396, 512-831` |
| 构建插件与导出校验 | `packages/typert/generator/src/tsdown-plugin.ts:38-124`；`workspace.ts:46-126` |
| 运行期注册表 | `packages/typert/registry/src/service.ts:107-628` |
| 自动注册 | `packages/typert/loader/src/index.ts:83-437` |
| Host 网关（intercept/invoke/SRC） | `packages/api/gateway/src/index.ts:90-673` |
| Client Remote（`ctx.remote`/$mount/call） | `packages/api/gateway/src/client/index.ts:88-588` |
| Host Remote 声明 + Identity 策略 | `packages/api/remotes/src/agent-lookup.ts:121-211`；`remote-events.ts:17-29` |
| Connection RPC carrier | `packages/client/connection/src/rpc.ts:47-77` |
| SDK 线协议 | `packages/sdk/protocol/src/transport.ts:62-279`；`types.ts:16-105` |
| SDK 服务器 | `packages/sdk/server/src/index.ts:46-92`；`server.ts:53-240` |
| SDK TS 客户端 | `packages/sdk/client/src/client.ts:184-458`；`api.ts:22-246` |
| 文档 | `docs/api-gateway.md`；`docs/subsystems/typert.md` |

---

## 10. 结论

- DSH 的进程间 API 层由**两条正交通道**组成：Typert/API Gateway（Host↔浏览器，类型图生成 + unary RPC）与 SDK（进程外程序↔runtime 子进程，stdio JSON-RPC）。
- Typert 把"类型即契约"落到构建期：Analyzer 把 TS 类型图抽象为编译器无关模型，Emitter 生成 zod schema 与描述符 JSON，产出 `lib/typert.host.*` / `lib/typert.client.*` / `lib/typert.remote-client.*` 并强制 package.json 导出约定。
- `ctx.typert` 是四合一注册表（local/remotes/lookups/contexts），一切注册都是 Cordis effect 作用域，卸载自动撤回；`ctx.typertGateway` 通过 Connection `/api` interceptor 认领端点，每次调用现场解析活服务并做精确参数/JSON 安全/绑定一致性验证。
- `@Remote`/`@RemoteScope` + `TypertRemoteService`/`bindTypertRemote` 是 Host 侧声明机制；`api/remotes` 是应用级 BFF（agent/session lookup 策略 + 事件转发白名单 + Client 贡献装配）。
- SDK 协议是 3 请求 + 4 通知的新行分隔 JSON-RPC 2.0（`-32601/-32603` 错误码），server 插件接 stdio、`shutdown` 走根上下文卸载并退出 0，TS 客户端提供 `HarnessClient`（底层）与 `DeepSeekHarness`（高层 run API），关闭走 EOF→SIGTERM→SIGKILL 阶梯。
- 设计要旨：生成而非手写、数据驱动而非 Proxy 魔法、验证分布在生成期/装载期/调用期每一道边界、Host/Client 双面独立编译（`tsconfig.host.json`/`tsconfig.client.json`）使契约两侧不可能漂移。

---

## 附：摘录代码片段索引

- 摘录 A：`packages/typert/protocol/src/types.ts:139-163`（TypertCodec + InvocationParameterDescriptor）
- 摘录 B：`packages/typert/registry/src/service.ts:499-520`（effect 作用域注册）
- 摘录 C：`packages/api/gateway/src/index.ts:99-120`（Connection `/api` interceptor）
- 摘录 D：`packages/sdk/protocol/src/transport.ts:201-224`（JSON-RPC 帧分类）
- 摘录 E：`packages/interaction/commands/lib/typert.remote-client.js`（真实生成产物）
