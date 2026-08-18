# B. LLM 能力 seam 与持久化研究报告（DeepSeek Harness）

> 研究对象：`packages/llm/*`（LLM 能力 seam）、`packages/session/session-persistence*`（持久化）、`packages/session/session-projection*`（投影）、`packages/storage/*`（非会话存储 hub）、`packages/session/session-title*` 与 `session-telemetry*`，以及 `docs/subsystems/*`、`docs/cookbook/adding-an-llm-adapter.md` 官方文档。
> 所有引用使用仓库内相对路径，行号以本报告写作时源码为准。

---

## 0. 结论摘要（TL;DR）

- **LLM 是一套"词汇 + 线协议 + 适配器契约"**：`Message`/`ContentBlock` 是 provider 中立的消息词汇，`StreamChunk` 是唯一流式线协议，`LlmAdapter` 是唯一 provider 契约（只需实现 `stream()` 一个抽象方法）。`LlmRuntime` 充当注册表 + 流式调用 API，并通过 `llm/stream` waterfall 提供拦截点。
- **llm-deepseek 是"自研直连"参考实现**：fetch + SSE（`eventsource-parser`）对接 OpenAI 兼容的 `/chat/completions`，请求组装（`serialize.ts`）、SSE 解析（`sse.ts`）、chunk 翻译（`translate.ts`）、适配器类（`adapter.ts`）四层分离；llm-pi-ai 则是"包装第三方库"的另一种实现。
- **持久化是"事件溯源 + 可替换后端"**：`SessionPersistence`（Service Definition）定义 append-only 事件日志契约，JSONL 与 SQLite 两个后端共享同一个 `PersistenceCoordinator`（写路径编排 + crash recovery），后端只需实现约 7 个存储原语。
- **投影是"纯函数单元 + 框架驱动"**：`ProjectionDefinition` 三纯函数（`init`/`apply`/`view`），注册表订阅 `session/event` 逐个喂入；`SessionProjectionCache` 把检查点落到 storage domain，形成"缓存行 → readFrom 尾 → 全量重放"的冷读阶梯。
- **storage hub 是"无 IO 的中转站"**：hub 只做后端注册与 data-form 挂载，`storage-domain` 是唯一消费者，提供 schema 校验 + `domain/changed` 事件的 KV 域。
- **设计哲学**：LLM、持久化、投影、存储、标题、遥测全部是"capability seam"（Service Definition / Service Provider / Consumer 三件套），"换一个 provider/后端 = 换一个插件包、重跑同一个契约测试套件"。

---

## 1. LLM seam：词汇、请求、线协议、组装器

### 1.1 Message / ContentBlock 词汇

**ContentBlock**（`packages/llm/llm/src/types.ts:99-110`）是 merge-extensible 的封闭判别联合，由 `ContentBlockMap` 派生：

```ts
export interface ContentBlockMap {
  'text': TextBlock            // { type:'text'; text: string }
  'reasoning': ReasoningBlock  // 推理/思考，与可见文本分开
  'image': ImageBlock          // attachment 引用（ImageAttachmentRef）
  'tool-call': ToolCallBlock   // { id: CallId; name; arguments: string(原始JSON) }
  'tool-result': ToolResultBlock // { toolCallId; content: ContentBlock[]; isError? }
}
export type ContentBlockType = keyof ContentBlockMap
export type ContentBlock = ContentBlockMap[ContentBlockType]
```

要点：
- `tool-call.arguments` 全程是 **raw JSON 字符串**（协议要求，见 §1.3）；
- `tool-result` 可嵌套任意 ContentBlock（递归图像扫描 `contentHasImage`，`packages/llm/llm/src/content.ts:13`）；
- 新增核心块必须同时落地 adapter、UI、compaction 支持（types.ts:96 注释）；插件通过声明合并扩展 `ContentBlockMap`。

**Message**（`packages/llm/llm/src/message.ts:129-138`）是"一个身份 + 角色 + 内容 + 来源"的不可变值：

```ts
export interface Message {
  readonly id: MessageId          // 跨所有表示边界保持的稳定身份
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource  // 谁产生的
}
```

- **source（来源）**是另一个 merge-extensible 联合 `MessageSourceMap`（message.ts:100-105）：`user` / `plugin`（可带 `ContextForm`）/ `model`（`ModelMessageSource`，含 provider、model、可选 `replayState`）/ `tool`（`ToolMessageSource`，含 `callId`）。
- **`replayState`（`AssistantProvenance`，message.ts:8-19）**是 adapter 私有的、用于重放 provider 响应的 lossless-JSON 状态，对 harness 完全不透明；`LlmRuntime` 只在"历史 provider 与目标 provider 当前由同一个 adapter 实例持有"时才把它传给目标 adapter（见 §1.6 `forAdapter`）。
- **ContextForm**（message.ts:48-94）：`instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall`，是*语义*词汇而非*视觉*词汇——"谁产生"与"是什么信息"两条轴独立。
- 构建工厂：`createMessage`/`createUserMessage`/`createAssistantMessage`/`createToolResultMessage`（message.ts:178-241），全部经 `freezeMessage`（`structuredClone` + `deepFreeze`，message.ts:169-171）冻结后发布。
- `isTokenDelta(chunk)`（message.ts:251-261）：判定一个 chunk 是否携带可见模型输出（首 token 边界，供 step 计时与 sessionStats 投影共享）。

### 1.2 组装后的模型请求：`GenerateOptions`

一次模型调用 = 一个完全组装的 `GenerateOptions`（`packages/llm/llm/src/types.ts:341-377`）：

```ts
export interface GenerateOptions {
  provider: string              // 注册路由 → 选择 adapter 实例
  model: string                 // provider 侧的模型 id（无需预先注册）
  reasoningEffort?: ReasoningEffortId
  messages: Message[]           // 有序会话消息（system slot 之后的部分）
  system?: string               // 系统提示，adapter 映射到 provider 的 system 槽
  tools?: ToolSchema[]          // JSON-schema 工具描述（声明在 dsh-llm 而非 dsh-tools）
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>   // loop 盖的会话身份戳
  purpose?: 'compaction' | 'session-title'  // 辅助模型调用分类
}
```

- **`LlmCallConfig`**（types.ts:635-643 附近的 `call-config.ts`）：provider/model/reasoningEffort/temperature/maxTokens/stop 构成"会话级"请求配置，loop 从已记录日志重建请求（可重建性 Agent Note）；`LlmCallConfigAdapterDefaults` 标记哪些字段由 adapter 精确模型解析物化而非调用方提出。
- loop 构建的请求带 `markAgentLoopRequest` 身份且深冻结（`call-config.ts`），到达 `llm/stream` 的请求**只读不可改写**——它是会话日志的纯函数。

### 1.3 `StreamChunk` 线协议

adapter 的唯一输出协议（`packages/llm/llm/src/types.ts:312-324`），封闭判别联合：

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

协议约定（types.ts:304-311 注释 + 文档 llm-streaming.md:227-239 契约清单）：
- **`index` 关联**：delta 用 `index` 绑定到自己的块；`block-end` 携带已组装好的完整块，消费者无需自行拼接 delta。
- **顺序纪律**：`usage` 必须出现在 `finish` 之前，`finish` 之后**不得再有任何 chunk**（因此 adapter 通常把 finish/usage 缓冲到 provider 的流结束标记 `[DONE]` 处再发）。
- **工具参数**：`argumentsDelta` 流式片段是 raw JSON 字符串；provider 若返回解析后的对象，`block-end` 处重新 stringify。
- **错误两条路**：要么从 `stream()` **抛出**（传输/协议错误，用 `LlmError`），要么以 `finish {kind:'error'|'aborted', failure}` **终结流**（provider 带内错误）。`LlmRuntime.stream()` 会把 adapter 抛出的任何异常规范化为终结的 error/aborted finish（`adapterFailureChunk`，index.ts:931-939）。
- **`FinishReason`**（types.ts:116-125）：`stop` / `tool-calls` / `max-tokens` / `aborted` / `error`，merge-extensible。
- **`TokenUsage`**（types.ts:135-141）为**不相交计数**：`inputTokens` 只算未缓存输入，缓存命中单独报 `cacheReadTokens`/`cacheWriteTokens`（计费输入 = 三者之和）；DeepSeek 的 `prompt_tokens` 含缓存命中，adapter 要减掉（见 §1.7 `mapUsage`）。
- **`ReplayEnvelope`**（types.ts:290-302）：`finish` 可携带 adapter 私有的重放元数据（响应级 `response` + 按块对齐的 `blocks`），半透明——harness 只知道"切分方式"（对齐/丢弃规则），不读内容。
- 协议是**封闭**的：消费者 `switch(type)` 以 `assertNever` 收尾，新增变体会在编译期迫使所有消费者处理。

### 1.4 `BlockAssembler`：chunk → 消息的唯一组装算法

`packages/llm/llm/src/assembler.ts:36-187`。agent loop 边把原始 chunk 记入日志边喂给同一个 assembler，最后读出 `blocks()` / `message()` / `usage` / `finish` / `replayState`。

- 内部 `partials: Map<index, PartialBlock>` + `order: number[]`，`push()` 按 chunk 类型增量累积；`block-end` 到达即"关闭"该 partial（`partial.block` 权威化）。
- **对 delta-only 协议宽容**：没有 `block-start/end` 也能工作；`block-end` 之后到达的 delta 被忽略（畸形流防护，防内存增长/破坏已关闭块）。
- **max-tokens 截断的 keep/drop 决策是"一处决策、两处派生"**（assembler.ts:133-148）：`max-tokens` finish 丢弃所有 `tool-call` 块（截断的调用不能安全执行），并同步剪掉 replay envelope 中对应位置的 per-block 条目——`blocks()` 与 `replayState` 永不打架；envelope 条目数与块数不符则整体丢弃 envelope。
- 开放块（未收到 `block-end`）由累积 delta 组装；未知块类型未关闭时 `assemble` 抛错。
- `message(source)` 默认来源 `{ kind: 'plugin', plugin: 'dsh-llm/assembler' }`。

### 1.5 `LlmAdapter` 完整契约

`packages/llm/llm/src/index.ts:180-233`。抽象类，**只有一个抽象方法**：

```ts
export abstract class LlmAdapter {
  // 描述一个本 adapter 拥有的 provider 路由（id 必须等于 provider）
  providerInfo(provider: string): LlmProviderInfo
  // provider 自有的重试策略，随路由注册时捕获；undefined 用正常默认
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined
  // 广告模型目录（advisory，非白名单——adapter 可接受未列出的模型 id）
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>
  // 精确模型元数据（上下文容量、默认 maxTokens、推理档位）——独立于目录，不做路由校验
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  // 唯一的必选方法：流式执行一次模型调用
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

- 每个 provider HTTP 请求必须带 `attributionHeaders()`（`packages/llm/llm/src/attribution.ts:64`，默认 `APP_IDENTITY` 的 `User-Agent`），并有 wire 级测试证明。
- 失败统一为 `LlmFailure`（types.ts:40-51）：`message` + 稳定 `code` + 可选 `status`/`providerRetryAfterMs`/`requestId`；`LlmError extends HarnessError`（index.ts:83-117）携带同一 `LlmFailure`。规范错误码见 `packages/llm/llm/src/error.ts`：`CONTEXT_WINDOW_EXCEEDED`(:25)、`QUOTA`(:28)、`EMPTY_RESPONSE`(:39)、`INVALID_CREDENTIAL`(:48)。
- 契约要点（文档 llm-streaming.md:229-239）：一次 adapter 调用 = 一次 provider 尝试（adapter 关闭库内重试；agent 级恢复另开一个编号 turn）；流空闲由 `streamIdleTimeoutMs`（默认 5 分钟）看门狗兜底；空完成是**可重试错误**（`EMPTY_RESPONSE`）而非静默成功。

### 1.6 `LlmRuntime` 与 `ctx.llm` 注册 API

`LlmRuntime`（`packages/llm/llm/src/index.ts:284-928`）注册为 `ctx.llm`（index.ts:46-49 声明合并）。核心面：

- **注册**：`registerAdapter(providers: string[], adapter): AdapterRegistrationHandle`（index.ts:338）。全有或全无（重复路由抛 `DUPLICATE_ADAPTER`，index.ts:380）；返回的 handle 既是 disposer 又带 `replace(next)`——同一 adapter 实例的**原子路由替换**（先整体校验再单同步段换入，index.ts:358-365），空数组合法但空初始注册非法。
- **可配置 provider 目录**：`registerConfigurableProviders(entries)`（index.ts:431）声明"配置即可激活"的路由（settingsNs/settingsPath），`listConfigurableProviders()`（index.ts:490）供配置界面合并展示活跃/休眠路由。
- **模型发现**：`registerModelDiscovery(settingsNs, discover)`（index.ts:504）+ `discoverModels(settingsNs, request)`（index.ts:532）——为"正在编辑的草稿"（尚无路由）探询端点。
- **精确模型元数据**：`resolveModelInfo()`（index.ts:619）校验并 detach adapter 返回；`resolveCallConfig()`（index.ts:730）物化 adapter 默认并拒绝不支持的 reasoningEffort（`UNSUPPORTED_REASONING_EFFORT`）；`prepareCall()`（index.ts:779）返回 `PreparedLlmCall`——一次 dispatch 绑定一个注册，跨模型解析/日志记录/dispatch 保持同一 adapter 实例（HMR 不能混配），config 变更则抛 `INVALID_PREPARED_CALL`。
- **流式调用**：`stream(options)`（index.ts:913）→ `streamWithRegistration` 包 `ctx.waterfall(this, 'llm/stream', …)`（index.ts:921-927）。`llm/stream` 是 **waterfall 事件**（index.ts:64 声明）：retry、replay、routing 都挂在这里；listener 调 `next()` 到 adapter 或自己产出 chunk 短路。
- **重放过滤**：`forAdapter(options, adapter)`（index.ts:823-836）——只把 `replayState` 传给**同一 adapter 实例**拥有历史 provider 的情况；否则剥掉私有状态、降级为 provider 中立内容（可重建性保证）。
- **边界归一化**：`adapterStream`（index.ts:843-900）把 adapter 选择、dispatch、iterator 构造、迭代失败全部转为**一个终结 failure chunk**；middleware/consumer 失败保持抛出。
- **拓扑通知**：`llm/adapters-updated` emit 事件（types.ts:23），非否决式通知（坏 listener 被包含，index.ts:297-322）。
- 自带 `assertUsableApiKey(raw, pkg, ref)`（index.ts:137-152）：裁剪空白、拒绝空/含非法字符的 key，报 `INVALID_CREDENTIAL` 且**绝不把密钥回显进消息**。

### 1.7 llm-deepseek：官方 provider 适配器（直连 OpenAI 兼容 API）

`packages/llm/llm-deepseek/src/`，四层职责分离（cookbook 推荐的参考布局）：

1. **`serialize.ts` — 请求组装**：`serializeRequest(options, defaults)`（:151-187）产出 wire 请求体 `{model, messages, stream:true, stream_options:{include_usage:true}, thinking, reasoning_effort, tools, temperature, max_tokens, stop}`（可选字段省略而非发 null）。`serializeMessages`（:112-141）做词汇映射：harness 的 `tool-result` 块 → 独立的 `{role:'tool', tool_call_id, content}` wire 消息（文本先行）；assistant 纯工具 turn 发 `content:""` **绝不发 null**（官方样例逐字回放 content，gateway 会拒绝 null；推理-only turn 发 null 会 400 且"砖化"整个会话日志）；thinking 模式的 `reasoning_content` **只在工具轮回传**（官方 passback 规则，省 token）；核心 image 块显式拒绝（`UNSUPPORTED_CONTENT`，:64-68）；`purpose==='session-title'` 强制关闭 thinking（:38）。
2. **`sse.ts` — 传输解析**：`parseSse`（:28-40）用 `EventSourceParserStream` 解码字节流 → data payload，`[DONE]` 作为最后一个 payload 原样 yield；EOF 未见 `[DONE]` 抛 `STREAM_CLOSED`（截断响应不可信）。注释事件只经 `onComment` 回调（喂 watchdog pulse）。
3. **`translate.ts` — wire → StreamChunk**：`translate`（:86-185）为 text/reasoning/tool-call 各维护一个 open block（`index` 按首见顺序分配）；`reasoning_content` 先于 `content` 处理（thinking 模式交错）；空字符串首帧**不开块**；`finish`/`usage` 全部**延迟到 `[DONE]`** 统一 flush（覆盖 finish-attached 与 trailing usage-only 两种形态，保证 `usage` 在 `finish` 前且 finish 后无 chunk）。`mapFinishReason`（:31-43）：`stop`/`tool_calls`/`length` → `stop`/`tool-calls`/`max-tokens`，未知（content_filter 等）→ `{kind:'error', code:大写值}`。`mapUsage`（:53-62）：

```ts
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),   // prompt_tokens 含缓存命中 → 减出
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}
```

   语义：DeepSeek 的 `prompt_tokens` **包含**缓存命中，harness 要求不相交计数，故在此减出。
4. **`adapter.ts` — 适配器类**：`DeepSeekAdapter extends LlmAdapter`（:160-350）。
   - **连接事实按操作解析**：构造参数是三个 thunk——`options()`（每次流调用解析一次 `DeepSeekConnectionOptions`）、`resolveApiKey(connection)`（每次请求从*同一快照*解析 bearer，端点与密钥永不跨代配对）、`resolveUserId()`（匿名 id，进遥测头）。配置变更**无需重注册**即达下一次请求，但 in-flight 流保持开始时的事实（:218-224 注释）。
   - **endpoint**：`${baseURL}/chat/completions`，POST；默认 `https://api.deepseek.com`（index.ts:104），可用 `$DEEPSEEK_BASE_URL` 环境层覆盖（仅可信层）。
   - **认证**：`authorization: Bearer <apiKey>` + `content-type: application/json` + `accept: text/event-stream` + `attributionHeaders()` + `x-deepseek-harness-user-id` + 可选 `x-deepseek-harness-session-id` / `x-deepseek-harness-compact`（:287-299）。
   - **流式**：`stream()`（:218-273）用 `AbortSignal.any([options.signal, consumer.signal])` 合成单一稳定信号，`idleWatchdog`（`STREAM_IDLE_TIMEOUT`）只在 `next()` 悬空时武装；错误分类：watchdog → `TIMEOUT`，调用方 abort → `ABORTED`，`LlmError` 原样透传，其余包成 `TRANSPORT`。
   - **错误映射**：非 2xx 先尝试解析 `{error:{message,code,type}}`，`httpErrorCode`（:140-151）：401/403→`AUTH`；`isQuotaExceededError`→`QUOTA`；429→`RATE_LIMIT`；400 且 `isContextWindowExceededError`→`CONTEXT_WINDOW_EXCEEDED` 否则 `INVALID_REQUEST`；≥500→`SERVER`；其余 `HTTP_<status>`。附带 `retry-after` → `providerRetryAfterMs`、`x-request-id`/`x-deepseek-request-id` → `requestId`（:119-132）。
   - **注册插件**（index.ts:200-276 `apply`）：`inject: ['llm']`；schemastery `Config`（apiKeyEnv 默认 `DEEPSEEK_API_KEY`、baseURL、thinking、reasoningEffort、maxTokens、defaultContextWindow、models、streamIdleTimeoutMs、retryPolicy）；`resolveAdapterOptions`（:161-198）是唯一显式解析步（程序化构造可能绕过 schema，因此所有默认/边界在此重判）；`resolveApiKey`（:225-246）走 `ctx.credentials`（可选）→ 环境层，都无则 `MISSING_CREDENTIAL`；`ctx.llm.registerConfigurableProviders([{provider:'deepseek-official', …}])` + `registerAdapter(['deepseek-official'], adapter)`（:251-256）；retry policy 是注册捕获的唯一事实，变更时 `registration.replace([PROVIDER])` 原位重注册（:258-268）；`installSettingsSection` 让设置热更新直达下一次请求。

### 1.8 llm-pi-ai（快速浏览）

`packages/llm/llm-pi-ai/` 是"包装 LLM 库"的另一种实现（`@earendil-works/pi-ai`）：
- `PiAiAdapter`（adapter.ts:106 起）每次解析产生一个**不可变 snapshot**（profiles + 用它们构建的 `Models` 集合，adapter.ts:57-62）——因为 `Models.streamSimple()` 是惰性的（首次消费才解析 provider），配置变更必须构建新集合而非原地改，否则 in-flight 请求会在中途换 provider（adapter.ts:1-22 注释）——这正是 `llm.prepareCall()` 逐 step 冻结能贯穿到底的原因。
- 凭据走 harness 自己的 seam 并作为请求 `apiKey` 选项传入（pi-ai 视其为最高优先级 auth override）。
- 路由可以是 pi-ai 自带目录（openai/anthropic 等）或手声明（api/baseURL/compat），目录条目通过 `registerConfigurableProviders` 暴露（index.ts:120-130 起）；路由集合或注册捕获的 retry policy 变更才触发 `replace` 重注册。
- 能力元数据（thinking 档位、上下文窗口）由 pi-ai 模型描述解析而来；`toPiContext`/`toStreamChunks` 负责上下文转换与 chunk 翻译。

### 1.9 如何新增一个 provider（最小代码路径）

依据 cookbook `docs/cookbook/adding-an-llm-adapter.md`（:7-43）与 llm-deepseek 参考布局：

```
class MyAdapter extends LlmAdapter { async * stream(options) { … } }   // ① 实现契约（唯一必选）
export const name = 'llm-myprovider'                                    // ② Cordis 插件名
export const inject = ['llm']
export const Config: z<Config> = z.object({ apiKey: z.string(), … })   // ③ schemastery 配置 + 环境回退
export function apply(ctx, config) {
  ctx.llm.registerAdapter(['my-provider'], new MyAdapter(…))            // ④ 注册路由
}
```

协议义务：`usage` 在 `finish` 前、`finish` 后无 chunk；tool arguments 全程 raw JSON；`index` 按首见顺序分配且同一块复用；错误走"抛出 `LlmError`"或"`finish {error|aborted}`"两条路之一；尊重 `options.signal`；不能支持的 `GenerateOptions` 字段抛 `UNSUPPORTED` 而非静默丢弃；需要原生元数据回传时在 `finish.replayState` 发最小 lossless-JSON 投影并在重建历史时校验。结构上把 wire 类型 / 请求序列化 / 传输解析 / chunk 翻译 / adapter 类拆成独立模块（llm-deepseek 是参考布局）。可选面：`providerRetryPolicy`、`listModels`、`resolveModel`、`registerConfigurableProviders`、`registerModelDiscovery`。

### 1.10 token-meter：重放感知的令牌计量（快速浏览）

`packages/llm/token-meter/`（`@deepseek-ai/dsh-token-meter`，`ctx.tokenMeter`，index.ts:74）。它回答"一次请求 + 当前 surface 需要多少 token"，是**重放式**的：`measure(session, requestHeader?)`（index.ts:116）通过 `_sync` 沿会话的持久化尾部重放，产出一个 detach 且深不可变的 `TokenMeasurement`（types.ts：`logRevision`、`baseline`、`surfaceDeltaTokens`、`totalTokens`、`surfaceTokens`、`nodes`）。

- **计量基线**：`baseline.kind === 'usage'` 表示最近一次成功 provider 调用的规范化请求信封与 `requestHeader` 相同且总量不低于那次调用的全启发式锚点——此时**复用 provider 真实 usage**；否则整包用固定启发式重新计价（`estimate.ts` 的 `estimateMessage`/`estimateHeader`，含 `ROLE_OVERHEAD`）。`surfaceDeltaTokens` 相对锚点带符号重计价，保留增长与收缩。
- **投影注册**：`ctx.inject(['sessionProjections'], …)` 条件注册三个纯投影单元（index.ts:87-91）：`tokenUsageProjectionDefinition`（`usage-projection.ts`，不相交桶的累计与"最近一次"）、`contextPressureProjectionDefinition`（prompt 侧压力 = input + cache 读写，:71-72）、`contextBreakdownProjectionDefinition`（`breakdown-projection.ts`）——没有通用注册表的组装保持独立读形状。
- **观察点**：`session/event` 只对已有状态的会话做 eager `_sync`（index.ts:95-97，"读者独立追赶、eager 观察约束普通读延迟、但不为无人读的会话造状态"）；chunk/消息内的 usage 提取见 `usageOf`（usage-projection.ts:75-80：`assistant/chunk` 的 `usage` chunk 或 `assistant/message` 的 usage）。
- 它是"SD 词汇 + 注册即生效"模式的又一个例子：计量数学在域单元里、驱动在投影注册表里、读取面在 `ctx.tokenMeter`。

---

## 2. 持久化：`SessionPersistence` seam

### 2.1 Service Definition：`SessionPersistence`

`packages/session/session-persistence/src/index.ts:84-241`，抽象服务注册为 `ctx.sessionPersistence`。事件日志**没有并行的持久化事件类型**——后端直接存 `SessionEvent`，非可重放的元数据（`SessionHeader`）单独携带。方法签名：

- `locate(meta): SessionLocation | undefined`（:96）——同步解析后端自有 artifact 路径（位置提示，非授权/新鲜度保证）；SQLite 返回 undefined。
- `readonly supportsRawArtifacts: boolean`（:102）+ `readRaw(id, signal): Promise<SessionRawArtifact | undefined>`（:119）——逐字节原始 artifact 文本（JSONL 有，SQLite 无）。
- `create(meta): Promise<void>`（:133）——注册元数据；后端可**懒物化**到首次 append（从未 append 的会话在 `list` 中缺席，废弃会话零残留）。
- `append(id, events): Promise<void>`（:143）——持久化连续批次；首个事件 `seq` 必须等于存储 next-seq；拒绝非 JSON 可序列化的 `event.data`。
- `prepare(id, signal): Promise<SessionPreparation>`（:155）——resume 用的确切未发布 Session（可复用 inspect 的缓存图，须先确认 revision 仍当前）。
- `load(id): Promise<SessionInspection>`（:183）——加载平衡逻辑视图**并提交冷恢复**（截断撕裂尾 + 补合成 closers）；不得 crash-repair 仍绑定活跃 Session 的身份（活跃开 turn 拒绝）。
- `inspect(id, signal): Promise<SessionInspection>`（:200）——只读、不发布、不提交恢复的不可变视图（冷断 turn 在内存里补 closers、撕裂物理尾不动；活跃会话借用其不可变快照）。
- `readFrom(id, fromSeq, signal)`（:220）——**read-from-seq 原语**：水印恢复型读模型的物理后缀读（投影缓存只折检查点之后的尾巴）；SQLite 按 seq 直接 seek，JSONL 解析全文再前跳；撕裂片段永不到达调用方。
- `list(signal): Promise<SessionHeader[]>`（:228）+ `listSnapshots(signal): Promise<SessionPersistenceSnapshot[]>`（:240）——轻量列元数据（+ 廉价 source-qualified revision）。

`SessionPersistenceSnapshot = { header, revision }`（:18-23），`SessionPersistenceRevision`（revision.ts）是 opaque 品牌串，**按存储源限定**（不同后端/不同 store 的计数器不能互相比较）。

### 2.2 `PersistenceCoordinator`：后端无关的写路径编排

`packages/session/session-persistence/src/coordinator.ts:588-1361`。JSONL 与 SQLite 后端都构造一个 `new PersistenceCoordinator(ctx, this)` 并把服务方法委托给它（`# --- Public API ---` 注释段）。后端只需实现 `PersistenceBackend`（coordinator.ts:127-215）：

- `loadStored(id, signal): Promise<StoredPrefix<TornMarker> | undefined>`（读完整存储前缀 + 可选撕裂标记）
- `readStoredRevision(id, signal)`（轻量 revision，无日志加载）
- `loadStoredFrom?(id, fromSeq, signal)`（可选 seek 后缀读；SQLite 实现，JSONL 省略）
- `appendBatch(meta, events, isMaterialized): Promise<void>`（**物化与首批事件必须原子提交**——崩溃不得留下"已物化但空"的会话）
- `commitRepair(meta, tornMarker, closers)`（截断撕裂尾 + 补 closers；不必原子——文件后端可两步 fsync）
- `list(signal)`、`locate?(meta)`、`close?()`

Coordinator 提供的"其余一切"：**按会话 id 串行化**（`serialize()`，:1010-1033，同 id 写永不交错，错误不毒化链）、**写路径监听**（`installWritePath`，:1086-1137：`session/created` 捕获 header + 种子一次；`session/event` enqueue；`session/flush` 显式排空；`session/disposed` 退休排空）、**懒物化**（create 只记 intent，首次 append 原子物化）、**碰撞检测**（同 id 已有持久化日志 → 拒绝创建；cwd 不匹配/种子不覆盖前缀 → id collision）、**HMR 前缀收养**（adoptLivePrefix，:1301-1323：截断-only 修复，不开活跃 turn）、**prepared LRU 缓存**（默认 5，`preparedSessionCacheSize`）、**legacy 迁移**（`migrateLegacy*` 系列，:344-535，把 pre-identity 时代的 steering/message、turn/start、turn/end、user/message、assistant/message、tool/result 升级为当前形状）、**格式拒读**（`assertVersion` :1046 / `assertEventsSupported` :1061，未知必读事件类型拒绝解释，除非 `ignorable:true`）、**dispose 排空**（:1092-1115，先 flush 所有 live，再等 chains 清空，最后 `backend.close()`）。

`prepareCore`（:892-931）是冷恢复核心：`loadStored` → 校验版本/身份 → `adoptStoredEvents`（就地升级+验证）→ `interruptedTurnClosers(storedEvents)` 生成合成 closers → `ctx.sessions.prepare(id, {seed: balanced, meta, seedSource:'persistence'})` → 冻结 `SessionInspection`。失败包装为 `SessionPersistenceCorruptionError`，`SessionFormatUnsupportedError` 原样透传（指向原始日志路径）。

### 2.3 flush 时机：事件驱动 + 显式屏障 + 退役排空

`SessionWriteBehind`（write-behind.ts:22-159）是每会话的写控制器：`enqueue` 拷贝事件并启动**固定批窗口**（`maxDelayMs`，默认 200ms，`DEFAULT_WRITE_BATCH_MAX_DELAY_MS`，coordinator.ts:30）；到期启动一次持久化批；写期间到达的新事件获得自己的新窗口；后台写失败**保留事件并暂停自动重试**，新事件重启窗口；显式 `flush()` 取消等待、经 quiescence 排空（并发调用者共享同一 barrier）。

关键点（持久化文档 persistence.md:9-11）：
- `session/event` 是**同步通知**，持久化插件复制事件入队而不阻塞 producer；
- `session/flush`（`ctx.sessions.flush(session)`，见 packages/core/session/src/index.ts:1010-1025 的 dispatch 实现）取消等待、排空到 quiescence——**loop 在认领下一个普通 turn 之前用它作为排序与错误观察检查点**；协调器监听 `session/flush`（coordinator.ts:1129）；
- **disposal 执行同样的最终排空**（coordinator.ts:1132 `retire` + dispose effect）；
- 配置的 `maxDelayMs` 只约束*有意的批等待*，不约束事件循环调度或后端持久化延迟。

投影缓存另有自己的强制检查点时机：`turn/end` 与 session detach（见 §3.4）。

### 2.4 JSONL 后端：行格式与追加语义

`packages/session/session-persistence-jsonl/`。

**目录布局**（format.ts）：`root/<projectKey(cwd)或_no-cwd>/<encodeSegment(id)>/session.jsonl[.zstd]`。`encodeSegment`（:121-136）对 SessionId 做**全 JS 字符串（含孤立代理对）单射**的路径段转义（`~XXXX`），防穿越；`projectKey`（:147-167）把 cwd 转成可读目录名（有损但无碰撞风险）。

**行格式**（format.ts:33-44, 221-224）：
- 第一行是 header 记录：`{"type":"session","version":<SESSION_FORMAT_VERSION>,"id":…,"createdAt":…,"delegationDepth":…}`（可选字段省略，永不发 null，`toHeaderLine`/`fromHeaderLine`）；
- 其后每个事件一行：`JSON.stringify(event)`（`eventLines`，:221-224）；默认 `packChunks: true` 时，连续 `assistant/chunk` delta 运行**打包**成 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 存储行（lossless，实测约小 60%）；读取无条件解包（布局与开关无关）；
- 物理编码默认 `zstd`（校验和串联的 Zstandard 帧，`session.jsonl.zstd`）或 `none`（纯文本）；header 帧独立可解，便于只读首行列出。

一个（未打包、`compression:'none'`）日志的示意行序列（`packChunks:false` 时每事件一行）：

```json
{"type":"session","version":0,"id":"abc…","createdAt":1720000000000,"cwd":"/work","delegationDepth":0}
{"type":"turn/start","seq":0,"time":1720000000001,"data":{"turn":1}}
{"type":"user/message","seq":1,"time":1720000000002,"data":{"id":"m1","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}}
{"type":"assistant/chunk","seq":2,"time":1720000000003,"data":{"turn":1,"step":0,"chunk":{"type":"text-delta","index":0,"text":"Hello"}}}
{"type":"turn/end","seq":5,"time":1720000000005,"data":{"turn":1,"reason":{"kind":"completed"}}}
```

事件行的 JSON 形状 = `SessionEvent` 本身（`{type, seq, time, data, …envelope}`），无二次包装——"没有并行持久化事件类型"的直接体现。

**追加语义**（index.ts）：
- `appendBatch`（:422-429）：已物化 → `appendLines`；未物化 → `materialize`。
- `materialize`（:514-526）：临时文件写入 + fsync + **`link()`+`unlink()` 发布**（POSIX，:529-569；`rename()` 会静默覆盖，link 遇 EEXIST 失败可防并发双写 clobber），再 fsync 目录；Windows 走 `publishNewFileWin32`。发布前 `rejectExistingLog` 兜底。
- `appendLines`（:651-679）：追加 + fsync；部分写/同步失败则**回滚到先前大小**再抛（cursor 未变会重试；残留半字节会产生重复 seq）。
- 撕裂尾：zstd 扫描完整帧（`scanZstdFrames`），完整帧内的撕裂 JSONL 记录 → 拒绝（`committedBytes !== inputBytes`，:382-384）；残缺末帧 → 尝试 `decompressZstdPrefix` 恢复其中完整记录，`tornMarker = {truncateTo, recoveredEvents}` 交给 coordinator 的 `commitRepair`。
- `readStableFile`（:292-304）：stat-读-stat 循环保证读到 revision 稳定的字节（写与读竞争时不撕裂）。
- 修订：`fileRevision = dev:ino:size:mtimeNs:ctimeNs`（:100-108），stat 派生，零日志加载。

### 2.5 SQLite 后端：schema 与 `SCHEMA_VERSION`

`packages/session/session-persistence-sqlite/`，`node:sqlite` 的 `DatabaseSync`。

**Schema**（schema.ts:20, 116-147）：三张 STRICT 表——
- `persistence_state(singleton=1, store_id)`：store 身份（打开时写入随机 UUID，:148-150）；
- `sessions(id PK, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset, incarnation, revision)`：SessionHeader 行；**行的存在即物化信号**（首次 append 才写，:27-30 注释，与 JSONL"无文件直到首次 append"镜像）；
- `events(session_id REFERENCES sessions ON DELETE CASCADE, seq, type, time, data, source_event_seqs, surface_op, ignorable, PK(session_id, seq))`：1:1 事件行，`data` 为 JSON 文本。

**`SCHEMA_VERSION`（schema.ts:20，当前 = 15）**与 `SESSION_FORMAT_VERSION`（core/session/src/types.ts:56，当前 = 0）**正交**：前者版本化*表布局*（SQLite 库级，存 `PRAGMA user_version`）；后者版本化*事件词汇*（存每个会话的 `sessions.version` 行）。`openDatabase`（schema.ts:81-172）在 `BEGIN IMMEDIATE` 下校验：`user_version=0` 且非空库/有应用 id → 拒绝（未版本化）；`user_version ≠ SCHEMA_VERSION` → 拒绝（"incompatible with this build"）；版本匹配但 `application_id ≠ 0x44534850` → 拒绝（防污染无关数据库）；校验通过则建表、插 store_id、写 application_id 与 user_version，然后 `PRAGMA journal_mode`（默认 `wal`，rollback-journal 模式供网络挂载）。

**追加**（index.ts:284-302）：`appendBatch` **单事务**——`writeRow`（懒物化，INSERT … ON CONFLICT 更新 + 新 `randomUUID()` incarnation，:385-411）+ 逐事件 INSERT + `UPDATE sessions SET revision = revision + 1` + COMMIT；中途失败整体回滚。`commitRepair`（:309-338）：单事务 DELETE `seq >= tornMarker` + INSERT closers + revision+1。
**撕裂尾**（schema.ts:232-269 `scanRows`）：逐行解析 `data`，找最后一个合法 `turn/end`；此前区域的坏 JSON/seq 缺口 = 已提交损坏（抛），其后 = 容忍的撕裂尾（`tornFrom` 即物理删除起点）。`loadStoredFrom`（index.ts:225-238）直接 `WHERE seq >= ?` seek。revision = `storeId:incarnation:revision`（:47-51）。

### 2.6 crash recovery 流程

统一由 coordinator 驱动（persistence.md:13-19）：

1. 冷加载 `load(id)`/`prepare(id)`/`inspect(id)` → `prepareCore`（coordinator.ts:892-931）：
   - `backend.loadStored(id)` 读前缀 + 撕裂标记；
   - `assertStoredId` + `assertVersion`（格式版本拒读，`sessionFormatVersionRefusal` coordinator.ts:77-81 给出方向性提示："升级 harness" vs "本构建无升级路径"）；
   - `adoptStoredEvents`（升级 legacy 形状 + 校验）；
   - `interruptedTurnClosers(storedEvents)`：**保留完整的中断 turn**（不截断——单 turn 可能巨大且已持久化），只**合成缺失的 closers**（`turn/end {reason:{kind:'interrupted'}}` + 缺失的 tool error / step / turn 边界），`interrupted` 是 loop 永远不会自己发的 TurnEndReason；
   - `ctx.sessions.prepare(id, {seed: balanced, meta, seedSource:'persistence'})` 构建未发布 Session；
2. `commitPrepared`（:934-963）：`isPreparedSourceCurrent`（revision 读-查往返）→ 有撕裂/ closers 则 `backend.commitRepair`（JSONL：截断 + 追加恢复事件 + closers，两步 fsync；SQLite：单事务）→ **修后重读**（revision 已变，不把旧内存视图配新 revision）→ 建立 ownerless 持久化 cursor；
3. `load` 对活跃会话：等 retirement 排空 → 若 `ctx.sessions` 已 live，则 `flush` 后返回**平衡快照**，开 turn 则**拒绝**（绝不 crash-repair 活跃身份）；HMR 走 `adoptLivePrefix`（只截断撕裂尾，不开活跃 turn）。

### 2.7 `SessionHeader` 与版本语义

`packages/core/session/src/types.ts:61-99`：`{version, id, createdAt, cwd?, parentSession?, seedLength?, origin?:'subagent', delegationDepth?, agentPreset?}`——存储关注点（版本、cwd、谱系、种子边界）**不进** `SessionEventMap`、永不进入 `deriveMessages()`。`SESSION_FORMAT_VERSION=0`（types.ts:56，未发布期钉死，不承诺兼容、不提供迁移）；升级判定以**writer 发出什么**为准（旧运行时无法"带完整语义正确性"读新日志才 bump；普通新事件类型不 bump——`SessionEvent.ignorable` 守卫覆盖词汇增长）。

---

## 3. 投影系统

### 3.1 `ProjectionDefinition`：纯函数计算单元

`packages/session/session-projection/src/index.ts:42-74`：

```ts
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  key: K                                  // 本单元拥有的投影键
  schema: ZodType<SessionProjectionMap[K]> // view 输出离开 host 前的校验
  init(): S                               // 空日志状态
  apply(state: S, event: SessionEvent): S // 纯迁移；无关事件必须返回同一引用（Object.is → 零下游工作）
  view(state: S): SessionProjectionMap[K] // 状态 → wire 整值
  stateVersion: number                    // 持久化缓存失效版本（改字段/折语义时 bump）
}
```

- 三个函数**必须同步**（异步单元会撕裂 carrier 的一致性切面）；`state` **必须是 plain JSON**（持久化缓存前置条件）。
- 承重规则：**整值事件规则**——携带状态的事件必须含完整 post-change 状态而非裸 delta，使迁移廉价、服务值自描述（last-wins）。
- 注册是 effect（disposer 随调用 fiber）：单元卸载即从快照与驱动中消失，客户端读作能力缺失；同 key 重复注册计数共享（`refs`，:148-153, :198-222）——N 个 agent preset 挂同一工具包注册 N 次，key 存活到最后一人卸载；`stateVersion` 不同拒绝共享。

### 3.2 `SessionProjectionMap` 与注册表驱动

`SessionProjectionMap` 是整条链（host 单元、wire 块、client hook）的 merge-extensible 类型表（`types.ts`，域插件经声明合并贡献键）。`SessionProjectionRegistry`（index.ts:171-426）注册为 `ctx.sessionProjections`：

- 构造时**订阅一次 `session/event`**（:181-183），每个已提交事件 → `drive`（:405-425）→ 每个注册单元的 `apply`；状态引用变了 → 以 schema 校验后的 `view` 通知 change feed（`onChanged`，:230）。
- **单元格（UnitCell）懒构建**：单元注册晚于事件流动、或会话早于注册表，首次触碰（事件或读）时从内存日志 `buildCell`（:388-392，`init` 折全日志，`observedSeq` 记为最后折叠事件的 seq）。
- 热路径通知是**同步、非否决**的（drive 内直接循环 listeners）。

### 3.3 watermark 推进与快照切面

- 每单元每会话维护 `UnitCell {state, observedSeq}`（:131-135）；`drive` 每次 apply 后 `cell.observedSeq = event.seq`（**无论是否变化**，这是"已观察"水印，区别于"已变化"）。
- `snapshot(session)`（:248-255）**全同步**：`asOfSeq = session.seq - 1`（共享水印，空日志为 -1），每个值过 schema。
- `checkpoint(session)`（:271-282）：每单元 `{ver: stateVersion, seq: observedSeq, val: structuredClone(state)}`——**detached 克隆**，绝不给调用方 live 引用；这是持久化缓存行的写侧。
- `restoreFloor(checkpoint)`（:300-310）：最低可用水印**减一**的锚点（可用 = `ver` 匹配；缺失/不匹配拉到 0 全量重折）。减一锚点是承重的：尾读由此证明存储日志还延伸到多远，能侦测"日志因 crash-repair 截断而缩到某行水印之下"，避免把陈旧行当当前值。
- `viewCheckpoint(checkpoint)`（:322-331）：零 I/O 读级——只对 `ver` 匹配的行 serve schema 校验的 `view`，陈旧但**绝不错误**。
- `restore(checkpoint, events, baseSeq)`（:355-385）：冷读配方 = 可用缓存行状态 + 前向尾重放 + `view`。行可用判定：`ver` 匹配、`seq >= baseSeq-1`、`seq <= endSeq`；不可用且 `baseSeq > 0` **抛错**（要求调用方从 seq 0 重读——只有全日志重折才安全）；返回刷新后的检查点行供写回。

### 3.4 `SessionProjectionCache`：持久化检查点与冷读阶梯

`packages/session/session-projection-cache/src/index.ts:71-300`，注册为 `ctx.sessionProjectionCache`，打开 `session_projcache` domain（`projectionCacheDomainSpec`，spec.ts）——**缓存行 = `(sessionId → {identity, rows: key→{ver,seq,val}})`**，identity 绑定 `{createdAt, cwd}`（`identityOf`，:291-293）防止"重用的 id 或换 store 后的旧记录"污染无关日志（`recordFor`，:101-105）。

- **写时机**（`installWritePath`，:201-239）：`session/event` 计数/间隔节流（`writeEveryEvents` / `writeIntervalMs`，Config :42-52）+ **两个强制点**：`turn/end`（:206-208）与 session detach（:226-230）——detach 是 live-to-cold 时刻，之后冷读阶梯由缓存服务。`write(session)`（:140-152）先取检查点 cut，再 `sessions.flush(session)`（持久化先于缓存行的**持久性屏障**——崩溃只会缓存落后于日志，永不超前产生幻影值），再 `put` 整个记录。
- **冷读阶梯**（`coldSnapshot(id, signal)`，:166-197）：
  1. `table.get(id)` 取缓存记录（若 identity 不匹配整条丢弃）；
  2. `restoreFloor(cached)` 算锚点；`persistence.readFrom(id, floor)` 只读尾巴（SQLite seek / JSONL 前跳）；
  3. `sessionProjections.restore(cached, tail.events, floor)` 重折；
  4. 恢复失败（行超界 = 日志收缩、identity 不相关）→ **整读 `readFrom(id, 0)` 全量重折**（慢档但仍无崩溃）；
  5. `putSoft` **fail-soft 写回**（写失败只警告，下次冷读自愈）。
- `cachedSnapshot(meta)`（:119-130）：**零 I/O 列读**——直接 `viewCheckpoint` 存储行，`asOfSeq` 取最低已服务水印（欠报安全，over-claim 才会让陈旧值压过新值）。
- 一切持久化写 fail-soft（丢失 = 更长的下次尾重放）；`ver` 不匹配丢弃而非迁移。

---

## 4. Storage hub：非会话存储

### 4.1 hub：`ctx.storage`

`packages/storage/storage/src/index.ts:47-93`：`Storage` 是**会合点而非仓库**——hub 自身零 IO。`ctx.storage.backend` 是 name → backend 表（`BackendRegistry`，registry.ts，多后端并存）；`mount(form, facility)`（:64-75）挂 data-form（effect，disposer 卸载，重复挂抛 `duplicate-mount`），`form(form)`（:82-87）解析（未挂抛 `form-not-mounted`）。`StorageForms`（:41）是空接口，data-form 拥有者经声明合并扩展——`storage-domain` 合并 `domain: DomainFacility`（storage-domain/src/index.ts:29-33），故 `ctx.storage.domain === ctx.storageDomain`。`storageBackendServiceKey(name)`（:26-28）为每个后端发布生命周期 service key，form provider `inject` 它使激活不与后端注册竞速。

### 4.2 后端契约：`StorageBackend` / `KvFacet` / `KvUnit`

`packages/storage/storage/src/backend.ts`：
- `StorageBackend`（:17-27）：`kv?` 可选 facet + `close()`；一个后端拥有一介质、共享生命周期；不能服务的 data kind 直接省略，解析时 fail loud。
- `KvFacet.open(descriptor): Promise<KvUnit>`（:30-43）：打开/惰性创建单元；介质上版本不符抛 `version-mismatch`，无法解析抛 `malformed-medium`（无迁移，pre-release 立场）；同名未关重开是 caller bug 拒绝。
- `KvUnitDescriptor`（:46-55）：`{name, version, tables[], hasGlobal}`，name 须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（:10，既安全作文件名也安全作 SQL 标识符段）。
- `KvUnit`（:66-104）：`loadAll()`（全表 + global singleton，null = 从未写）、`putRecord`/`deleteRecord`/`setGlobal`、`close()`。值对单元是**不透明 JSON**（无 schema、无事件、无域义）；单元**不串行化并发写**（顺序是调用方职责——domain 层按单元跑写链），但每次单调用在介质上原子且 resolve 即 durable。
- 实现：`storage-json`（unit.ts）内存态权威，每次写**原子重发布整个文件**（`writeAtomic`，失败回滚内存）；`storage-sqlite` 一记录一行。

### 4.3 domain：声明、打开、挂载

`packages/storage/storage-domain/` 是后端契约的**唯一消费者**与人人使用的类型化 API：
- `DomainSpec`（spec.ts:35-44）：`{name, version, global?, tables}`；`domainTable<K,V>(schema)`（:63）用 phantom key 类型携带编译期投影；`defineDomain`（:79-98）在 owner 模块加载时 fail loud（名字/版本/全局 schema 接受 null——null 是介质"从未写"哨兵，可空全局无法 round-trip）。
- `descriptorOf(spec)`（:105-112）把 spec 投影成 `KvUnitDescriptor`。
- `DomainFacility.open(spec)`（index.ts:100-156）严格序列：already-open → 路由解析（`Config.backend` 默认 + `routes` 按域覆盖，:52-62）→ `facet-unsupported` → `kv.open` → `loadAll` + 逐记录 zod 校验（`invalid-record` 带表与键）→ 构造 `DomainImpl`；caller 拥有句柄负责 `Domain.close()`（典型作为自己的 ctx.effect disposer），facility unmount 兜底 `closeAll()`。
- 写语义：`put`/`delete`/`update`/`global.set` 排队到**每域一条写链**，先达后端持久性、再改内存、再发 `domain/changed`（events.ts）；后端拒绝则内存不动（读永不背离介质）。`domain/changed` 是通知非事务参与者（commit 点已过，抛错 listener 被包含）。
- `apply`（index.ts:200-220）：`ctx.inject(backendServices, …)` 后 `ctx.storage.mount('domain', facility)` + `ctx.provide('storageDomain', facility)`。

---

## 5. 会话标题与遥测（简述）

**session-title**（`packages/session/session-title/`）：`SessionTitleService`（index.ts:261，`ctx.sessionTitle`）维护**latest-wins 的持久化标题状态**——标题以 `session/title` 事件落日志（log-only，永不进模型表面/派生历史，index.ts:94-102 事件声明），`foldSessionTitle`（:191）从日志折叠快照。`SessionTitleProvider`（:148-159）：`{id, automatic: 'first-prompt'|'all-prompts', generate(request)}`，`register()`（:434）effect 化；服务拥有确定性 fallback（`fallbackSessionTitle`，normalize.ts）、字节上限、provider 结果验收（ordering 校验 + 规范化 + 追加）。来源三态：`fallback` / `provider`（带 provider/model provenance）/ `user`（显式改名 pin 住标题、停止自动生成）。自动生成节奏由 provider 声明（`automatic`），服务负责调度、超时、supersession（新人类消息使在途生成作废，`PendingAutomaticWork.revision` 机制，:233-243）与并发提交约束。**session-title-llm**（`session-title-llm/`）共享 LLM 辅助请求的组装/超时/路由（`registerSessionTitleLlmProvider`，配置 `targetWords`/`targetCjkCharacters`/`maxInputBytes`/`maxOutputTokens`/`timeoutMs`/`provider`/`model`；预分发记录 `session/title-llm-request` 事件，可重建性）；**first-prompt-llm** / **all-prompts-llm** 是两个薄插件，只负责"选哪些人类消息"（第一个 / 全部）后复用共享实现。

**session-telemetry**（`packages/session/session-telemetry/`）：`SessionTelemetryBackend`（index.ts，`ctx.sessionTelemetry`）拥有**捕获侧**——固定 chunk 投影（每 `(turn,step)` 只发首个 `assistant/chunk` 作流开始信号）、`session-telemetry/record` **redaction waterfall**（:43，SD 的脱敏扩展点，ship 零规则）、handoff cursor、`SessionTelemetrySink` 最小后端契约（`emit` 非阻塞入队 / 可选 `flush` / `shutdown` 排空）。记录两通道：`ledger`（镜像会话日志事件，`(session.id, event.seq)` 去重）与 `ops`（`agent-error`/`shutdown` 操作信号，无 seq 身份、容忍重复）。**session-telemetry-otel**（`session-telemetry-otel/`）是 Service Provider：原样组合 OTel JS SDK（`LoggerProvider` + `BatchLogRecordProcessor` + OTLP/HTTP log exporter），`mode: FULL|FEEDBACK_ONLY|DISABLED`（默认 DISABLED）决定共享策略；"emit 之后的批/重试/队列/丢失策略属 SDK"是边界公理。

---

## 6. 设计哲学观察

### 6.1 seam 三件套（Service Definition / Provider / Consumer）在 llm 与 persistence 上的体现

仓库把"可替换能力"标准化为 capability seam（docs/capability-seams.md:4-6，图 :8-110；实现规范见 .agents/notes/implemented/architecture/2026-06-13-capability-seams.md）：

| 能力 | Service Definition（抽象面） | Service Provider（可替换实现） | Consumer（消费面） |
|---|---|---|---|
| LLM | `LlmRuntime` + `LlmAdapter`（`packages/llm/llm`） | `llm-deepseek`、`llm-pi-ai`（另有 `llm-retry` 挂 waterfall） | agent-loop、token-meter、compaction、session-title-llm 等 |
| 持久化 | `SessionPersistence`（`session-persistence`） | `session-persistence-jsonl`、`session-persistence-sqlite` | 所有经 `load/inspect/readFrom` 的读模型、投影缓存、session-query |
| 投影 | `SessionProjectionRegistry`（`session-projection`） | 各域插件注册纯单元（token-meter 的 usage/pressure/breakdown、session-stats 等） | host-apiproxy（快照 + 推送帧）、投影缓存 |
| 存储 | `Storage` hub + `StorageBackend`（`storage`） | `storage-json`、`storage-sqlite` | `storage-domain`（唯一消费者）→ workspace、投影缓存等 |
| 标题 | `SessionTitleService` + `SessionTitleProvider`（`session-title`） | `session-title-llm` 共享实现 + `first-prompt`/`all-prompts` 薄插件 | 客户端标题 UI |
| 遥测 | `SessionTelemetryBackend` + `SessionTelemetrySink`（`session-telemetry`） | `session-telemetry-otel` | 反馈、关闭排空 |

共同模式：
1. **SD 只声明词汇与契约，零实现/零默认规则**（telemetry 的 redaction 规则、storage 的路由表都是 consumer/provider 配置，不是 hub 默认）；
2. **注册是 effect**（disposer 随调用 fiber，HMR 安全；`registerAdapter`/`registerConfigurableProviders`/`sessionProjections.register`/`sessionTitle.register`/`storage.mount` 全部如此）；
3. **Provider 选择是"加载哪个插件包"而非"配置一个开关"**——交换即整包替换，契约由共享测试套件背书（`runPersistenceContract` 等）。

### 6.2 "提供者替换即整体迁移"的代码证据

- **持久化**：两个后端实现**同一个**抽象 `SessionPersistence`（index.ts:84）与 `PersistenceBackend`（coordinator.ts:127），全部写路径编排（串行化、批窗口、recovery、HMR 收养、dispose 排空）在 coordinator 一份代码里；换后端 = 换 `ctx.sessionPersistence` 的注册插件，消费方（loop、投影缓存 `ctx.sessionPersistence.readFrom`、session-query）不改一行。契约测试 `tests/contract.ts` 两端共用。
- **LLM**：`GenerateOptions.provider` 选择 adapter 实例，`ctx.llm.registerAdapter([…])` 一次注册；`llm-deepseek` 与 `llm-pi-ai` 通过不同内部（自研 fetch+SSE vs 库封装）满足同一 `StreamChunk` 契约与 `attributionHeaders()` 义务（index.ts:174-179 注释明言）。`LlmRuntime.prepareCall` 保证一次调用跨"解析→日志→dispatch"绑定同一注册，替换不会混配（index.ts:779-814）。
- **replay 隔离**：`forAdapter`（index.ts:823-836）只把 `replayState` 交给"同时拥有历史与目标路由的同一 adapter 实例"——迁移到新 provider 后，旧 provider 的私有重放状态自动失效、降级为 provider 中立内容，**而不是**让新 provider 猜旧 provider 的私有格式（契约: "Never infer native replay from provider/model names alone"，cookbook :33）。
- **投影**：域插件只贡献纯数学（init/apply/view），框架拥有订阅、水印缓存与通知；"framework drives, domain computes"（session-projection/src/index.ts:1-11 注释）——换/增一个投影单元不影响驱动与载体。
- **storage**：hub 无 IO、domain 层路由由配置决定（`Config.backend`/`routes`），workspace 等 consumer 只依赖 `ctx.storageDomain` 而不触碰后端——`json` ↔ `sqlite` 后端替换对 consumer 透明。

进一步证据：

- **拦截点即迁移钩子**：`llm/stream` 是 waterfall 而非 emit——`llm-retry`（`packages/llm/llm-retry`）这样的横切关注点作为 waterfall listener 挂载，与 provider 选择正交；"换 provider"不重写重试/回放/路由逻辑，只是换 `next()` 末端接的 adapter（index.ts:64 声明注释："retry, replay, routing"）。同理 `session-telemetry/record` waterfall（脱敏）与 telemetry provider 解耦。
- **共享契约测试套件是迁移的"证明层"**：`session-persistence/tests/contract.ts`（`runPersistenceContract`）与 `storage/storage/tests/contract.ts` 对每个后端运行同一套断言；新增后端 = 实现契约 + 跑过套件，消费方无需重新验证语义。cookbook 亦要求新 adapter 遵守同一协议义务清单（docs/cookbook/adding-an-llm-adapter.md:25-35）。
- **冷读复用共享同一份"迁移后正确"的重建**：`prepare`/`inspect` 共享 coordinator 的 prepared LRU（`SessionPreparations`，默认 5），历史读取与 resume 复用一次读/解压/校验/冻结/Session 构建（persistence.md:19）——语义正确性在一个点构造，而非每个 consumer 各造一份。
- **可重建性承诺**：loop 请求是会话日志的纯函数（`markAgentLoopRequest` + 深冻结），`EpochHeader` 记录调用配置与 adapter 默认标记（llm-streaming.md:618-626）——这使"重放历史"（`llm-replay` 测试支持）与"换后端后重建请求"成为同一机制，进一步降低迁移成本。

一句话总结：**DSH 把"能力"建模为"一个可声明合并的类型面 + 一个注册即生效的 effect 生命周期 + 一组可被共享测试套件证明的契约"，任何一端的替换都不穿过抽象边界泄漏到另一端。**

---

## 7. 关键代码片段摘录（每段 ≤25 行）

**① StreamChunk 线协议（`packages/llm/llm/src/types.ts:312-324`）**

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    replayState?: ReplayEnvelope
  }
```

**② LlmAdapter 契约（`packages/llm/llm/src/index.ts:180-233` 节选）**

```ts
export abstract class LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

**③ DeepSeek usage 翻译：不相交计数（`packages/llm/llm-deepseek/src/translate.ts:53-62`）**

```ts
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}
```

**④ SQLite 原子追加（`packages/session/session-persistence-sqlite/src/index.ts:284-302`）**

```ts
async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
  await this.ready
  const insertEvent = this.db.prepare(
    'INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  this.db.exec('BEGIN')
  try {
    if (!isMaterialized) this.writeRow(meta)
    for (const event of events) {
      const [surfaceSeqs, surfaceOp, ignorable] = envelopeBindings(event)
      insertEvent.run(meta.id, event.seq, event.type, event.time, JSON.stringify(event.data), surfaceSeqs, surfaceOp, ignorable)
    }
    this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(meta.id)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}
```

**⑤ ProjectionDefinition 与驱动（`packages/session/session-projection/src/index.ts:42-74, 405-425` 节选）**

```ts
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  key: K
  schema: ZodType<SessionProjectionMap[K]>
  init(): S
  apply(state: S, event: SessionEvent): S   // 无关事件必须返回同一引用（Object.is → 零下游工作）
  view(state: S): SessionProjectionMap[K]
  stateVersion: number
}
// drive：每个已提交事件 → 每个单元 apply；引用变了 → schema 校验后通知
private drive(session: Session, event: SessionEvent): void {
  for (const registration of this.registrations.values()) {
    let cell = registration.cells.get(session)
    if (cell === undefined) {
      cell = this.buildCell(registration.def, session.events.slice(0, event.seq))
      registration.cells.set(session, cell)
    }
    const next = registration.def.apply(cell.state, event)
    const changed = !Object.is(next, cell.state)
    cell.state = next
    cell.observedSeq = event.seq
    if (changed && this.listeners.size > 0) { /* schema.parse(view(next)) → 通知 */ }
  }
}
```

---

## 8. 附：研究时使用的主要源码与文档清单

- `packages/llm/llm/src/{types,message,content,assembler,index,adapter-failure,error,attribution,call-config,retry-policy,api-key}.ts`
- `packages/llm/llm-deepseek/src/{adapter,serialize,sse,translate,index}.ts`
- `packages/llm/llm-pi-ai/src/{adapter,index}.ts`（快速浏览）
- `packages/llm/token-meter/src/{index,usage-projection,breakdown-projection,estimate,types}.ts`
- `packages/session/session-persistence/src/{index,coordinator,write-behind,revision,preparations}.ts`
- `packages/session/session-persistence-jsonl/src/{index,format}.ts`
- `packages/session/session-persistence-sqlite/src/{index,schema}.ts`
- `packages/session/session-projection/src/{index,types}.ts`、`session-projection-cache/src/{index,spec}.ts`
- `packages/session/session-title/src/index.ts`、`session-title-llm/src/index.ts`、`session-title-first-prompt-llm/src/index.ts`
- `packages/session/session-telemetry/src/index.ts`、`session-telemetry-otel/src/index.ts`
- `packages/storage/storage/src/{index,backend,registry}.ts`、`storage-domain/src/{index,spec,domain,events}.ts`、`storage-json/src/unit.ts`、`storage-sqlite/src/schema.ts`
- `packages/core/session/src/types.ts`（SessionHeader / SESSION_FORMAT_VERSION）
- `docs/subsystems/{llm-streaming,persistence,session-projection,token-meter,session-title,session-telemetry,storage}.md`、`docs/cookbook/adding-an-llm-adapter.md`、`docs/capability-seams.md`

---

## 9. 关键权衡速查表（供后续研究者）

| 主题 | 决策 | 代价/理由 | 出处 |
|---|---|---|---|
| StreamChunk 封闭联合 | 新增变体编译期迫使全部消费者处理 | 协议演进要过编译关 | `llm/src/types.ts:312` |
| tool arguments raw JSON | 端到端不解析 | 流式片段可任意切分，解析归 adapter 收口 | `types.ts:84`、cookbook:30 |
| `prompt_tokens` 减出缓存命中 | 不相交计数 | 计费输入 = 三桶之和，避免双计 | `llm-deepseek/src/translate.ts:53` |
| `max-tokens` 丢弃全部 tool-call | 截断调用不安全 | 一处 keep/drop、content 与 replay 同剪 | `llm/src/assembler.ts:133` |
| 一次 adapter 调用 = 一次尝试 | adapter 关闭库内重试 | agent 级恢复另开编号 turn | llm-streaming.md:234 |
| 持久化批窗口默认 200ms | 有意的等待有上界 | 只约束调度等待，不约束后端延迟 | `coordinator.ts:30`、persistence.md:11 |
| 懒物化到首次 append | 从未 append 的会话零残留 | 列表面向物化会话 | `persistence/src/index.ts:126` |
| 冷恢复保留中断 turn | 单 turn 可能巨大，事件已持久化 | 只合成缺失 closers，不截断 | persistence.md:13-15 |
| SCHEMA_VERSION 与 SESSION_FORMAT_VERSION 正交 | 表布局 vs 事件词汇分开版本化 | 库级迁移与日志级迁移各自演进 | `sqlite/src/schema.ts:20`、`core/session/src/types.ts:56` |
| 投影单元必须同步 + state 必须 plain JSON | 载体的致性切面不被撕裂 | 持久化缓存前置条件 | `session-projection/src/index.ts:38-41` |
| 整值事件规则 | 状态事件带完整 post-change 状态 | 迁移廉价、服务值自描述 | `session-projection/src/index.ts:13-15` |
| 缓存行 identity 绑定 `{createdAt, cwd}` | id 复用/换 store 不污染 | 旧记录整体丢弃，零 I/O 但绝不错误 | `session-projection-cache/src/index.ts:291` |
| 投影缓存写 fail-soft | 丢写 = 更长的尾重放 | 缓存是折捷径，不是权威 | `session-projection-cache/src/index.ts:8-12` |
| storage 域路由是插件配置 | hub 不做全局选择 | 每个 domain 选自己的介质 | `storage-domain/src/index.ts:46-57` |
| 全局 schema 拒绝 null | null 是"从未写"哨兵 | 可空全局无法 round-trip | `storage-domain/src/spec.ts:91` |
