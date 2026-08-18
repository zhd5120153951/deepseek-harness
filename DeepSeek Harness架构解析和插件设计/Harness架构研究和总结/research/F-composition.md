# F. DeepSeek Harness 组合 / 交互 / 扩展体系研究报告

> 研究范围：bundle / boot / preset / interaction / extensions / hooks / acp / settings / credentials / workspace / python / examples。
> 仓库根：`E:\WorkSpace\LLM_Projects\deepseek-harness`。所有引用均为仓库内相对路径（`packages/...`、`docs/...`、`examples/...`、`python/...`）。
> 分工说明：本报告侧重 **cordis.yml 组合语义、patch 机制本身、审批/权限/命令/问人、动态 Cordis 插件、Hook 桥、ACP、设置/凭据、Python SDK 与示例**；plugins 树的启动审计（`assertEntriesLoaded`/`assertEntriesActivated`/`boot()`）只做衔接性引用，细节归 C2 报告。

---

## 0. 一句话摘要

DSH 把"整个产品"表达为一张**可叠加的插件行（entry）列表**：`profile`（用户目录，声明 bundle 列表）→ `bundle`（npm 包，导出 `cordis.patch.yml` 补丁层）→ `patch`（按 id 整行替换/插入/禁用行的 YAML 操作列表），由 `app-boot` 用同一个 `applyEntryPatches` 调用把所有层拍平成一个 entry 列表交给 Cordis Loader 启动；审批是 `ctx.approval` 上的 waterfall 决策缝，权限预设把 sandbox 模式与审批策略打包成用户可见开关；`tool-cordis` + `cordis-host-runner` 让 agent 能在运行时给自己定义/安装/卸载 Cordis 插件（Host 半在 `node:vm` 沙箱、Client 半在浏览器）；Claude Code / Codex 的 `hooks.json` 通过 hook-protocol 桥接进 DSH 的扩展点事件；ACP 服务器把外部自动化客户端接到 `ctx.agents`；Python SDK 通过 JSON-RPC stdio 驱动捆绑的运行时子进程。

---

## 1. 组合模型：profile / bundle / patch

### 1.1 三个概念的精确语义

| 概念 | 载体 | 语义 |
|---|---|---|
| **profile（画像）** | `$DSH_HOME/profiles/<name>/` 目录，含 `package.json`（`dsh.profile.bundles` 列表）与 `cordis.patch.yml`（用户自己的 patch 层） | 一个**可命名、可复用的部署组合**，由 `dsh --profile <name>` 选择（`packages/boot/app-boot/src/profile.ts:104-111` 校验目录名：拒绝空名、路径分隔符、`.`/`..`/`node_modules`） |
| **bundle（包）** | npm 包，manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（`profile.ts:41-45`） | 一个**发布单元**：导出"一批 patch 操作"，作为叠加的一层。`dsh-base` 是每个 profile 的第一层 |
| **patch（补丁）** | 顶层 YAML 数组，元素是 loader patch entry：`{ id, config }` 覆盖、`{ id, disabled: true }` 禁用、`insert:` 列表插入新行 | 对**目标 entry 行**的**整行替换**或新增；同一个 id 后写者胜（last-write-wins per row） |

三者关系一句话：**profile 是有序 bundle 列表 + 用户 patch 层；bundle 是"打包成 npm 包的一层 patch"；patch 是唯一真正修改 entry 列表的操作原语**。组合 = 空 entry 根 + 按 `dsh.profile.bundles` 顺序应用每层 patch + 用户 profile patch + home patch + `--patch` overlay（`apps/cli/src/dump-config.ts:30-52` 展示了完整层序）。

### 1.2 dsh.profile / dsh.bundle 字段如何被 app-boot 消费

`packages/boot/app-boot/src/profile.ts`：

- `DshBundleManifest`（`profile.ts:42-45`）：`{ patch: string }`——bundle 导出的 patch 文件路径（相对包根）。`loadProfile`（`profile.ts:371-403`）对 `bundles` 里的每个包名：`resolveBundleDir` → 读其 `package.json` → **`declared === undefined` 直接抛错**（"declares no dsh.bundle"）→ 解析 patch 文件。命名了一个 bundle-less 包作为 layer 是 misconfiguration，不是"没有补丁"。
- `DshProfileManifest`（`profile.ts:48-51`）：`{ bundles?: string[] }`——**有序** bundle 层列表。`loadProfile` 里 `manifest.dsh?.profile?.bundles ?? []` 缺失则空。
- 消费路径：`loadProfile`（`profile.ts:371`）→ `composeEntries`（`profile.ts:413-420`，`applyEntryPatches([], layers.flat(), warn)`）→ 与 `boot()` 里 `mountRootInclude`（`packages/boot/app-boot/src/index.ts:486-529`）走**同一个 `applyEntryPatches` 调用**，保证 dump 与真实启动结果完全一致。
- 内置模板（`profile.ts:113-117`）：`web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`、`headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']`；`initProfile`（`profile.ts:152-168`）首次使用自动初始化目录：manifest（`dependencies: {}` + `dsh.profile.bundles`）、空 patch 模板（`PROFILE_PATCH_TEMPLATE`，`profile.ts:127-131`，注释教导"顶层 YAML 数组、可含 `!!js`"）、`pnpm-workspace.yaml`（hoisted 链接器 + `autoInstallPeers: false`）。已存在文件绝不覆盖，重跑是 no-op。
- 安装属主归一化（`normalizeShippedProfile`，`profile.ts:297-312`）：若 profile 的 bundle 列表恰好等于安装属主元组（如 headless 的 `['dsh-base','dsh-web-app','dsh-headless']`，`profile.ts:120-122`），自动改写成当前模板，**其余字段全部保留**——升级后旧安装属主值被修正而用户字段不丢。
- 模块解析是**双锚点**：bundle 名先装 dsh 安装（launcher 自身包），再查 profile 目录（`resolveBundleDir`，`profile.ts:344-355`）；`healProfilesModuleFallback`（`profile.ts:223-255`）维护 `$DSH_HOME/profiles/node_modules` 平铺符号链接（BFS 整个依赖闭**含 peerDependencies**，因为 Service Definition 包常是实现的 peer），让 profile 外插件也能按 Node 父目录上溯解析到安装内的 cordis 单实例。`ensureSymlink`（`profile.ts:171-202`）把非符号链接的占位路径当作硬错误（"remove it so dsh can manage the installation fallback"）。

### 1.3 patch 语义细节（"整行替换，无深合并"）

- patch 替换的是目标行的**整个 `config`**，不做深合并——base README 明确写 "A patch replaces a row's whole `config`"（`packages/bundle/base/README.md:5`、`cordis.patch.yml:6-10`）。因此**按模式区分的值必须住在模式 bundle 里**，base 只放"共享身份 + 中性默认值"。
- 同一文件内行序无加载语义（激活是服务可用性驱动），分组只为读者（`cordis.patch.yml:12-13`）。
- `!!js` 表达式：Include 的 YAML 方言把 `!!js` 标量解析成表达式节点，Loader 在目标 entry 激活时对 `config` 求值（注入激活后、针对该插件 context），`disabled` 字段在每次挂载决策时对 loader context 求值（`docs/cordis-primer.md:36-38`）。base patch 大量用它做平台门控：`disabled: !!js process.platform === 'win32'`（`cordis.patch.yml:178-186`）与 `config.policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"`（`cordis.patch.yml:190-191`）；web 的 `tools.mode: !!js process.env.DSH_TOOLS_MODE`（`packages/bundle/web-app/cordis.patch.yml:35-41`）。
- **用户层热更新**：`watchUserPatches`（`packages/boot/app-boot/src/index.ts:232-265`）通过 Cordis HMR `registerConfig` 监听 profile 的 `cordis.patch.yml`，改动后事务性 `entry.update()` 重放用户层；`compose` 选项允许把新用户层**插回原组合位置**（bundle 层之下、overlay 之上）——"组合是活的"。
- `loadOptionalPatches` vs `loadOverlayPatches`（`index.ts:278-306`）：用户层缺失 = 无此层；而**被点名**的 overlay（bundle patch、`--patch`）缺失 = 抛错。patch 文件存在但不可解析/非数组 = 启动即抛（`parsePatchList`，`index.ts:320-338`）——misconfiguration fails loud。单条 patch 未命中目标行仍是**逐条 Loader 警告**（一个 overlay 跨多个 surface 时不必匹配每棵树）。

### 1.4 `--dump-config` 输出什么

`apps/cli/src/dump-config.ts:30-52`：`dsh --profile <name> --dump-config`（`apps/cli/src/bin.ts:45-46`）**不启动、不求值 `!!js`**，只做离线组合：加载 profile 的 bundle 层 + 用户层 + home patch + `--patch` overlays，然后 `renderConfigDump`（`packages/boot/app-boot/src/index.ts:379-473`）以**同一 patch 算法、分快照逐层 diff**，输出：

- 一个可加载的 YAML entry 文档（`!!js` 原样打印）；
- 每段连续行前有 `# == <来源文件>, patched by <层1, 层2>` 注释，标注每行来自哪个文件、被哪些层改过（`groupedDump`，`index.ts:445-473`）——provenance 是"快照逐层 diff"出来的（`index.ts:411-440`），因为 patch 算法只原地改写或追加，顶层索引可跨快照稳定标识一行；
- 对未命中任何行的 patch 经 `warn` 报出（与 Loader 启动警告一致）。
- `--dump-default-config`（`defaultOnly`）跳过用户层与 overlays，作为"用户 patch 已坏"时的恢复诊断（`apps/cli/src/dump-config.ts:24-28`；`profile.ts:366-369` 的 `userLayer: false`——bundles-only 消费不可能被坏用户层卡死）。

### 1.5 一个 bundle 的 cordis.patch.yml 长什么样（base bundle）

`packages/bundle/base/cordis.patch.yml`（451 行）是**单次 `insert`**（`cordis.patch.yml:15-451`），在空根上插入约 90 行：timer/hmr、llm/session/typert 注册表、session-title、user-questions、agent + agent-default-model（`provider: deepseek-official, model: deepseek-v4-flash`）、jobs、settings（`dsh-settings-file`）、credentials（`dsh-credentials-local`）、llm-pi-ai 休眠双子、session-persistence-jsonl（`root: !!js dshHomePath('sessions')`）、attachment-local、session-query-sqlite（`openAt: never`）、session-projection、session-telemetry-otel（`DSH_TELEMETRY_MODE` 门控）、subprocess、sandbox/sandbox-policy（`DSH_PERMISSION_MODE ?? 'workspace-write'`）、bash/pwsh 平台双胞胎、approval（policy 表达式）、permission（预设表 `read-only/workspace-write/danger-full-access`）、shell-env、tool-bash/tool-pwsh、tool-jobs、fs-observation-policy、tool-fs、agent-instructions、skill 族、commands、goal 族、plan-mode、token-meter、compaction、subagent 族（spawn/fork/control/report）、workflow、timeout-policy、spill、checkpoint、tool-todo、tool-goal、tool-ralph、tool-str-replace-editor、repeat-tool-reminder、web/web-search-deepseek/tool-web，以及"每模式都挂、值由 overlay 决定"的行：tools（presentation 模式）、system-prompt（`persona: ''`）、agent-loop（`agents: []`）、fs-sandbox、llm-deepseek（"No key or endpoint is inlined"）。

base 的 package.json（`packages/bundle/base/package.json:36-40`）用 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明导出；依赖列表声明了 patch 里每一行的包（"bundle 列出它要装的行"）；**bundle 无运行时 API**，profile composer 只通过 manifest 字段解析 patch，"never through code"（`README.md:5`）。

> 代码片段 1 —— 叠加顺序与组合（`packages/boot/app-boot/src/profile.ts:113-117, 413-420`）：
> ```ts
> export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
>   web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
>   headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
> }
> ...
> export function composeEntries(
>   layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
> ): EntryOptions[] {
>   return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
>     let index = 0
>     warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
>   })
> }
> ```

### 1.6 模式 overlay 示例（web-app / headless）

- `packages/bundle/web-app/cordis.patch.yml:1-80`：在 base 之上**按 id 覆盖**（`system-prompt` 换 persona、`hmr` disabled、`session-query-sqlite` 重申内存值、`tools.mode` 读 `DSH_TOOLS_MODE`），再 `insert` web-only host 行（code-runtime、storage/storage-json/storage-domain、message-feedback、session-log-download、workspace、session-projection-cache…）。注释明确 "Rows here override base rows by id, with the profile's own cordis.patch.yml and any --patch overlays still to come"。`dsh.client` 行是浏览器 roster，modules node 半扫描进 `window.__DSH_BOOT__`。
- `packages/bundle/headless/cordis.patch.yml:1-35`：覆盖 persona、禁 hmr，insert code-runtime + headless-startup + headless-runner（`task: !!js ctx.headlessStartup.task`）——headless 是"one-shot task mode directly over dsh-base"，无 Host/HTTP 服务器/浏览器插件。
- **平台门控的完整配方约束**（`packages/bundle/base/README.md:7`）：bash 与 pwsh 两族都注册同名 `bash` 服务，Win 上要还原 bash 必须同时禁用 pwsh 族并重新启用 bash 族，否则启动时失败 loud；`fs-sandbox` 与 `dsh-fs-local` 并存会双重注册 `ctx.fs` 而加载失败。

### 1.7 启动期的环境分层与快照

`packages/boot/app-boot/src/index.ts`：

- `loadEnv`（`index.ts:78-90`）/ `loadLayeredEnv`（`index.ts:177-198`）：继承环境 > 调用目录 `.env` > Harness-home `.env`；**先全量解析校验再应用**（一个文件拒绝时不会留下另一个已应用），且不覆盖更高优先级的值；返回 `LaunchEnvironmentSnapshot` 记录每值的来源层。
- **bootstrap 变量保护**（`index.ts:92-128`）：`.env` 不得设置 `PATH`/`NODE_OPTIONS`/`LD_PRELOAD`/`PYTHONPATH`/`GIT_*`/代理/CA/`DSH_*`/`XDG_*` 等——"it decides how this process starts, where its code and instructions load from, or how it reaches the network"，违反即抛（`readEnvLayer`，`index.ts:139-164`）。
- 快照重放：`resolveConfigPath`（`index.ts:61-69`）在 `$DSH_SNAPSHOT=replay` 时把 `cordis.yml` 换成同目录 `cordis.snapshot.yml`——重放用固化组合，与实时组合解耦。

### 1.8 profile 使用流程（`dsh plugin` 命令与错误导向）

组合的操作面是 CLI 的子命令族（`apps/cli`）：`dsh plugin --profile <name> add <package>` 创建 profile 并加 bundle、`dsh plugin --profile <name> install` 安装其依赖、`dsh --profile <name>` 启动。错误信息本身就是"组合教学"：

- 未知 profile：`profile X does not exist; create it with 'dsh plugin --profile X add <package>'`（`profile.ts:379-381`）；
- bundle 无法解析：`cannot resolve profile bundle ... run 'dsh plugin --profile <name> install' if its dependency is not installed`（`profile.ts:351-354`）；
- bundle 无 `dsh.bundle`：直接抛（`profile.ts:392-394`）。

这印证了 §1.1 的语义：profile 不是隐式约定的目录，而是**显式清单（manifest）+ 显式层（patch）**的可组合单位；`dsh plugin` 只是清单与依赖的管理器。

### 1.9 启动审计（衔接 C2 报告）

`boot()`（`index.ts:757-802`）：建 `Context` → 提供 `dshHomePath` → 装 Loader → `prepare`（宿主准备，失败标签 "host preparation failed"）→ `mountRootInclude`（`index.ts:486-529`，`cordis:include` 内置 + `cordis:group` 内置，pin 固定 id `'include'`）→ `loader.await()` 等树 settle → `assertEntriesActivated`（`index.ts:692-725`：无 fiber 的启用行、failed 行、pending 行（列出未满足的 inject 服务）全部拒绝）→ 返回根 ctx。`installFailLoud`（`index.ts:609-649`）兜底晚到的 unhandled rejection（释放终端后 exit 1）。这与 preset 挂载审计（§4 前）共用"无 fiber 即失败"的哲学。

---

## 2. 审批与权限

### 2.1 `ctx.approval` 契约

Service Definition：`packages/interaction/user-approval/src/index.ts`（`ApprovalService extends Service`，`index.ts:192`）。类型（`types.ts`）：

- `ApprovalRequestId = Branded<'ApprovalRequestId'>`（`types.ts:14`），配对审计事件，且不与 tool-call/agent/session id 互换（品牌化隔离）。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`types.ts:29`）——**闭集且 fail-closed**：唯一放行是 `allowed-once`，且只针对被问的那一个动作（一次授权）。
- `ApprovalRequest`（`index.ts:153-174`）：`{ agent, toolName, callId?, reason?, signal? }`——**刻意不含工具参数**（`callId` 让 UI 把问题挂到已流式展示的工具调用上，避免第二份可漂移的副本）；`signal` 中止即撤销问题（`cancelled`，迟到答案被丢弃）。
- `ApprovalPolicy = 'ask' | 'never'`（`index.ts:94`）：`ask`（默认）委托给组合的答案者链，无答案者时 fail-closed 为 `unavailable`；`never` 在**任何 dispatch 之前**确定性返回 `rejected`（CI/无人值守姿态）。

### 2.2 per-session 策略：日志即状态

策略覆盖是**持久化会话事件** `approval/policy`（`index.ts:67-71`，log-only、可重放、不进模型 transcript，`source: 'delegation'` 标记子代理播种的覆盖）；`effectiveApprovalPolicy`（`index.ts:112-118`）从事件日志**倒序折叠最后一个** switch，无则用插件配置默认（`effectivePolicy`，`index.ts:285-287`）——"重放日志就是状态，恢复不需要 catch-up 机制"。`setApprovalPolicy`（`index.ts:142-147`）是唯一写路径（非法值先抛）。`setPolicy`（`index.ts:226-237`）切实时 agent 的策略并 `agent.inject()` 一条用户消息让模型下一轮看到切换。策略同时进入 **system prompt runtime-context 快照**（`index.ts:204-216`，`NEVER_SENTENCE`/`ASK_SENTENCE`——注意本会话当前就是 `never` 姿态）。

### 2.3 approval/request waterfall 与答案者

- 事件：`'approval/request'(this: Scoped<ApprovalService>, req, next)`，`@mode waterfall`（`index.ts:30`）——around-middleware：答案者返回 outcome 即"认领"该请求，或调 `next()` 委托；**scope 过滤**（`@deepseek-ai/dsh-scope`）让 agent 作用域内的监听者只收到该 agent 的问题；无监听者时服务兜底 `'unavailable'`。
- `request()`（`index.ts:257-276`）前置条件：**必须在打开的 turn 内**（审计对必须被 turn 的 commit/replay 边界包裹，`hasOpenTurn`，`index.ts:127-134`——turn 外 append 的裸事件在重载时与崩溃尾巴不可区分、会被静默丢弃）；流程：append `approval/asked` → `decide()` → append `approval/decided`（任一 append 失败即拒绝整个请求，绝不返回未入账的决定）。
- `decide()`（`index.ts:304-344`）的 fail-closed 工程：signal 已中止 → `cancelled`；`never` 策略在**服务自身**判定（注释解释了为什么 gate 不能是监听者形态——`prepend: true` 后注册的监听者会排在 gate 监听者之前，只有服务自己的 request 路径能守住"never 无条件拒绝"的承诺）；`ctx.waterfall(scopeTarget(this, agent), 'approval/request', req, () => 'unavailable')` 兜底；**同步抛出的监听者也落入同一拒绝路径**（`Promise.resolve().then(...)` 先行包裹）；异常/越界返回值统一归一为 `unavailable`（闭集 switch 不被污染）；abort 竞速获胜时迟到的答案被丢弃（settled-promise no-op）。

> 代码片段 2 —— fail-closed 的 waterfall 判定（`packages/interaction/user-approval/src/index.ts:304-329`）：
> ```ts
> private async decide(req: ApprovalRequest, session: Session): Promise<ApprovalOutcome> {
>   const signal = req.signal
>   if (signal?.aborted) return 'cancelled'
>   // The 'never' policy is decided HERE, before any dispatch: a listener
>   // registered with `prepend: true` after this service mounts would sit
>   // ahead of any gate LISTENER, so a listener-shaped gate cannot keep the
>   // documented promise that 'never' rejects deterministically regardless
>   // of registration order — only the service's own request path can.
>   if (this.effectivePolicy(session) === 'never') return 'rejected'
>   const answer: Promise<ApprovalOutcome> = Promise.resolve().then(
>     () => this.ctx.waterfall(
>       scopeTarget(this, req.agent), 'approval/request', req,
>       () => Promise.resolve<ApprovalOutcome>('unavailable'),
>     ),
>   ).then(
>     outcome => OUTCOMES.includes(outcome) ? outcome : 'unavailable',
>     () => 'unavailable',
>   )
>   ...
> }
> ```

### 2.4 答案者实例（谁在回答）

- **Web/UI 答案者**：`packages/host/apiproxy/src/api-proxy.ts:1391-1449`——监听 `approval/request`，为每个问题 mint `RpcId` 入 pending 表、向浏览器广播问题帧；用户点击后 `approval/resolved` 回填 settle。要点：`signal.aborted` 同步 settle `cancelled`（避免微任务窗口里注册 abort 监听器太晚导致僵尸帧）；在日志里**对称配对** audit id——并行工具调用时多个 `approval/asked` 可能先于任何答案者入账，它倒序遍历会话日志找"最新未决、未被其他 pending 认领、callId 匹配"的 `asked` 记录（`callId` 有/无两臂互不偷窃）；网关销毁时把所有 pending settle 为 `cancelled`。
- **ACP 机器答案者**：见 §5.3（一次性 allow/reject，只对本桥拥有的 agent、只对有 `callId` 的问题）。
- **fail-closed 调用方**：`dsh-tools` 的工具执行管道、`dsh-tool-bash`/`dsh-tool-pwsh`/`dsh-tool-fs` 等在需要时调 `ctx.approval.request`，结果不是 `allowed-once` 即拒绝执行（`docs/subsystems/approval.md:5`）。

### 2.5 audit 事件

会话日志记录成对事件（`index.ts:44-58`）：`approval/asked { id, toolName, callId?, reason? }` 与 `approval/decided { id, outcome }`——**log-only（同 `hook/*`，非 surface 事件，不带 `surfaceOp`）**，不进模型 transcript；"每次 ask 恰好一条 decided"由服务保证。`approval/policy` 是第三类持久事件（策略覆盖）。模型学到的策略来自 runtime-context 快照与切换通知，而不是这些日志行。

### 2.6 permission-presets：把"模式 + 审批策略"打包成用户可见预设

`packages/interaction/permission-presets/src/index.ts`（`PermissionPresetService`，`index.ts:159`）：

- **预设表** `Config.presets: Record<string, PresetSpec>`（`index.ts:140-152, 161-178`），默认两条：`workspace-write`（`sandbox: workspace-write` + `approval: ask`）与 `danger-full-access`（`danger-full-access` + `never`）——base patch 里同样配置（`packages/bundle/base/cordis.patch.yml:193-205`）。`PresetSpec = { sandbox, approval, name?, description? }`（`index.ts:55-64`）——name/description 是**用户可见**呈现（web 选择器的 label 与一句说明）。
- **不拥有执法权**：执行、prompt 叙述、重放都继续读各自的 knob 折叠（sandbox 模式来自 `dsh-sandbox-policy`，审批策略来自 `dsh-user-approval`）；预设切换只是"记录意图 + 通过每个 knob 的 canonical setter 写入变化值"（`apply`，`index.ts:380-392`——只有 effective 值变化的 knob 才写）。
- **加载期 misconfiguration fails loud**（`index.ts:189-200`）：表项占用保留名 `custom` 抛错；`ctx.shell` 不约束（无 `sandboxMode` capability fact）抛错——"presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration"；组合默认不匹配任何预设且未显式 `defaultPreset` 抛错。
- **当前值与派生 `custom`**（`derive`，`index.ts:309-321`）：从 knob 折叠推导（而非只读自己的事件）；仍匹配的最近一次选择在共享 bundle 平局时胜出，否则按声明序第一个表项，都不匹配 → `CUSTOM_PRESET`（仅可显示，永不可切换/入事件）。`permission/preset` 事件的存在意义正是"两个预设共享同一 bundle 时保留用户选了哪一个"（`docs/subsystems/permission-presets.md:68`）。
- **读侧 projection**：`permissions` 会话投影单元（`index.ts:243-252`），折叠三个 whole-value knob 事件（`permission/preset`、`sandbox/mode`、`approval/policy`；`applyKnobEvent`，`index.ts:113-124`——不感兴趣的事件返回同引用，作为注册表的 change gate），视图是 `PermissionSelect { options, currentValue }`（`types.ts:27-32`）；key 声明唯一住在 `types.ts:34-43`（`SessionProjectionMap` 合并），包根与 `./client` 两个命名空间投影复用同一份类型（浏览器类型链不加载 host 值导入）。
- **写侧命令**：`/permission` 人类命令（`index.ts:257-277`，注入 `commands` 才激活；空参数报当前预设与可用列表、未知名报 error text）。
- **设置默认**：settings namespace `permission`（`index.ts:73, 208-218`），`defaultPreset` 约束为表项常量（zod union of const），`setSource` 让注册后的改动即时生效于新建会话。
- **新会话播种**（`pinInitialPermission`，`index.ts:400-430`）：全新会话用用户设置默认预设；已播种/部分初始化会话只补缺失事实，不覆盖已有 knob。

### 2.7 预设的两个 knob：sandbox 模式与审批策略

预设把两个**独立执法 knob** 打包：`sandbox/mode`（来自 `dsh-sandbox-policy`，`SANDBOX_MODES = read-only | workspace-write | danger-full-access`）与 `approval/policy`（§2.2）。knob 语义：执行、prompt 叙述、重放各自读自己的折叠（`effectiveSandboxMode`/`effectiveApprovalPolicy`），**预设自身不执法**（`docs/subsystems/permission-presets.md:5`）。sandbox 模式的实际边界由 `dsh-sandbox-local`/`dsh-fs-sandbox` 兑现：`workspace-write` 把写限定在工作区 + 会话私有临时子目录（`<temp>\dsh-<hash>`，Win 上 TMP/TEMP 对受限子进程重写；`packages/bundle/base/README.md:22`），`read-only` 零授予。`permission/preset` 事件（`index.ts:50`）是**持久化、log-only 的用户意图**：不进模型 transcript（knob 事件通过各自消费者拥有模型可见后果），只在两个预设共享同一 bundle 时保留"用户选了哪个"。

### 2.8 权限面的会话投影：`permissions` select

`permissions` 投影 key（`types.ts:34-43`）把"当前预设 + 可切换列表"作为**派生视图**（`selectFor`，`index.ts:329-338`）暴露给浏览器：`options` = 表序全部预设 + 仅在当前为 `custom` 时追加 `custom` 项；`currentValue` = 派生结果。投影单元状态是三个 knob 事件的折叠（纯 JSON，持久化缓存前置条件，`index.ts:94-104`），key 缺席 = 无权限服务组合 → 客户端隐藏控件。这展示了 DSH 的"**读侧投影 / 写侧命令 / 域事件**"三层模式：同一次切换，`permission/preset`+knob 事件承载持久事实，投影承载 UI 视图，`/permission` 命令承载写入口。

---

## 3. 命令与问人

### 3.1 `ctx.commands`：人类命令注册与直接调度

`packages/interaction/commands/src/index.ts`（`CommandRuntime extends TypertRemoteService`，`index.ts:225`）：

- **注册**：`register(definition)`（`index.ts:245-252`），`CommandDefinition = { name, description, input?, recordInput?, handler }`（`index.ts:40-55`）；`normalizeDefinition`（`index.ts:151-189`）在注册边界校验名称（`/^[a-z][a-z0-9_-]*$/`）、description 非空、handler 是函数、input hint 合法——坏元数据在到达 UI 协议前被拒；返回精确 disposer。
- **作用域**：`ScopedLayers`（`index.ts:226-229`）——普通 ctx 注册是全局；通过命令注入的 agent ctx 子插件注册的是该 agent 的 shadow（per-agent 变体，`CommandLayer` 的报错信息直接教你怎么做）。
- **解析**：`parseCommand`（`index.ts:102-109`）纯语法拆 `/<name><rawInput>`（rawInput 含分隔空白，原样传递）。
- **调度**：`execute(agent, line, signal)`（`index.ts:297-338`，`@Remote` 暴露给浏览器）——**不发给模型**，直接调 handler；生命周期事件 `command/run`（handler 前）+ `command/done`（settle 后），二者以 `commandId` 配对（`types.ts:88-101`；`commandId` 带 8 位实例 token，resume 日志上不重复，`mintCommandId`，`index.ts:341-344`），直接 log-only append（不包 turn）；语法/名字未命中**不记任何日志**（从未进入 handler）；`recordInput: false` 时 `args` 省略（域事件拥有载荷，如 `/permission` 自己的领域事件）；handler throw/abort 归一为 `kind: 'error'`；abort 通过 `withAbort`（`index.ts:127-148`）终止不配合的 handler。
- **结果契约**：`CommandResult = { kind: 'success', text?, sourceEventSeq? } | { kind: 'error', text }`（`types.ts:19-26`），`normalizeResult`（`index.ts:192-218`）在注册表边界校验并冻结；`sourceEventSeq` 让成功命令指向更早的权威域事件供 UI 渲染富卡。
- **变更通知**：`commands/change` emit 事件（`types.ts:64-74`，registry-subject 不设 filter），`notifyChange`（`index.ts:369-384`）逐监听者隔离失败（非 veto）。
- 消费者示例：`/permission`（§2.6）、`/goal`（`dsh-command-goal`）、`/compact`（`dsh-command-compact`）、`/export`（web）。glossary 定义为"human command——斜杠前缀、由人类面适配器经 `ctx.commands` 解释执行、**不变成模型消息**"（`docs/glossary.md:31`）。

### 3.2 ask-user：暂停工具调用等待人类回答

两层（Service Definition + Consumer）：

- **`ctx.userQuestions`**（`packages/interaction/user-questions/src/index.ts`，`UserQuestionService`，`index.ts:51`）：单活跃 UI provider（`registerProvider`，重复注册抛 `DUPLICATE_PROVIDER`）；`ask(request)`（`index.ts:92-140`）在**请求前**做守卫：
  - signal 已中止 → `ASK_ABORTED`；无问题 → `EMPTY_QUESTIONS`；
  - 带 agent 时必须精确等于 `agents` 注册表里的**当前 live 实例**（`CALLER_NOT_LIVE`——lineage 上的历史实例没人可问）；
  - 且该 agent 不能是别的 live agent 的 owned 子 agent（`DELEGATED_CALLER`——owned child 没有人可问，会永久阻塞；错误信息指导"把未解决的问题折进子 agent 的最终结果"）。**"runtime ownership，而非 durable session lineage"决定边界**：lineage 上继承但作为新 runtime 根恢复的会话可以正常问。
  - `intent` 声明必须指向本问题自己的选项且带 `detail`（`BAD_INTENT`——让 UI 不会展示一个 asker 从未提供的选项或不可见的计划）；
  - 无 provider → `NO_PROVIDER`。
  - 然后 `return this.provider.ask(request)`——**这个 await 就是"暂停点"**：工具执行挂起，直到 UI 返回答案。
- **`ask_user_question` 工具**（`packages/interaction/tool-ask-user/src/index.ts`，`apply`，`index.ts:19-101`）：`defineTool` 注册模型面工具（questions 数组，带 id/header/options/multi_select），`execute` 调 `ctx.userQuestions.ask({ questions, agent: exec.agent, signal: exec.signal })`，把答案按 `{ id, selected[], custom? }` 折回**普通工具结果**进入 agent loop——模型侧完全无感，只是"一个等得比较久的工具"。UI provider（web）渲染问题卡并收集选择/输入。

### 3.3 命令与工具的边界

glossary 明确"human command ≠ model-facing tool ≠ shell command"（`docs/glossary.md:31`）：命令由人类面适配器经 `ctx.commands` 直接执行、不进模型消息；工具是模型面 schema 经 `ctx.tools` 管道执行；shell 命令经 `ctx.shell` 执行。`command/run`↔`command/done` 配对刻意镜像 `tool/call`↔`tool/result` 配对（`types.ts:80-81`），但命令事件**不包 turn**（直接 append，普通 checkpoint 排空），工具事件在 turn 内。`commands/change` 是 registry-subject emit（不设 scope filter）——任何全局/作用域注册变化都可能影响任一 UI 视图（`types.ts:64-74`）。

---

## 4. 动态扩展：agent 自我修改运行时

### 4.1 总览：四个包的分工

- `packages/extensions/cordis-host-runner`：**Host 半**。`ctx.dynamicCordisRunner`（定义注册表 + 生命周期 + vm 沙箱 + 审批/请求往返）+ `ctx.cordisInspect`（只读元数据查询注册表）。
- `packages/extensions/cordis-client-runner`：**Client 半**（浏览器）。源码 → guard → 模块表 → loader entry（`client/runtime.ts`），由 `CordisRunOrchestrator`（`client/orchestrator.ts`）驱动 request-run 往返。
- `packages/extensions/tool-cordis`：**模型面工具**：`cordis_inspect_list / cordis_inspect_query / cordis_inspect_self / cordis_define / cordis_run / cordis_stop / cordis_undefine` + `@pluginId` 上下文注入（`agent/pre-step` 拦截，`packages/extensions/tool-cordis/src/index.ts:381-398`）。
- `packages/extensions/ui-cordis`：浏览器面板（Plugin 卡、define/run 行、`CordisPanel.tsx` 等）。

### 4.2 定义注册表（define）：不可变包 + 版本化

`DynamicCordisRunnerService.define`（`packages/extensions/cordis-host-runner/src/index.ts:151-202`）：

- 一个 **Plugin**（稳定 `pluginId`，`mintPluginId(prefix)` 3-6 位小写字母前缀）拥有若干**不可变 Package**（`packageId`），每个 Package = `{ name, purpose, hostCode?, clientCode? }`；"修改"= 在同一 Plugin 上**追加新 Package**，旧版本永远可回滚（`currentPackageId`/`nextPackageId`/`pluginRunId` 三指针语义见 §4.6）。
- `cordis_define` 只校验参数与语法（`precheckCode` 用 `new Script` 编译不执行，`sandbox.ts:206-214`）并记录源码；**不请求审批、不执行 apply、不改 currentPackageId**——激活是 `cordis_run` 的事（工具描述明确这一点）。
- 会话所有权：Plugin 归属创建它的 sessionId（`owned()` 校验，跨会话引用即 miss；`undefine`/`stop` 的跨会话调用返回可操作的 `plugin-missing` 原因）。

### 4.3 vm 沙箱（Host 半）

`packages/extensions/cordis-host-runner/src/sandbox.ts`：

- `createSandbox`（`sandbox.ts:129-145`）：`node:vm` 新鲜 realm，globals 只有：tagged write-through console（`[cordis:<id>]`，直写宿主 stdout——监听器在 run 调用很久之后才触发，输出必须落在用户看得见的地方）、`harness` 注册助手（`harness.handle/defineTool/registerTool`）、`btoa/atob/TextEncoder/TextDecoder`（新鲜 vm 缺 Web API）、**Node API 陷阱**（`NODE_API_REDIRECTS`，`sandbox.ts:96-108`）：`require/setTimeout/setInterval/setImmediate/clearTimeout/clearInterval/fetch` 被替换成"抛出重定向教学错误"的函数（指向 `ctx.fs`/`ctx.web`/`ctx.bash`/timer 服务）；数据值全局（如 `process`）保持 `undefined`，避免 `typeof process` 探测爆炸；再加 dual-realm `instanceof` 补丁（`sandbox.ts:62-82`，让 VM 值与宿主值互相 instanceof——参数、事件、服务结果跨 realm 传递时不误判）。
- `evaluateHostCode`（`sandbox.ts:227-238`）：把源码作为 `(async () => {...})()` 的函数体在沙箱里 `runInContext`，`timeout: vmTimeoutMs`（默认 5000，仅限**同步**段——async body 会逃出该上限，模块注释明确"在模块的信任姿态下可接受"）；**这不是 containment**："cooperative packages inspectable and disposable"，宿主 realm 助手函数仍是逃生通道。
- `startHost`（`index.ts:883-915`）：`createSandbox(pluginId, { handle })` → evaluate → `isPlugin` 形状校验（`guard.ts`）→ `startHostHalf`（`lifecycle.ts:22-45`）在 runner 的 `cordis-dynamic` group fiber 下以 `guardedPlugin` 包装启动真实 Cordis fiber，挂 `harness.handle` 注册的 Host 方法到 `run.handlers`。**启动失败先 dispose 再抛**（失败 run 绝不残留），并给最常见的"同名已注册"冲突附上 replace 配方教学（先 `cordis_stop` 旧包）。`missingServices`（`lifecycle.ts:55-57`）报告 pending fiber 还等哪些服务。
- 语法错误被专门加工（`syntaxErrorContext`/`parseErrorMessage`，`sandbox.ts:164-194`）：带行号 + 脱字符 + "这是纯 JS 不是 TS"（且只在**出错行**含 `as` 时才提示删类型注解，避免描述文本误伤）+ 括号平衡教学，让模型能自纠后重新 define。

> 代码片段 3 —— vm 沙箱的 Node API 重定向（`packages/extensions/cordis-host-runner/src/sandbox.ts:96-119`）：
> ```ts
> const NODE_API_REDIRECTS: Record<string, string> = {
>   require:
>     'Node modules are unavailable. Use the cordis services on ctx instead — e.g. inject: [\'fs\'] for files, '
>     + '[\'web\'] for HTTP, [\'bash\'] for processes; query Service.listService with cordis_inspect_query first.',
>   setTimeout: TIMER_REDIRECT,
>   setInterval: TIMER_REDIRECT,
>   setImmediate: TIMER_REDIRECT,
>   clearTimeout: TIMER_REDIRECT,
>   clearInterval: TIMER_REDIRECT,
>   fetch:
>     'Network access goes through the cordis web service: declare inject: [\'web\'] and call ctx.web '
>     + '(query Host Service.listService with cordis_inspect_query for its methods).',
> }
> ```

### 4.4 request-run 往返与审批（模型驱动激活）

`run(agent, pluginId, packageId, mode, signal)`（`index.ts:248-312`）是模型工具 `cordis_run` 的入口：

1. `resolvePlan`（`index.ts:768-808`）校验会话所有权、package 存在、`mode` 合法性（`run`=首启/重启/回滚，`update`=切版本；模式不匹配给可操作拒绝，如"already current; use run"）。
2. 无 client 半 → 直接 `activate`（Host 半）。
3. 有 client 半 → `mintApprovalRequestId`，`requiresApproval = !clientVersionUpdatesApproved && !approvedClientPackages.has(packageId)`；`registry.armRequest` 登记 pending；`ctx.emit('cordis/request-run', {...})` 通知浏览器；返回 `awaiting-approval` 或 `starting`（**工具调用不等待最终结果**——异步结果经 `steerRunOutcome`（`index.ts:1019-1047`）以用户消息回灌模型：成功/拒绝/失败三套措辞，失败时给出 `currentPackageId`/`nextPackageId` 并指导"inspect、在同一个 Plugin 上修正、自主重试"）。
4. 浏览器侧 `approve/decline` → `resolveRequestRun`（`index.ts:412-428`，`@Remote`）settle：认领 pending（一次性，`claimRequest`）、`settleActivation`（Host 激活 + client 结果）、`announceResolved`（`cordis/request-run-resolved`）、steer 结果给模型。
5. 授权记忆：`approvedClientPackages`（按 package）+ `clientVersionUpdatesApproved`（按 Plugin 未来版本，UI 双勾选"批准未来版本"，`prompt.ts` 也向模型解释单勾/双勾语义）；用户拒绝后工具描述要求模型**不要重复请求**。

Client 半在浏览器：`cordis-client-runner/src/client/index.ts`（`CordisRunnerFace.approve/decline/startUserRun`，`client/index.ts:65-120`）；**"页面刷新即干净"**——host 进程内存仍持有定义，页面只是不再运行直到再次被要求（`client/index.ts:6-11`）。渲染失败/guard 拒绝经 `reportRenderFailure`（`index.ts:683-707`）/`reportClientGuardFailure`（`index.ts:717-730`）回 host，再 steer 模型自修（`steerRenderFailure`/`steerGuardFailure`，`index.ts:1049-1118`）；同类失败按 key 去重（`claimRuntimeFailure`，`index.ts:1120-1127`），避免轰炸模型。

### 4.5 inspect 注册表：写代码前的只读查询

`CordisInspectRegistryService`（`inspect-registry.ts:46`）：Host 侧 provider 本地注册 + Client provider manifest 镜像（`syncInspectManifest`，`index.ts:497-501`）；`cordis_inspect_list` 列 provider 目录（platform/purpose/只读方法/输入输出 schema）、`cordis_inspect_query` 执行只读查询（Service.listService、Event.listEvents、Builtin 签名、Tool schema、theme tokens、Slot 树——全部只读，不可调用业务服务），Client 查询跨页等待首个有效页面响应（`resolveInspectQuery`，`index.ts:510-517`）。模型工具描述强制"先 inspect 再 define，不要猜名字"。

### 4.6 版本指针与运行状态机

`cordis_define/cordis_run` 后的身份体系（`prompt.ts:38-46` 向模型解释）：`pluginId`（可变 Plugin）、`packageId`（不可变版本）、`pluginRunId`（一次激活尝试，串起审批/Host/Client 加载/私有 RPC/Run 卡/错误）、`currentPackageId`（最近一次**完全成功**的包；stop/启动 update/update 失败都不清它）、`nextPackageId`（目标：等审批/尝试中/等 client/最近失败）。运行尝试（`DynamicCordisRunAttempt`）有 `starting-host / awaiting-approval / starting-host→client-pending / running / waiting / failed / rejected / cancelled / stopped` 等状态（`registry.ts` + `createAttempt`，`index.ts:1174-1189`）。update 先 stop 旧 Run 再启动目标；失败不自动回滚旧版，模型下次用 `update` 重试或 `run` 回滚。

### 4.7 ui-cordis 面板与 demo:cordis 演示什么

`packages/extensions/ui-cordis/src/client/`：`CordisPanel.tsx`/`CordisDefineRow.tsx`/`CordisRunRow.tsx`/`CordisActionRow.tsx` + `dynamic-port.ts`（客户端动态端口）+ `events.ts`（订阅 `cordis/request-run`、`cordis/dynamic-package`、`cordis/dynamic-retract` 等）+ `inventory.ts`。面板是"用户可见的插件生命周期"：define 卡、run/stop 控制、审批弹窗、渲染失败展示。

`tool-cordis` 的 `CORDIS_SYSTEM_PROMPT`（`tool-cordis/src/prompt.ts:3-60`）+ `@pluginId` 注入（`index.ts:381-398`，`agent/pre-step` 里把引用解析成用户消息上下文，缺失时给 `renderUnavailableReference`）组成的闭环演示了 **agent 自我修改运行时**：模型用 `cordis_inspect_*` 查询精确契约 → `cordis_define` 定义不可变 Package（Host/Client 双半）→ `cordis_run` 激活（client 半等用户审批）→ 失败/渲染错误经 steer 回灌 → 模型 inspect 诊断、define 新 Package、`cordis_run mode:"update"` 自主修复。运行中的插件是**一等公民**：可停（`cordis_stop`，保留定义与版本）、可永久删除（`cordis_undefine`）、用户可从面板直接启停（`stopFromPanel`/`undefineFromPanel` 会把状态变化 inject 给模型）。prompt 里也明确边界：**动态插件是当前进程的临时扩展**（重启即失），"restricted execution environment 防意外误用，不是恶意代码的安全边界"（`prompt.ts:7-8`）。

### 4.8 Client/Host 分裂与 Remote 通道

动态插件的"双半"是 DSH web 面 **Host/Client 分裂**的一个实例：host 进程（Node）拥有服务、会话与执法；浏览器面（Client）拥有 UI、slot 与人类交互。两半之间经 `dsh-api-remotes` 的 **Typert Remote** 通道通信——`CommandRuntime`（§3.1）、`DynamicCordisRunnerService` 的 `@Remote('runHostHalf')`/`@Remote('resolveRequestRun')`/`@Remote('inventory')` 等都是 Typert remote 方法，`cordis-client-runner/src/client/index.ts:21-23` 注明"Client Remote assembly 是两平面相遇的唯一处：挂 `dynamicCordisRunner` namespace 并重导出 payload 词汇，client 包命名所发内容而不 import host 包"。浏览器 roster 由 `dsh.client` 行声明（`packages/bundle/web-app/cordis.patch.yml:45-46`），modules node 半扫描进 `window.__DSH_BOOT__`。`ui-cordis` 的 `dynamic-port.ts`/`events.ts` 订阅 host 广播（`cordis/request-run`、`cordis/dynamic-package`、`cordis/dynamic-retract`、`cordis/request-run-resolved`），把"运行中/失败/等审批"状态渲染成面板。类型面：浏览器类型链经 `*/client` 半入口消费纯类型（如 `permission-presets/types.ts`、`commands/types.ts`），从不加载 host 值模块。

---

## 5. Hook 桥与 ACP

### 5.1 hook-protocol：线协议

`packages/hooks/hook-protocol/src/`：

- **执行**：`runHook`（`runner.ts:67-106`）经 `ctx.shell`（`ShellExecutor`，享受其凭据擦洗/进程组取消/超时机制）运行 hook 命令；stdin = `JSON.stringify(payload) + '\n'`（CC 有尾换行、Codex 无，`trailingNewline` 选项）；超时 = per-hook `timeoutSec`（秒，线协议单位）×1000 覆盖默认（`DEFAULT_HOOK_TIMEOUT_MS = 600_000`，`runner.ts:20`）；基础设施故障变成无 exit code 的 outcome（`parseHookOutput(undefined, '', message)`），**永不 throw 进调用 turn**。
- **解码**：`parseHookOutput`（`codec.ts:59-89`）从 exit code + stdout JSON + stderr 产出方言中立的 `HookOutput`（`types.ts:89-136`）：
  - **exit 2 = block**，stderr 即 reason（`BLOCKING_EXIT_CODE`，`codec.ts:11`）；
  - **exit 0 + `{`-开头的 stdout** 才按 JSON 解析（畸形 JSON 宽松退回纯文本，与参考引擎一致）；
  - `continue`/`stopReason`/`systemMessage` 顶层读取；顶层 `decision` **只认 `approve`/`block`**（越界 `{"decision":"deny"}` 忽略，`codec.ts:38-40`）；`hookSpecificOutput.permissionDecision` 只认 `allow`/`deny`/`ask` 且**覆盖**顶层 decision（`codec.ts:43-45, 115-120`）；`hookEventName` 不匹配 firing event 时丢弃 event-scoped 字段（判别器仍保留供诊断）；
  - `additionalContext`（下轮模型上下文）、`updatedInput`（**解析但暂不兑现**，桥 log+warn）。
- **审计**：log-only 事件 `hook/invoked` + `hook/result`（按 `handlerId` 配对，`types.ts:19-41`；`hook/result` 带 decision、exitCode、有界 stderr 摘要、durationMs），**不进模型 transcript**（同 `compaction/*`，非 surface 事件）——这就是"session persistence 消费"：它们随会话日志持久化、可重放，恢复后的会话仍保有 hook 决策轨迹。
- **detached 运行**：emit 形扩展点（SessionStart/SubagentStart/Stop…）无人 await，`createDetachedRuns`（`detached.ts:43-62`）跟踪"run + 其 continuation"整链，`drain()` 先 abort signal（杀死还在跑的 hook 进程，而非等满 10 分钟超时）再等所有链 settle——桥的 effect disposer 就是 `drain`，`fiber.dispose()` resolve 即桥的工作静止。
- matcher：`MatcherGroup`（`types.ts:68-71`）——`matcher` 模式（缺省/`''`/`'*'` = 全匹配）+ 命令列表；CC 纯 `[A-Za-z0-9_|]+` 用字面量交替、否则正则；Codex 恒正则（`MatcherMode`，`types.ts:79`）。

### 5.2 Claude Code / Codex 桥：外部 IDE 事件 → DSH 扩展点

`packages/hooks/hooks-claude-code/src/index.ts`（`apply`，`index.ts:96-296`）：

- 配置：`hooks.json` 或含 `hooks` 键的 settings 文件（`config.ts` 解析，非 command 类型 hook 解析并跳过，warn 一次）；`inject: ['shell']`，其余扩展点经 `ctx.get` 机会主义读取（一个桥可在部分扩展点缺席时加载）。
- **映射表**（每个 CC 事件 → DSH 扩展点）：`SessionStart → agent/session-start`（detached，完成后 `agent.inject` 上下文）；`UserPromptSubmit → agent/pre-step`（`PreStepDecision`，`deny`→`reject`，否则 delegate 后把 additionalContext 折进 enter 消息）；`PreToolUse → tools/pre-execute`（`PreToolDecision`，`deny→deny`、`ask→ask`）；`PostToolUse → tools/post-execute`（`PostToolDecision`，deny→block + feedback，additionalContext 折进 `additionalContexts`，delegate 保留下游改写）；`Stop → agent/turn-stopping`（deny → `agent.steer` 强制续跑，TODO 注明 loop-guard 待加）；`SubagentStart/Stop → subagent/start|end`（detached；`SUBAGENT_TYPE = 'general-purpose'`，`index.ts:304`——harness 无 per-kind label，用 CC 默认 Task 工具值；子代理经 `subagentChildren` Map 保留到配对 end，让 stop hook 仍有会话工作区）。
- payload 是 **CC 方言**（`session_id`、`transcript_path`（经 `sessionPersistence.locate`）、`cwd`、`hook_event_name`、`tool_name/tool_input/tool_use_id`、`prompt`、`stop_hook_active`…），构造在桥内（`sessionStartPayload` 等，`index.ts:322-361`）——"payload/环境/替换/决策映射归桥，执行与解析归协议"（`types.ts:1-6`）。
- workdir 与 `CLAUDE_PROJECT_DIR`：默认取会话工作区 `session.header.cwd`（`index.ts:147-151`）；`${CLAUDE_PLUGIN_ROOT}` 替换由 `pluginRoot` 配置提供。
- 合并：`mergeHookOutputs`（`merge.ts`）把同点多个 hook 的输出折叠成"已最严格"的中性视图。
- Codex 桥（`packages/hooks/hooks-codex/src/index.ts`）：同样结构，恒正则 matcher，`SessionStart/UserPromptSubmit` 的 plain stdout 作 `additionalContext`，忽略 `allow/ask`（faithful-but-degraded，`types.ts:84-88` 注释）。

### 5.3 ACP：Agent Client Protocol 自动化服务器

`packages/acp/acp/src/index.ts`（`apply`，`index.ts:121`）：**automation-only** 的 ACP 服务器，JSON-RPC over stdio（NDJSON，`ndJsonStream`，`index.ts:444-447`）；`inject: ['agents']`；提供 `initialize/authenticate/newSession/prompt/cancel`（`makeAgent`，`index.ts:287-441`）。

- **newSession → ctx.agents**：`agents.create({ sessionId, meta: { cwd }, agentOptions })`（`index.ts:308-333`）——每个 ACP 会话 = 一个全新 DSH agent（无 preset 组合：ACP bundle 把模型面行放 host plane，agent 从全局层读；配置了 roster 的部署需先 join，注释指向 agent-presets README）。
- **prompt 生命周期**：单 in-flight 槽（并发 prompt → `invalidParams`）；admission（含富内容/图片，`admitAcpPrompt`，`content.ts`）→ `agent.followup(message)` → `settleAfterQuiescence`（`index.ts:169-216`）：等 admission + `agent.whenIdle()` + `outputTail` 全安静后才 settle `stopReason`（`turnEndToStopReason`，`codec.ts` 把 turn end reason 映射成 ACP stop reason；max-tokens 映射为 end_turn）；`session/event` 只转发 **committed** assistant text/image（`assistant/message` → `agent_message_chunk`，`index.ts:222-252`，逐块转换失败被记录为 `outputError`），raw chunks/reasoning/tools/plans 不上自动化线。
- **机器审批**：`approval/request` 监听（`index.ts:271-285`）——只对**本桥拥有的 agent**（`ownedRecord` 拒绝同 id 冒充）且带 `callId` 的问题应答：`conn.requestPermission({ options: [allow-once, reject-once] })`，把客户端 `allow_once/reject_once` 映射回 `allowed-once/rejected`（**一次性选择，绝不把未知客户端响应推断成持久授权**）；无 callId 的问题 delegate（`next()`）给他人。
- cancel：`cancelRequested` 置位 + admission abort + `record.agent.cancel({ kind: 'user' })`（`index.ts:425-439`）；quiesce（`index.ts:450+`）先停桥自身工作（settle 全部 pending）再 drain 可续子代（`drainContinuableDescendants`，`index.ts:52-58`）。

> 代码片段 4 —— ACP 的机器审批通道（`packages/acp/acp/src/index.ts:271-285`）：
> ```ts
> ctx.on('approval/request', (request, next) => {
>   const record = ownedRecord(request.agent)
>   if (record === undefined || request.callId === undefined) return next()
>   return conn.requestPermission({
>     sessionId: record.agent.session.id,
>     toolCall: { toolCallId: request.callId },
>     options: [
>       { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
>       { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
>     ],
>   }).then(({ outcome }) => {
>     if (outcome.outcome === 'cancelled') return 'cancelled'
>     return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
>   })
> })
> ```

### 5.4 hook 事件如何进入 session log（持久化/重放消费）

`hook/invoked`/`hook/result` 与 `approval/*`、`command/*` 一样，都是 `SessionEventMap` 的成员（`packages/hooks/hook-protocol/src/types.ts:8-41` 的 declare merge）——**会话日志是它们的持久化单位**：`dsh-session-persistence-jsonl` 把事件流追加写入（base 行 `root: !!js dshHomePath('sessions')`，`packages/bundle/base/cordis.patch.yml:98-101`），恢复/重放时逐事件重建。三类"log-only"事件（hook、approval、command）的共同点：**不进模型 transcript**（非 surface 事件、无 `surfaceOp`），是审计/可追溯性的事实层；模型可见行为来自消费它们的扩展点决策与 runtime-context 快照。`appendHookInvoked`/`appendHookResult`（hook-protocol 导出）在 turn 内调用时记录 `turn` 号，`hook/result` 的 stderr 摘要按 `stderrSummaryMaxChars` 截断（默认 `DEFAULT_STDERR_SUMMARY_MAX_CHARS`），把"过程痕迹"压缩成有界、可重放的记录。

### 5.5 ACP 的辅助面：content 与 stop-reason 编解码

`packages/acp/acp/src/content.ts`：`admitAcpPrompt`（文本/图片富内容准入，`supportsAcpImagePrompts` 探测 provider/model 是否支持图片）与 `assistantBlockToAcp`（committed assistant 块 → ACP content，转换失败抛 `AcpContentError`，按 kind 映射 `invalid`/`internal`）；`codec.ts`：`turnEndToStopReason` 把 DSH 的 turn end reason 映射成 ACP stop reason。这两个模块把"DSH 的会话内容模型"与"ACP 的内容模型"做双向编解码，是 §5.3 之外协议的纯数据层。

---

## 6. 设置 / 凭据 / 身份 / 工作区 / 存储（简述）

### 6.1 settings：namespace 分层解析

`packages/settings/settings/src/index.ts`（`SettingsProvider`，`index.ts:131-135`）：一个原始文档分 namespace 存 section；插件注册 namespace schema，读取**分层解析值**：schema 默认 → 注册者组合 `base` → 用户文档 section（`index.ts:1-7, 103-129`）。`SettingsScope`：`get()/watch()/update(patch)/replace(section)`；`update` 是部分合并（JSON 兼容数据才收，非 JSON 路径先拒）、`replace({})` 重置回 base+默认；`SETTINGS_CONFLICT`（`index.ts:164-183`）拒绝陈旧 revision 写入（revision 单调，wire 回传 `expectedRevision`）；`watch` 回调串行化、失败隔离（`index.ts:115`）。`redactSecrets`（`redact.ts`）把 `role('secret')` 字段从 wire 描述符剥离并枚举（`SettingsDescriptor.secrets`，`index.ts:64-90`；web 线必须传 `redactSecrets: true`）；路径编辑（`SettingsPathOp`，`index.ts:200+`）让持有**不完整（已脱敏）视图**的 UI 能按路径改单字段而不必整体 replace（整体 replace 会把 wire 从未返回的 secret 静默删掉）。`settings-file`（`packages/settings/settings-file/src/index.ts:1-7`）：`$DSH_HOME/settings.yaml`（或 .yml/.json，扩展名决定格式，`index.ts:35-39`），chokidar 热重载、跨进程写锁、**保注释的 leaf-level diff** 写回（`index.ts:1-7`）。

### 6.2 credentials：引用不落地

`packages/credentials/credentials/src/index.ts`：`ctx.credentials` 是抽象 `CredentialProvider`（`index.ts:60`），配置/组合文件只带 **`CredentialRef`（环境变量名，`credentialRef` 品牌化，`index.ts:23-28`）**，provider 拥有真值；`resolve/describe/set/unset` 四操作；**每次操作解析一次**（改动无需重启即达，消费者不得跨操作缓存）；"空存值 = 处处缺席"（`index.ts:54-59`，空字符串既不 resolve 也不被 describe 为已配置）。`credentials-local`（`credentials-local/src/index.ts:1-36`）分层：继承进程环境（只读、最优先——CI secret 是本次运行的显式意图，且不可从内部编辑，所以必须**可见地**只读而非静默遮蔽写入）> `$DSH_HOME/.credentials.yaml`（provider 托管、可写）> 调用目录 `.env` > home `.env`；托管文档是严格的 `CredentialRef→string` 映射（不是 dotenv——"被 harness 拥有且永不物化进环境的存储，不能再兼任环境层"），写路径跨进程写锁 + 原子写 + 热发布。base patch 里 `credentials` 行（`packages/bundle/base/cordis.patch.yml:85-86`）。

### 6.3 identity：匿名用户 id

`packages/identity/anonymous-user-id/src/index.ts`：`getOrCreateAnonymousUserId`（`index.ts:68-99`）——随机 UUID v4，裸行存 `<dshHome>/.anonymous-user-id`，**按 harness home 作用域**（非机器，所有共享 `$DSH_HOME` 的进程报同一 id），删文件即换新身份；`'wx'` 独占创建解决并发首启（输家重读赢家的 id）；写失败 best-effort 仍返回内存 id（telemetry/feedback 永不阻塞）；进程内按路径 memo（一次进程只碰一次盘）。telemetry 用它作 OTLP Resource 的 `user.id`（`packages/bundle/base/cordis.patch.yml:137-138`）。

### 6.4 workspace + storage-domain

`packages/workspace/workspace/src/index.ts`：`WorkspaceRegistry`（`index.ts:92`，`inject: ['storageDomain', 'sessionPersistence']`）——持久化工作区记录、稳定注册表序、header 校验的会话成员关系；**persistence 依赖是强制的**："unavailable peer 不能伪装成空历史并提交 initialized marker"（`index.ts:85-91`）。`WorkspaceEntity`（`entity.ts`）负责会话归档/移动（`WorkspaceUnknownSessionError`/`WorkspaceMoveInvalidError` 等域错误）。`packages/storage/storage-domain/src/domain.ts`：域运行时（`DomainGlobal`/`KvTable`，`domain.ts:19-70`）——内存权威态 + **每域单写链**：先等后端持久化成功才改内存再发 `domain/changed`（拒绝的后端写不污染内存，事件值恒等于发射时内存态、按写序）；spec（`spec.ts`）声明表/全局的 schema 与初始值；后端由 web-app bundle 组（`storage-json`，`packages/bundle/web-app/cordis.patch.yml:51-62`，`root: !!js dshHomePath('storages')`）。

---

## 7. Python SDK

### 7.1 包结构

`python/README.md:9-12`：

- `python/sdk`（dist `deepseek-harness-sdk` / 模块 `deepseek_harness`）：高层 turns API + 低层 JSON-RPC client。文件：`api.py`（`DeepSeekHarness`/`DeepSeekHarnessConfig`/`RunResult`/`Session`）、`client.py`（`HarnessClient`/`HarnessConfig`）、`models.py`（`JsonObject`/`Notification`/`IncomingRequest`/`InitializeResponse`/`ServerInfo`）、`errors.py`（`SdkProtocolError`）。
- `python/sdk-runtime`（dist `deepseek-harness-runtime-bin` / 模块 `deepseek_harness_runtime`）：**捆绑的运行时二进制**（`src/deepseek_harness_runtime/deepseek-harness-runtime.json` + `runtime/cordis.yml` 默认 agent 配置），hatch 构建（`hatch_build.py`）按平台矩阵（`platforms.json`）下载/打包对应平台运行时——Python 侧不重新实现 agent，而是**运真实 DSH 运行时**。

### 7.2 暴露的 API

`python/sdk/src/deepseek_harness/__init__.py` 导出：`DeepSeekHarness`（可复用同步句柄，`api.py:48`——lazy 启动子进程、跨 `run()` 复用、context manager 保证回收）、`DeepSeekHarnessConfig`（provider/model/max_tokens/cwd/runtime_cwd/session_root/cordis/env/runtime_bin/launch_args_override/request_timeout_seconds/shutdown_timeout_seconds/base_url/api_key，`api.py:14-35`）、`Session`（`start_session(session_id?)` → `session.run(input, on_notification=)`，`api.py:127+`；`run` 归一化输入为 content blocks、收集 notifications 与 events、按 `sessionId` 过滤 `session.event` 通知）、`RunResult`（session_id/final_response/finish_reason/events/notifications/session_root，`api.py:38-46`）、低层 `HarnessClient`/`HarnessConfig`、`SdkProtocolError`。配置经环境注入运行时：`DSH_SESSION_ROOT`/`DSH_CORDIS_CONFIG`/`DSH_CWD`/`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY`（`api.py:64-72`）——**运行时自己始终要求显式配置**，默认配置属于客户端（`python/README.md:16`）。

### 7.3 与 TS SDK 的对应

SDK 经 **newline-delimited JSON-RPC on stdio** 驱动捆绑运行时子进程（`python/README.md:5`）——线协议对应 `packages/examples/jsonrpc-demo` 的 JSON-RPC 服务器（`jsonrpc-demo/src/runner.ts`）；`initialize(cwd, provider, model, max_tokens)` 对应其初始化请求。高层 turn API 语义上对应 TS `apps/cli` 的 headless 一次性运行（`dsh --profile headless "<task>"`），只是把"CLI 参数"换成"SDK 方法调用"；TS 的 ACP（§5.3）是另一条自动化面（ACP JSON-RPC，`packages/examples/acp-demo`），Python SDK 面向 DSH 自有的 JSON-RPC 面。TS SDK（`packages/sdk`）与 Python SDK 是同构的"客户端 → 运行时"分层：TS SDK 面向进程内/嵌入，Python SDK 面向子进程。

### 7.4 sdk-runtime 载体与运行时解析

`python/sdk-runtime` 是"把运行时送到 Python 侧"的载体：`deepseek-harness-runtime.json`（捆绑二进制清单：平台、校验、启动命令）、`runtime/cordis.yml`（默认 agent 配置——**运行时自己始终要求显式配置**，默认配置属于客户端，`python/README.md:16`）；`hatch_build.py` + `platforms.json` 按平台矩阵构建。`HarnessClient`（`client.py`）负责子进程生命周期与协议：lazy `start()`、`initialize`、逐行读 `session.event` 通知、`request_timeout_seconds`/`shutdown_timeout_seconds` 保障回收。测试面：`tests/test_runtime_resolution.py`（平台解析）、`test_bundled_runtime.py`（捆绑运行时冒烟）、`test_client.py`（协议）。

---

## 8. 示例

> 说明：仓库没有名为 `agent-spine-demo` 的 examples 目录；`agent-spine-demo` 是 **packages/examples 下的 bundle 插件包**（`packages/examples/agent-spine-demo/`），examples 下的运行示例是 headless-agent / acp-agent / jsonrpc-agent 等。任务里的"最小 agent 组合"对应它 + headless-agent 的 cordis.yml。

### 8.1 agent-spine-demo：最小 agent 组合

`packages/examples/agent-spine-demo/README.md`：**默认的无 executor、无 UI agent 脊柱**，作为**一个 Cordis bundle 插件**（代码 bundle，非共享 YAML include——include 不能拥有 bin 或提供入口默认值，`README.md:66-68`）。`apply(ctx, config)`（`src/index.ts`）挂载固定服务集：timer / llm（抽象）/ session / session-title / system-prompt / tools / skill / skill-filesystem / agent / goal 族 / llm-retry / jobs-local / invariants 族 / tool-bash（schema）/ agent-instructions / tool-skill / tool-jobs / **agent-loop（具体循环，接收转发的 `agents`）**，并转发 `persona` 给 system-prompt（`README.md:11-40`）。Config 每个字段**逐字转发**给拥有它的子插件（`src/index.ts:92-120`：`agents`→agent-loop、`persona`/`toolOrder`/`includeHarnessIdentity`/`includeRuntimeContext`→system-prompt、`tools`→tool registry、`workspaceContext`（**显式字节预算或 false**，因为它改变模型可见输入）→agent-instructions、`skills`→skill 栈、`jobs`→job provider、`toolBash`/`toolJobs`→模型面工具、`goals`→goal 域+工具+驱动、`invariants`→包过滤的关系检查）；`pickSpineConfig()` 只拷贝本 bundle 拥有的字段，冲突的 `dshHome` 组合即失败。

**刻意留在 bundle 外**（`README.md:42-53`）：LLM 适配器（叶子注册 `ctx.llm` 具体实现）、模型面 title provider、bash executor（叶子提供 `ctx.shell`）、非本地 skill provider、入口点/传输/stdout。这正是 "Service Definition / Service Provider / Consumer" 分离在组合层的落地：bundle 拥有共享脊柱，叶子拥有后端，app 包拥有入口。

最小组合的实配在 `examples/headless-agent/cordis.yml:44-61`：

```yaml
- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
        cwd: !!js process.cwd()
    workspaceContext:
      maxBytes: 65536
    persona: |
      You are headless-agent, a coding assistant powered by the {{model}} model.
      ...
```

再配 `llm-deepseek`（适配器，`cordis.yml:23-32`）、`bash-local`/`subprocess`（executor，`cordis.yml:35-41`）、`persistence`（`cordis.yml:63-67`）、subagent 族、fs 族——约 40 行组成一个能跑的编码 agent；入口 `dsh --profile headless "<task>"`（`packages/bundle/headless/cordis.patch.yml:1-5`）。`examples/headless-agent/README.md` 与 `composition.md` 是它的组合说明书。

### 8.2 acp-demo 与 jsonrpc-demo

- `packages/examples/acp-demo/src/bin.ts` + `index.ts`：把 ACP 服务器（§5.3）做成可执行 bin（`dsh-acp-demo`，app-boot 胶水 + `bareModuleBaseUrl` 打包运行时）；e2e 用 `examples/acp-agent/tests/acp.e2e.ts` 验证（协议握手、session/new、prompt、审批往返、退出）。
- `packages/examples/jsonrpc-demo/src/bin.ts` / `runner.ts`：JSON-RPC 服务器 bin（Python SDK 的线协议对端）；`examples/jsonrpc-agent/minimal.py`（`minimal.py:30-38`）演示最小 Python 用法：

```python
with DeepSeekHarness(
    provider=args.provider, model=args.model, max_tokens=args.max_tokens,
    cwd=str(workspace), session_root=str(session_root), cordis=str(CONFIG.resolve()),
) as harness:
    result = harness.run(args.prompt, session_id=args.session_id)
print(result.final_response)
```

`examples/AGENTS.md`：examples 目录是"可运行的组合"，只保留 cordis.yml 布线、demo 产物与 e2e/snapshot 场景；**可复用逻辑必须抽到 `packages/`**（那里有逐文件覆盖率与 README gate）；每个示例都有 keyless smoke（Loader 启动真实 cordis.yml）+ with-key e2e（真实模型、验外部状态而非模型自述）。

---

## 9. 设计哲学观察

### 9.1 组合优于配置（composition over config）

- 整个产品 = 一张 entry 列表，**模式差异是"不同层补丁"而不是"同一份配置的分支"**：base 只放共享行 + 中性默认，web/headless 各用自己的 patch 层覆盖（`packages/bundle/base/cordis.patch.yml:6-10` 的自述 + web-app 注释）。"Which adapters exist is composition; which providers run is the user's settings document"（`cordis.patch.yml:92-94`）——**存在性归组合、取值归设置**。
- 能力缝（seam）三件套（Service Definition / Provider / Consumer，`docs/glossary.md:9`）在组合层被完整贯彻：agent-spine-demo 装抽象 `llm`/`shell`，叶子装具体 adapter/executor，`inject` 表达依赖、激活由服务可用性驱动、**行序无加载语义**（`cordis.patch.yml:12-13`）。
- 组合是可读、可 dump、可回放的：`--dump-config` 输出带来源注释的组合文档；`$DSH_SNAPSHOT=replay` 用 `cordis.snapshot.yml` 重放固化组合。

### 9.2 "没有特权内核，一切皆插件"

- 连**启动组合本身**都是插件：根 `cordis:include` 是 app 胶水，bundle patch 经 manifest 字段解析"never through code"（`packages/bundle/base/README.md:5`）；boot 的审计（`assertEntriesActivated`）把每个 entry 当普通公民对待；`cordis:group` 也是内置插件（`index.ts:505-510`）。
- **agent 自己就是插件作者**：tool-cordis 让模型在运行时 define/run/stop/undefine Cordis 插件，连宿主自己（`HARNESS_SOURCE_SECTION`，`packages/boot/app-boot/src/index.ts:821-829` 让模型知道 checkout 在哪以便自我修改）都是被检查/被修改对象。
- 审批、命令、权限、问人全是**可选的 ctx 服务**（base patch 挂载、但每个都是独立行，可被覆盖/禁用）；预设服务"not part of the agent-loop spine"（`docs/subsystems/permission-presets.md:5`）；`dsh-base` 自己不依赖也不挂载 Codex/Claude Code provider——**选择权留给 profile 与 preset 两层**（`packages/bundle/base/README.md:5`）。

### 9.3 misconfiguration fails loud

- 被点名的文件缺失 = 抛（`loadOverlayPatches`）；patch 文件存在但坏 = 启动即抛（`parsePatchList`）；bundle 无 `dsh.bundle` = 抛；profile 目录名非法 = 抛。
- 预设表占 `custom` / 无约束 executor / 组合默认无匹配 = 加载期抛；权限"never"在服务内判定、无法被监听者绕过；审计对 append 失败 = 拒绝请求；boot 后启用行未激活 = 拒绝启动（`assertEntriesActivated`）。
- `--dump-config` 与 boot 用同一 `applyEntryPatches`，dump 永不骗人；命令注册元数据坏、凭据空值、预设名未知（`/permission` error text）、`ask_user_question` 的 intent 声明坏（`BAD_INTENT`）等都在各自边界被拒。
- 反例同样被设计承认：单条 patch 未命中目标行只是警告（跨 surface 共享 overlay 的取舍）、`.env` 缺失是正常的、host half 的 vm 沙箱"不是安全边界"（`prompt.ts:7-8`）。

### 9.4 patch 层的可覆盖性设计

- **整行替换**是无深合并的刻意取舍：把"可覆盖性"的推理成本压到"一个 id 一个 owner"，任何一行最多"一个 bundle 层 + 用户层"两处来源（`cordis.patch.yml:6-10`），README 把"profile overrides must restate every field"列为 Known Limitation（`packages/bundle/base/README.md:21`）。
- 平台门控（bash/pwsh 双胞胎）演示了覆盖的**完整性配方约束**：禁用一族的 executor 而不启用另一族会因同名 `bash` 服务双重注册而失败 loud（`README.md:7`）。
- 用户层热更新（HMR `watchUserPatches`）让"覆盖"在长寿命表面（web）上不需要重启；`--patch` overlay 让一次运行可临时叠层（dump 里完整呈现层序与来源注释）；`--dump-default-config` 是"用户层坏了也能看组合"的恢复通道。

---

## 10. 附：关键代码路径索引

- 组合：`packages/boot/app-boot/src/profile.ts:104-168`（profile 解析/初始化）、`:344-355`（resolveBundleDir）、`:371-403`（loadProfile）、`:413-420`（composeEntries）；`packages/boot/app-boot/src/index.ts:278-338`（patch 解析）、`:379-473`（renderConfigDump）、`:486-529`（mountRootInclude）、`:232-265`（watchUserPatches）；`apps/cli/src/dump-config.ts:30-52`（--dump-config）；`packages/bundle/base/cordis.patch.yml:15-451`（base 层）；`packages/bundle/web-app/cordis.patch.yml`、`packages/bundle/headless/cordis.patch.yml`（模式 overlay）。
- 审批：`packages/interaction/user-approval/src/types.ts:14-29`；`src/index.ts:94-97`（策略）、`:112-118`（折叠）、`:153-174`（ApprovalRequest）、`:257-276`（request）、`:304-344`（decide）；web 答案者 `packages/host/apiproxy/src/api-proxy.ts:1391-1449`。
- 权限预设：`packages/interaction/permission-presets/src/index.ts:159-278`（服务/表/命令/投影）、`:309-321`（derive）、`:380-431`（apply/pin）；`types.ts:27-43`（投影类型）。
- 命令：`packages/interaction/commands/src/index.ts:245-252`（register）、`:297-338`（execute）；`types.ts:88-101`（事件）。
- 问人：`packages/interaction/user-questions/src/index.ts:92-140`（ask 守卫）；`packages/interaction/tool-ask-user/src/index.ts:19-101`（工具）。
- 动态扩展：`packages/extensions/cordis-host-runner/src/index.ts:151-202`（define）、`:248-312`（run）、`:412-428`（resolveRequestRun）、`:883-915`（startHost）；`sandbox.ts:96-145`（陷阱/沙箱）、`:206-238`（precheck/evaluate）；`lifecycle.ts:22-57`；`tool-cordis/src/index.ts:41-399`（工具集）、`prompt.ts:3-60`（模型指南）；`cordis-client-runner/src/client/index.ts:65-120`（CordisRunnerFace）；`ui-cordis/src/client/`（面板）。
- Hook：`packages/hooks/hook-protocol/src/runner.ts:67-106`；`codec.ts:59-120`；`types.ts:19-136`；`detached.ts:43-62`；`hooks-claude-code/src/index.ts:137-296`（映射）；`hooks-codex/src/index.ts`。
- ACP：`packages/acp/acp/src/index.ts:121-441`（apply/makeAgent）；`:271-285`（机器审批）。
- 设置/凭据/身份/工作区：`packages/settings/settings/src/index.ts:103-129`；`settings-file/src/index.ts:1-7`；`credentials/credentials/src/index.ts:60-99`；`credentials-local/src/index.ts:1-36`；`identity/anonymous-user-id/src/index.ts:68-99`；`workspace/workspace/src/index.ts:92-120`；`storage/storage-domain/src/domain.ts:1-70`。
- Python：`python/README.md`；`python/sdk/src/deepseek_harness/__init__.py`、`api.py:48-124`；`python/sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml`。
- 示例：`packages/examples/agent-spine-demo/README.md`、`src/index.ts:92-120`（Config 转发）；`examples/headless-agent/cordis.yml:44-61`；`examples/jsonrpc-agent/minimal.py:30-38`；`packages/examples/acp-demo/src/bin.ts`；`examples/AGENTS.md`。
- 文档：`docs/cordis-primer.md`（Cordis 五概念/dispatch 模式/waterfall）、`docs/subsystems/approval.md`、`permission-presets.md`、`extensions.md`、`settings.md`、`credentials.md`、`workspace.md`、`docs/glossary.md`（seam/scope/human command/loop hierarchy）。

---

## 11. 术语速查与跨面观察

### 11.1 本报告高频术语（对齐 `docs/glossary.md`）

- **seam / 能力缝**：Service Definition（抽象 `Service` 类）+ Provider + Consumer 三件套，一个 `ctx.<key>` 一个缝；`docs/glossary.md:9`。
- **scope / 作用域**：per-agent 注册单位；agent 是它自己 scope 的 key；shadowing = 最具体者胜（`docs/glossary.md:13-18`）。
- **human command**：斜杠命令，人类面适配器经 `ctx.commands` 直接执行，不成为模型消息（`docs/glossary.md:31`）。
- **turn / step / round**：turn = 一轮输入排空；step = 一次模型请求+其工具执行；round = 外层策略迭代（goal round / Ralph round）（`docs/glossary.md:37-39`）。
- **log-only 事件**：`approval/*`、`command/*`、`hook/*`、`agent-preset/selected`、`permission/preset` 等——持久化、可重放、**不进模型 transcript**，是审计/意图事实层。
- **runtime-context 快照**：审批策略等"完整当前值"以用户消息形式在保留历史之后追加，不改写稳定 system-prompt 前缀（`user-approval/src/index.ts:200-216`）。
- **fail-closed**：`unavailable`/`rejected`/`cancelled` 一律当拒绝；唯一放行 `allowed-once`。

### 11.2 跨面观察：同一模式的三处重复

- **事件配对**：`tool/call↔tool/result`、`command/run↔command/done`、`approval/asked↔approval/decided`、`hook/invoked↔hook/result`——四组配对都是"入口记录 + 出口记录 + 稳定 id"，统一了会话日志的可追溯性形态。
- **三层写路径**：域事件（持久事实）→ canonical setter（如 `setSandboxMode`/`setApprovalPolicy`）→ 消费者折叠（`effective*` 纯函数从日志推导）——"重放日志即状态"贯穿审批、权限、预设选择、agent-preset 选择（`agent-presets/src/session.ts:48-54`）。
- **读侧投影 / 写侧命令**：`permissions` 投影 + `/permission` 命令；`session-title`、`session-query` 同构——浏览器只消费投影/命令，不直接写域。

### 11.3 风险与取舍观察（设计承认的边界）

- patch 整行替换 → 用户覆盖必须重述整行（base README Known Limitation）；跨 surface 共享 overlay 的未命中行只是警告。
- vm 沙箱"不是安全边界"——协作式约束（`prompt.ts:7-8`）；`vmTimeoutMs` 只限同步段。
- `Stop` hook 的强制续跑无 loop-guard（TODO 注明）；`updatedInput` 解析不兑现（warn 处理）。
- ACP 只承诺"committed"输出上自动化线；raw chunks/reasoning 属展示/追踪数据。
- 动态插件是进程内临时扩展（重启即失），define 不落盘不改源——与 profile/bundle 的"声明式持久组合"互补：**声明式组合管静态，动态插件管运行时临时性**。

（完）
