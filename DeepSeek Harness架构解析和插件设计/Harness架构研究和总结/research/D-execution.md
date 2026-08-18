# DeepSeek Harness 执行世界研究报告

> 覆盖范围：sandbox / subprocess / shell / fs / terminal / code-runtime / lsp / e2b 及其本地后端与工具层。
> 仓库根：`E:\WorkSpace\LLM_Projects\deepseek-harness`。所有引用使用仓库内相对路径 `packages/...:行号` 或 `native/...:行号`。
> 本文是"执行世界"（execution world）的横向解剖：进程沙箱如何包住 argv、子进程/Shell/FS 三条能力 seam 如何共享同一个世界、终端与代码运行如何站在这些原语之上，以及"换 provider 整体迁移"的证据。

---

## 0. 全景与阅读地图

"执行世界"在 DSH 里不是一个包，而是一组**能力 seam**（capability seam）的横向切片。每个 seam 都是标准的"三件套"结构：

| seam | Service Definition（`ctx.xxx`，抽象） | Service Provider（本地实现） | Consumer（执行器/工具） |
|---|---|---|---|
| sandbox | `packages/sandbox/sandbox/src/index.ts` | `sandbox-local` + `sandbox-windows-acl` + `native/landlock-run` | `bash-sandbox`、`terminal-bash`、`tool-fs`、`tool-bash` |
| subprocess | `packages/subprocess/subprocess/src/index.ts` | `subprocess-local` | `bash-local`/`pwsh-local`、LSP host、terminal-bash、tool-fs-search |
| fs | `packages/fs/fs/src/index.ts` | `fs-local`、`fs-sandbox`、`fs-e2b` | `tool-fs`、`tool-str-replace-editor`、`tool-fs-search`、lsp-stdio |
| shell | `packages/shell/shell/src/index.ts` | `bash-local`、`bash-sandbox`、`pwsh-local`、`pwsh-sandbox` | `tool-bash`、`tool-pwsh`、`tool-bash-persistent` |
| terminal | `packages/terminal/terminal/src/index.ts` | `terminal-bash` | `tool-terminal`、`tool-bash-persistent` |
| code-runtime | `packages/code-runtime/code-runtime/src/index.ts` | `code-runtime-worker-thread` | Code Mode 工具族 |
| lsp | `packages/lsp/lsp/src/index.ts` | `lsp-stdio` | `tool-lsp` |
| e2b（远程） | 无独立 seam，作为 provider 整体替换 | `e2b`（沙箱所有权）+ `fs-e2b` + `subprocess-e2b` | 同上（换 provider 不动工具） |

三层之间的依赖方向：**sandbox 最底层（只包 argv）→ subprocess（spawn 进程树）→ shell（bash 语义与超时/输出预算）→ 工具（模型面 schema 与审批）**；fs 与 subprocess 平级、共享执行世界；terminal 站在 subprocess 的 PTY 原语上；code-runtime 自成一个隔离小世界。

---

## 1. 沙箱体系（`ctx.sandbox` + `ctx.sandboxPolicy`）

### 1.1 模式与 per-call policy

模式词汇表只有三个值（`packages/sandbox/sandbox/src/index.ts:29`）：

```ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

- `read-only`：只允许 shell 必需的 sink（如 `/dev/null`）；
- `workspace-write`：额外允许 workspace 根 + 后端承诺的临时区；
- `danger-full-access`：绕过约束（消费者直接 spawn 原始 argv，不调用 `ctx.sandbox`）。

关键设计点：**policy 是 per-call 的，不是固定在 provider 上的**。`SandboxPolicy extends SandboxExecutionPolicy` 且 `mode: ConfinedSandboxMode`（`:69-72`，`ConfinedSandboxMode = Exclude<SandboxMode,'danger-full-access'>`，`:32`）——provider 收到的一定是"受限模式"，`danger-full-access` 在消费者边界就被分流，永远到不了 provider。注释明确写道：同一时刻两个消费者可以用不同 policy（bash 用 read-only 而子 agent 需要可写状态目录），一次审批通过的升级重试就是一个携带更宽 policy 的新调用。**默认化/解析是消费者边界的显式步骤，provider 把 policy 视为完全指定**（`packages/sandbox/sandbox/src/index.ts:61-68`）。

`SandboxExecutionPolicy`（`:39-52`）携带 `mode`、`workspaceRoot`（绝对路径，即使该模式不消费它也要携带，便于一次 resolve 后选择 enforcement 路径）、以及可选的 `sessionId`（Windows ACL 后端按 session/workspace 对分配随机私有临时目录和 SID）。

### 1.2 policy 解析与传播（sandboxPolicy → 各 enforcing 消费者）

`ctx.sandboxPolicy`（`packages/sandbox/sandbox-policy/src/index.ts`）是**唯一的 policy 所有者**，它同时喂养三个 enforcing 消费族（fs 写入、一次性 bash、终端 PTY）。解析优先级（`resolve()`，`:135-142`）：

```
request.mode（审批通过的显式升级，最优先）
  ?? 该 session 日志里最后一次 'sandbox/mode' 事件（effectiveSandboxMode 折叠）
  ?? 部署默认 defaultMode（fail-safe 默认 'read-only'，Config schema :93-98）
workspaceRoot = 调用 session 的 immutable cwd ?? 配置的 fallback 根（:139）
```

- **session override 的存储就是 session 事件日志**（`session-mode.ts:24-71`）：`setSandboxMode` 只是 `session.append('sandbox/mode', { mode })`；`effectiveSandboxMode` 从事件数组**倒序折叠**出最后一个（`:52-58`）。没有外部配置存储、没有补 catch-up 机制——重放日志即状态。这也是"同一执行世界"里 bash 和 fs 共享同一个 override 的原因：override 是 policy 状态，住在 policy 包而不是任何一个能力 seam 里（`session-mode.ts:14-16`）。
- **上下文快照**：`SandboxPolicyService` 构造时向 `systemPrompt` 注册 `sandbox:policy` context（`:112-123`），把 resolve 后的模式/根渲染成模型可见文本（`renderPolicyContext`，`:38-52`），使重放重建出相同的模式。
- **传播链**：工具层每次执行调用 `ctx.sandboxPolicy.resolve({ session, mode? })`（tool-bash `packages/shell/tool-bash/src/index.ts:199-200`；tool-fs `packages/fs/tool-fs/src/sandbox.ts:87-108`；str_replace_editor `packages/fs/tool-str-replace-editor/src/index.ts:75-79`）→ 把结果塞进 `ShellExecRequest.sandboxPolicy` / `writeText(..., sandboxPolicy)` → 执行器（`bash-sandbox.resolve`，`packages/shell/bash-sandbox/src/index.ts:84-86`）或 fs 后端（`fs-sandbox.checkedTarget`）按 per-call policy 执行。**默认化只发生在工具边界一次**，provider/executor 不再 re-default。

### 1.3 ConfinedArgv：把即将 spawn 的 argv 交给沙箱

这是整个沙箱设计的核心概念（`packages/sandbox/sandbox/src/index.ts:95-116` 及 abstract 方法 `:158-176`）：

```ts
export interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /** 该后端自己的 denial 方言（stderr 子串），而不是跨后端并集。 */
  denialSignatures: readonly string[]
  /** 结构化的 runner 失败证据规则（先于 denial 检查）。 */
  runnerFailureRules: readonly RunnerFailureRule[]
}
// abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
```

**"消费者把即将 spawn 的 argv 交给沙箱"的关键代码**在三处：

1. **bash-sandbox**（`packages/shell/bash-sandbox/src/index.ts:177-179`）——把 shell 形态的命令变成 argv 再交给沙箱：

```ts
private confine(command: string, policy: SandboxPolicy): ConfinedArgv {
  return this.ctx.sandbox.confine(['bash', '-c', command], policy)
}
```

  然后 `run()`（`:88-114`）与 `start()`（`:116-144`）**spawn 的是 `confined.argv` 而不是自己的 argv**，并把 `enforcement/denialSignatures/runnerFailureRules` 存入 per-process 的 `processFacts` Map（`:58-65`），在 `onProcessDone` 里完成结果归因（`:150-167`）。注释强调：provider 可能在重叠调用间变化 enforcement 和方言，所以事实必须 per-process 保存，不能共享"最后一次 wrap"的值。

2. **terminal-bash**（`packages/terminal/terminal-bash/src/index.ts:74-83`）——持久 PTY 的 argv 同样过沙箱：

```ts
function spawnArgv(ctx: Context, config: ResolvedConfig, policy: SandboxExecutionPolicy): string[] {
  const argv = [config.shellPath, ...config.shellArgs]
  if (policy.mode === 'danger-full-access') return argv
  const sandbox = ctx.get('sandbox')
  if (sandbox === undefined) {
    throw new Error(`terminal-bash: sandbox mode "${policy.mode}" requires a ctx.sandbox provider in the execution world`)
  }
  return sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
}
```

3. **配置 runnerCommand 时**（`sandbox-local/src/index.ts:316-333`）：`confine()` 返回 `[runner, ...profileArgs(policy), '--', ...argv]`，随后消费者的 subprocess spawn 直接吃这个前缀数组。

`RunnerFailureRule`（`packages/sandbox/sandbox/src/index.ts:81-88`）定义 runner 失败证据：`allowedExitCodes` 门控 + 逐行（先按不区分大小写的**整行相等**排除 `informationalLines`）匹配 `fatalSignatures`。**退出码本身永远不能证明 runner 失败**——这是第 4 号 postmortem（`docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md`）的直接教训：Landlock 的 partial 通知行与致命行共享前缀，导致 ripgrep 无匹配的 exit 1 被误判为 `SANDBOX_UNAVAILABLE`。

### 1.4 本地后端：按平台选链 + 功能探测

`sandbox-local`（`packages/sandbox/sandbox-local/src/index.ts`）按平台定义 runner 链（`:159-166`）：

```ts
const PLATFORM_CHAINS: Record<string, readonly SelectedRunner['runner'][]> = {
  linux: ['bwrap', 'landlock'],
  darwin: ['seatbelt'],
  win32: ['windows-acl'],
}
```

- **选链逻辑**（`chainVerdict` `:499-510`）：单候选**不探测**直接选（执行期拒绝仍会 fail-closed）；多候选按链序做**功能探测**（`probeRunner` `:513-539`，spawn 真实 profile 跑 `true`，超时 `probeTimeoutMs` 默认 5000ms，`:255`）。
- **Enforcement 是报告的"事实"而非承诺**：`STATIC_ENFORCEMENT`（`:177-187`）声明 bwrap/landlock/seatbelt 为 `full`，windows-acl 为 `partial`（WRITE_RESTRICTED 必须保留 Everyone 在 restricting 列表、NTFS 硬链接可跨路径别名同一文件对象）。
- **方言表**（`DENIAL_SIGNATURES` `:205-213`）：bwrap→`read-only file system`；landlock→`permission denied`；seatbelt→`operation not permitted`；windows-acl→`access is denied`/`access to the path`/`permission denied`。
- **runner 失败规则**（`RUNNER_FAILURE_RULES` `:231-240`）：landlock 是 exit-125 门控 + `landlock-run: ` 致命行 + 精确排除 partial 通知行；windows-acl 是 exit-127 门控 + `windows-acl-run: `。
- **profile 生成**（`packages/sandbox/sandbox-local/src/profiles.ts`）：bwrap 用 `--ro-bind / / --dev /dev --proc /proc --die-with-parent`，workspace-write 加 `--tmpfs /tmp` + `--bind workspace workspace`（`:16-23`）；landlock 用 `--ro / --rw /dev/null[/tmp/workspace]`（`:30-36`）；Seatbelt 用 SBPL `(deny file-write*)` + `(allow file-write* (subpath ...))`，其可写根来自共享的 `writableRoots`（`:51-57`）。

**可写根的唯一出处**是 `packages/sandbox/sandbox/roots.ts:52-55`：

```ts
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}
```

`canonicalPath` 用 `realpathSync.native`（`:30-41`）——Seatbelt 过滤器和 fs 围栏都按解析后的路径比较，所以 `/tmp` 在 darwin 上必须是 `/private/tmp`。Seatbelt 的 grant 和 in-process fs fence 都从这里派生，**"write 工具不能写 /tmp 但 bash 能写"的不对称在结构上不可能出现**（`roots.ts:5-11`）。

### 1.5 Windows：sandbox-windows-acl（受限令牌 + ACL 写授予）

`packages/sandbox/sandbox-windows-acl` 实现了 POC（windows-acl-restrict-poc）的机制：**WRITE_RESTRICTED 受限令牌**，其 restricting SIDs 里塞入能力 SID，写操作经 pass-2 检查只允许在持有该 SID Write ACE 的目录里发生（`src/index.ts:1-22`）。

- **SID 身份**（`src/workspace-sid.ts:35-54`）：workspace SID 从**规范化 workspace 路径**确定性派生（`S-1-4-x-y`），因此 workspace-root ACE **每个 workspace 每台机器只物化一次**（跨 session 复用缓存，`grant.add` 的 exact-ACE skip 让后续 provision 变 O(1)）；temp SID 从**随机**私有临时目录路径派生（`S-1-4-x-y-1`），兄弟 session 不能借共享 workspace SID 进入彼此的 temp 树。
- **grant 生命周期**（`sandbox-local/src/index.ts:392-443` `materializeAclGrant`）：workspace 授予**standing**（永不撤销——撤销会迫使下一个 session 重播整棵树）；私有 temp 授予**revocable**（provider dispose 时 `revokeAclGrants` `:454-477` 撤销并删除目录）。`AclWriteGrant`（`src/grant.ts`）负责 ACE 应用/撤销。
- **runner**（`src/runner.ts`）：seam 生成的 argv 前缀是 `[node, runner.js, '--workspace', <dir>, '--temp', <dir>, '--mode', <mode>, ('--write-sid','--temp-write-sid'), '--', <argv...>]`（`:9-14`）。带 SID 对 = seam 已物化 ACE（`manageDacls: false`，runner 只消费）；不带 = agentless，runner 自己 `mkdtemp` 私有 temp、自派生 SID、exit 后删除（`:155-159`）。`AclSandbox.spawn` 用 `CreateProcessAsUserW` 以受限令牌起子进程，**子进程从不无约束启动**；`stdio: 'inherit'` 时子进程进 kill-on-close job（`src/index.ts:351-389`）。
- **失败契约**：任何 runner 侧失败打印 `windows-acl-run: <detail>` 并 exit 127（`runner.ts:54-63, 220-225`）；runner 忽略自己的 CTRL+C 以便存活到回收 grant 并镜像子进程退出码（`:134-139`，全 32 位退出码镜像 `:207-219`）。
- **partial 的诚实声明**：Everyone 必须留在 restricting 列表（进程初始化需要）+ 硬链接别名，故该后端宣称 `partial`（`index.ts:181-187`），不会承诺做不到的绝对边界。
- **并发安全**（`acl.ts:8-12`）：grant/revoke 是对目录**当前 DACL** 的 read-merge-write，整段 get-merge-set 序列在 per-path 排他锁（`LockFileEx`，锁文件在 `<GetTempPathW>\dsh-acl-locks\<sha256(lowercased path)[0:16]>.lock`，`:55-58`）下执行——并发 sandbox 实例不会互相踩掉 ACE。`EXPLICIT_ACCESS_W` 结构由 `buildExplicitAccess` 手工打包（48 字节，`:34-44`），所有 Win32 调用都带 API 名 + 精确错误码 + 系统文本 + 受影响路径（`:4-6`）。
- **grant 生命周期**（`grant.ts:28-70`）：`AclWriteGrant.create` 解析 SID 字符串（fail-closed：任何失败即抛，尚未授予任何 ACE）；`add(path, standing?)` 幂等（已 standing 的 exact ACE 跳过整树重播，`grantWrite` 内实现 exact-ACE skip）；path 在授予**之前**记录（post-apply 抛错也要能撤销，撤销未授予路径是 no-op merge，`:64-68`）；workspace 路径 standing（ACE 是跨 session 复用缓存，dispose 不撤销），temp 路径 revocable（dispose 撤销，可继承 ACE 不得活得比 session 的 temp 目录久，`:19-27`）。
- **受限令牌与默认 DACL**（`index.ts:222-339`）：`init()` 用 `CreateRestrictedToken`（restricting SIDs = logon SID + Everyone + 能力 SID 列表，read-only 无能力 SID）后，还要 `setTokenDefaultDaclGrant` 给默认 DACL 并入一个全访问 ACE（私有 temp SID 优先，否则 workspace SID，read-only 用 Everyone）——否则受限进程新建的对象（匿名管道、同步对象）会因 pass-2 检查被拒而无法工作（`:285-297`）。`dispose()` 只撤销 revocable（temp）ACE，standing workspace ACE 保留（`:396-433`）。

### 1.7 权限升级路径小结

一次被拒后的模型可见流程（bash 与 fs 完全同构）：

1. 工具把错误映射成统一 marker：`[sandbox: file access denied under <mode> mode]`（`escalation.ts:71-73`；bash 侧由 `tool-bash` 的 renderer 依据 `result.sandbox.denied` 生成，fs 侧由 `FsSandboxController.mapError` 从 `FS_SANDBOX_DENIED` 生成）。
2. marker 后紧跟同轮提示：`[sandbox: escalation available — retry this exact <subject> once with sandbox_permissions ...]`（`:84-86`）。
3. 模型重试时带 `sandbox_permissions`（schema 枚举 = `ESCALATION_TARGETS`）+ `justification`；工具层在**任何东西执行前**调用 `approveEscalation`（`:157-189`）→ 严格更宽校验 → `ctx.approval.request` 弹审批 → `allowed-once` 把更宽 mode 盖到**这一次调用**的 policy 上（tool-bash `:334-339`；tool-fs `sandbox.ts:87-108`）。

### 1.6 Linux：landlock-run（自限制后 exec）

`native/landlock-run`（README: `native/landlock-run/README.md`）是一个 ~300 行 C11（musl 静态链接）的 launcher：**先在自己的进程上安装 Landlock ruleset，再 `execve` 被包的命令**；ruleset 随 `execve` 继承，被包命令及其所有子进程都受限，而调用方进程保持不受限（`README.md:5-7`，`packages/entry/src/main.c:4-11`）。

- **CLI 契约**（`main.c:13-23`）：`landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...` 以及 `--probe`。`--ro` = 读+执行；`--rw` = 完整文件系统访问；**未授予即拒绝（allow-list）**。
- **规则如何从 policy 生成**：`sandbox-local/profiles.ts:30-36` 把 policy 翻译成 grant 列表 → `entry/src/index.ts:94-99` `grantArgs` 拼成 `--ro/--rw` 参数。policy 语义（"workspace-write 可写哪些根"）由 seam 决定，launcher 包只知道"哪些路径授予读/写"（`entry/src/index.ts:8-10`）。
- **内核 ABI 协商**（`main.c:185-191, 230-262`）：`landlock_create_ruleset(NULL,0,VERSION)` 拿到 ABI 号，`fs_mask_for_abi` 把 handled 集合缩到内核支持的位；`PR_SET_NO_NEW_PRIVS` 之后 `landlock_restrict_self`。**ENOSYS/EOPNOTSUPP → 直接 fail-closed**（`:231-236`），绝不无约束 exec。
- **`--probe` 是真功能探测**：构建最大 ruleset 并在本进程实际执行，报告 `landlock: fully enforced` / `partially enforced (older ABI)`（`:269-283`）；entry 包 `probe()`（`entry/src/index.ts:116-127`）据此返回 `'full'|'partial'|'unusable'`。
- **失败契约**：任何 launcher 级失败打印 `landlock-run: ...` 并 exit 125（`:112-125`）；partial ABI 时打印精确的通知行 `landlock-run: partial enforcement (older Landlock ABI)` 后继续（`main.c:288-293`）——这就是 0004 号 postmortem 里要求精确区分的那一行。
- **分发**：`launcherPath()` 解析 `@deepseek-ai/node-addon-landlock-run-<platform>-<arch>` 平台包（`entry/src/index.ts:69-83`）；故意没有环境变量覆盖（"哪个二进制做限制绝不能由环境变量决定"，`:12-15`）。

### 1.7 fail-closed 错误语义与升级（escalation）

- **fail-closed 总则**：`SandboxProvider` 契约"必须返回 enforcing argv 或在 wrap/runner 执行期 fail closed；静默的无约束 passthrough 被禁止"（`sandbox/src/index.ts:152-157`）。不可用时 `confine` 抛 `SandboxUnavailableError`（code `SANDBOX_UNAVAILABLE`，`:124-144`），经 `HarnessError` 结构化错误通道到达工具结果，消费方可区分"缺少约束"与"命令失败"。
- **escalation 词汇**（`packages/sandbox/sandbox/escalation.ts`）是跨工具族共享的（`tool-bash` 与 `tool-fs` 共用，`:1-17`）：`WIDER_MODES` 严格更宽阶梯（`:28-31`）；`ESCALATION_TARGETS = ['workspace-write','danger-full-access']` 是 schema 广告的闭集（`:41`）；`sandboxDenialMarker`/`escalationHintMarker` 是模型面统一措辞（`:71-86`）；`approveEscalation`（`:157-189`）是**执行前**的 fail-closed 序列：先校验严格更宽（对调用生效模式，而非 schema），再解析 approval 通道，再映射每个 outcome；非更宽请求绝不打扰人类。`validateEscalationArgs`（`:51-61`）强制 `sandbox_permissions` 与 `justification` 成对出现。

---

## 2. 子进程 seam（`ctx.subprocess`）

### 2.1 SubprocessSpawnSpec：全字段、零默认

`packages/subprocess/subprocess/src/types.ts:75-104`：

```ts
export interface SubprocessSpawnSpec {
  /** argv[0] 是程序；这里绝不 shell 解释。 */
  argv: readonly string[]
  cwd: string
  stdio: SubprocessStdio                       // stdin/stdout/stderr 全显式
  graceMs: number                              // 正有限、≤ MAX_TIMER_DELAY_MS
  signal?: AbortSignal | undefined             // 触发进程树终止升级
  env?: NodeJS.ProcessEnv | undefined          // 显式 env，undefined 是墓碑
}
```

- **"本 seam 不应用任何默认"**（`:70-74`）：每个 disposition/limit/目录都显式，由调用方配置决定，以 `dsh-shell` 的 request/spec 分离为范本（owning template）。
- **stdio 词汇**（`:36-67`）：stdin `'ignore'|'pipe'|{data}`；stdout/stderr `'pipe'|'inherit'|SubprocessCollect`（`SubprocessCollect` = 内存上限 + 可选 spill 文件，`:44-52`）。
- **SubprocessOutcome**（`:113-118`）：只有 `exitCode` 与 `signal`——**故意不带超时/取消分类**（调用方读自己的 signal 来分类原因）、**不带输出**（collect 流在 settle 后仍可通过 `collected` 读取，批处理与流式调用方共享同一访问路径）。

### 2.2 DSH_* 环境词汇表（谁定义、谁消费）

- **命名空间**：`DSH_ENV_PREFIX = 'DSH_'`（`types.ts:13`），`DshEnvironmentKey = \`${'DSH_'}${string}\``，`DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>`（`:16-19`）。
- **scrub**（`packages/subprocess/subprocess/src/index.ts:44-66`）：`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`；`scrubbedParentEnv()` 移除凭证形态名 + 全部 `DSH_*` 名（大小写不敏感，覆盖 Windows）——这是每个 harness 子进程的规范基底；显式 `env` 在 scrub 之后合并，`undefined` 墓碑可删除普通环境项（`subprocess-local/src/spawn.ts:37-47` `childEnv`）。
- **注册表**：`packages/shell/shell-env/src/index.ts` 的 `ShellEnvRegistry.collect(execution)`（`:152-176`）构建每个 shell 调用的受信快照：
  - 内建：`DSH_HOME`（`:154`）、`DSH_SHELL=1`（`:155`）、有 agent 时 `DSH_SESSION_ID`（`:157-159`）；
  - 贡献者注册（`:110-145`）：key 必须以 `DSH_` 开头且后缀匹配 `/^[A-Z][A-Z0-9_]*$/`（`:79`），保留 key 不可被贡献者占用（`:74-78`）；返回值必须与声明一致，否则抛错（drift 保护，`:165-170`）；
  - `apply()`（`:201-216`）注册 `session-persistence` 贡献者：jsonl 后端在场时提供 `DSH_SESSION_JSONL`（session 日志路径）。
- **消费路径**：`tool-bash` execute 里 `const dshEnv = ctx.shellEnv.collect(exec)`（`tool-bash/src/index.ts:341`）→ `request.dshEnv` → `bash-local.spawnSpec` 的 env 合并顺序 `{ ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }`（`bash-local/src/index.ts:196`），dshEnv 最后合并、不可被调用方 env 顶掉 → `ctx.subprocess.spawn` 的 `childEnv` 在 scrub 基底上叠加。
- 其它 DSH_* 事实（grep 全局确认）：

| 变量 | 定义/消费处 | 语义 |
|---|---|---|
| `DSH_HOME` | `packages/credentials/credentials-local/src/index.ts:2-9`、`packages/identity/anonymous-user-id/src/index.ts:5-8`、shell-env 内建（`shell-env/src/index.ts:154`） | harness 主目录（`$DSH_HOME` > `~/.dsh`），凭据/附件/匿名 ID 的根 |
| `DSH_SHELL` | `shell-env/src/index.ts:155` | 恒为 `'1'`——标记"此 shell 在 DSH 管理下" |
| `DSH_SESSION_ID` | `shell-env/src/index.ts:157-159`；terminal-bash `:69` | 调用 session 的 header id |
| `DSH_SESSION_JSONL` | `shell-env/src/index.ts:203-216`（session-persistence 贡献者） | jsonl 持久化后端在场时提供 session 日志路径；测试证明它按 session 隔离（`tool-bash/tests/tools.spec.ts:1213-1225`） |
| `DSH_PTY_SESSION_ID` | `terminal-bash/src/index.ts:70` | PTY session 的注册表 id |
| `DSH_WEB_URL` | `packages/bundle/web-app/src/index.ts:67,153-155` | Web GUI 的规范本地 URL |
| `DSH_CRED_*` | `packages/credentials/credentials-local`（`$DSH_HOME/.credentials.yaml`） | 受管凭据命名空间（凭据文件用 `DSH_` 前缀 key） |
| `DSH_SNAPSHOT` | `packages/boot/app-boot/src/index.ts:56` | `'replay'` 切换快照重放 |
| `DSH_TELEMETRY_MODE` | `packages/bundle/base/tests/base.spec.ts:36` | 遥测开关 |
| `DSH_BUILD_FACE` | `packages/client/tsdown.client.ts:100,128` | 构建期 host/client 面选择 |

  关键纪律：**DSH_* 命名空间属于 harness，子进程的父环境 DSH_* 一律被 scrub，只有显式 `dshEnv` 快照能进入子进程**（`subprocess/src/index.ts:60-66` + `shell-env` collect）。test 里专门验证了"spoofed DSH_SESSION_ID 不会泄漏给命令"（`tool-bash/tests/tools.spec.ts:1161`）。

### 2.6 终端进程原语与 Linux 前台进程组探测

`spawnTerminal` 是 subprocess seam 里唯一的非管道原语（`subprocess/src/index.ts:139`、`types.ts:235-264`）：`SubprocessTerminalHandle` 拥有 `output`（UTF-8 字节流）、`write()`、`inspectForeground()`（前台 pgid + 是否在等 stdin）、`signalForeground(sig)`、`terminate()`（整终端会话清理到静默）。

- 本地实现 `LocalTerminalHandle`（`subprocess-local/src/terminal.ts:35-70`）：node-pty 之上包 `PassThrough` 输出流；`rootIdentity` 从 `inspector.processTree(pid)` 里取根（`pid+started` 二元组防 pid 复用）；exit 时 `output.end()` + settle `done`（信号名反查 `os.constants.signals`，`:19-25`）。
- **ProcessInspector**（`process-inspector.ts:14-25`）是平台进程表边界：`foregroundPgid`、`isStdinWaiting`（前台组是否阻塞在 stdin 读）、`processTree/processSession`（含 `started` 启动时刻）、`isAlive`、`signalGroup/signalProcess`。
  - **Linux 的 `isStdinWaiting` 非常"深"**：遍历 `/proc` 找到属于该 pgid 的进程，对每个 tid 读 `/proc/<pid>/task/<tid>/syscall`，按架构 syscall 表（`SYSCALLS` `:204-207`：x64 的 read=0/select=23/poll=7/ppoll=271/epollWait=232）判断是否在等 fd 0 上的 stdin（`syscallWaitsOnStdin` `:209-227`，select/poll/epoll 分别读 `/proc/<pid>/mem` 的 fd_set/struct pollfd 与 `fdinfo` 的 `tfd: 0`）——这是"前台命令是否已把控制权还给 shell"的可证明信号，支撑 send 的 `inferred_idle` wait reason。
  - Linux 实现（`:273-319`）：`foregroundPgid` 读 `/proc/<pid>/stat` 的 tpgid 字段；`isAlive` 比较 `started` 且排除僵尸态 `ZXx`。macOS（`:331-357`）退回 `/bin/ps -axo pid=,ppid=,lstart=`。
  - 该探测同时被**普通进程树的整树存活**复用：`spawn.ts:397` 的 `linuxProcessGroupHasLiveMembers(pid)` 在直接子进程 settle 后区分"组里只剩僵尸"（可安全停止发信号）与"还有活成员"。
- **会话生命周期**：`LocalTerminalHandle.terminate()` 按 `graceMs` 做 TERM→KILL 升级（扫描进程树/session 成员逐一 signal，`:70-249` 其余部分），`waitForExit` 观察整会话静默——与普通进程树的终止语义同构，只是探测面更深。

### 2.3 进程树 / 会话生命周期

`LocalSubprocessRuntime`（`packages/subprocess/subprocess-local/src/index.ts:37-185`）：

- **spawn 即 detached 进程树**：POSIX `detached: true`（自己的进程组），Windows 以根 pid 通过 `taskkill /T` 终止整树（`spawn.ts:350-361`）。
- **live 集与所有权**：`spawn()` 把 handle 放进 `this.live`，且**只在整棵树退出后**才释放所有权（`:146-157`）——一个会捕获 TERM 的 helper 若比 leader 活得久，必须仍被持有以便 teardown 升级；`done.then(release, release)` 里 release = `waitForExit()`。
- **正常 disposal**（`disposeManagedProcesses` `:79-102`）：先 `handle.terminate()`（升级），再 `done` + `waitForExit()` **等待整树**退出；失败则 `terminateForHostExit()` 兜底。
- **宿主退出同步兜底**：`process.prependListener('exit', ...)` 同步 `terminateForHostExit()`（`:49-60, 62-77`）——Node 同步退出阶段 force-stop 仍持有的树。
- **treeAlive 判定**（`spawn.ts:381-410`）：POSIX `process.kill(-pid, 0)`（ESRCH=absent，EPERM 视为 alive），Linux 在直接子进程 settle 后额外用 `/proc` 检查进程组是否只剩僵尸（`linuxProcessGroupHasLiveMembers`，`process-inspector.ts`）；Windows 以直接子进程未退出为界（taskkill /T 已带走整树）。第一次确认整树消失是"永不再发信号"的边界（防 pid 复用，`:417-425`）。
- **spawnTerminal**（`index.ts:161-184`）：本地经 `node-pty` 分配 PTY（`name: 'dumb'`、rows/cols、scrubbed env），包装成 `LocalTerminalHandle`（`terminal.ts`），纳入 `terminals` 集合并随 disposal 终止。

### 2.4 输出 offset 读取器（cursor-free 增量读）

`OutputCollector`（`spawn.ts:104-251`）：

- **tail-keep 内存窗口**：`push(chunk)` 维护 total/bytes/chunks，超 `maxBytes` 从头部丢块（或裁剪超长单块的头部，保证诊断 tail 恰好是最后 maxBytes，`:131-153`）；首次溢出时按需开 spill 文件，把**包括已收集块在内的全部内容**追加进去（`:156-173`）。
- **spill 安全**：`dsh-subprocess-<pid>-<seq>-<random>-<label>.log`，`wx`（O_EXCL）+ 0600 私有目录（`privateSpillDir` `:89-92`）——防符号链接种植与路径预测。
- **readFrom(fromByte)**（`:207-218`）：整流字节坐标、非消费性，`lossy` 表示请求 offset 已滑出内存窗口（缺口只能从 spill 恢复）；返回 `nextOffset` 供下次续读。**独立 reader 不会互相吞输出**（`types.ts:132-138` 契约）。
- **seal/finalize**（`:227-250`）：流结束关 spill 文件；`readFrom(0)` 在 settle 后就是批处理结果（lossy == truncated）。

### 2.5 kill 升级路径（唯一终止动词）

`terminate()`（`spawn.ts:439-453`）是 seam 唯一消费者可见的终止动词：

```ts
const terminate = (): void => {
  if (treeExitObserved || graceTimer !== undefined) return
  void observeTreeExit()                      // 从第一级就开始观察整树
  if (treeExitObserved) return
  kill('SIGTERM')                             // 信号整进程组（Windows: taskkill /T /F）
  graceTimer = setTimeout(() => { kill('SIGKILL') }, spec.graceMs)  // 升级必须活过直接子进程 settle
}
```

- `kill(sig)` 每次都重新探测**整树**存活（`:432-437`）：直接子进程 settle 不取消升级定时器（leader 死了不代表树死了），死树（可能是 pid 复用）绝不再被后续级信号命中。
- `signalTree`（`:290-315`）：POSIX 发 `-pid`（组），组消失回退直接子进程；Windows 一律 `taskkill /PID <pid> /T /F`（`:276-282`，结果故意不检查——idempotent teardown）。
- **abort signal 接线**：`spec.signal` 的 abort 事件即触发 `terminate()`（`:459-461`）；调用方拥有 deadline 与原因分类（`ShellRunResult.timedOut/aborted` 在 shell 层判定）。
- **pipe drain 边界**：子进程 exit 后，若后代继承了 collect 管道描述符，`pipeDrainTimer` 用同一 `graceMs` 强制 settle（`:490-497`）——幸存后代不能无限期吊住 outcome。

---

## 3. Shell seam（`ctx.shell`）

### 3.1 request/spec 分离：为什么默认值显式 resolve

`ShellExecutor.resolve(request) → ShellExecSpec`（`packages/shell/shell/src/index.ts:85`）是 seam 的显式化步骤：

- **Request**（`types.ts:38-79`）面向模型/插件：`command` 必填，`workdir/timeoutMs/stdoutMaxBytes` 可选，另有 `stdin/env/dshEnv/sandboxPolicy`（后三者是受信进程内插件输入，**model-facing bash 工具不暴露**，`shell.md:101-103`）。
- **Spec**（`types.ts:86-110`）：`workdir/timeoutMs/stdoutMaxBytes` 变为必填（`timeoutMs` 经 `clampTimeout` 夹到 `maxTimeoutMs`，`bash-local/src/index.ts:146-171`）；`start()` 忽略 `timeoutMs`（后台进程没有执行器超时）。
- 理由（"explicit > implicit at package boundaries"）：executor 的 `run/start` 永不 re-default、永不隐藏 `??`；配置（含 `installSettingsSection` 的运行时设置改写，`bash-local:128-136`）是默认值的唯一来源。

### 3.2 后台 ShellProcess

`start()` 立即返回 `ShellProcess`（`types.ts:161-183`）：`status: 'running'|'completed'|'killed'`、`exitCode/signal`、`done`（永不 reject，spawn 失败 settle 成 `killed` 且错误经 read 路径送达）、`sandbox` 事实（confined 进程 settle 时盖章）、消费性 `readOutput()`（offset 推进，stderr 以 `[stderr]` 段合并进 delta，`bash-local:289-309`）、`kill()`（幂等，false=已结束）。**作业语义（job id/owner/notice）属于 `ctx.jobs`，seam 只给进程句柄**（`shell/src/index.ts:1-6`；`tool-bash` 用 `jobs.start(...)` 包装 `ctx.shell.start(ctx.shell.resolve(request))`，`tool-bash/src/index.ts:365-377`）。后台进程由 `ctx.subprocess` disposal 而非 executor 停止——executor 热重载不杀后台进程（`shell/src/index.ts:60-64`）。

### 3.3 bash-local：如何通过 ctx.subprocess spawn

`LocalBashExecutor`（`packages/shell/bash-local/src/index.ts:102-331`）：

- `run()` = `runArgv(spec, ['bash','-c',spec.command])`（`:211-213`）；`runArgv`（`:223-240`）用 `dsh-timeout` 的 `deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')` 融合超时与取消，然后 `ctx.subprocess.spawn(spawnSpec(...))`。
- `spawnSpec`（`:175-198`）构造 `SubprocessSpawnSpec`：collect 模式 `{ maxBytes, spill: { maxBytes: config.maxSpillBytes } }`，stdin 批量 `{ data }` 或 `'ignore'`，`env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }`（ENV_OVERRIDES = `NO_COLOR/TERM=dumb/PAGER=cat/GIT_PAGER=cat`，`:27-32`）。
- 超时归因：`timedOut = timeoutOf(d.signal,'BASH_TIMEOUT') !== undefined`，`aborted = d.signal.aborted && !timedOut`（`:229-231`）——**第一个 cause 只报一个**（fused deadline，`types.ts:119-124` 的 first-cause 语义）。
- `startArgv`（`:255-318`）：两个 offset reader + 消费性 readOutput + spawnFailureNote 一次性投递。

### 3.4 bash-sandbox：如何包沙箱

`SandboxBashExecutor extends LocalBashExecutor`（`packages/shell/bash-sandbox/src/index.ts:44-180`）——**纯叠加**，不改本地机制：

- `inject = ['subprocess','sandbox','sandboxPolicy']`（`:45`）；`sandboxMode` getter 返回 `ctx.sandboxPolicy.defaultMode`（`:74-77`）——工具层据此广告 escalation schema 字段（`tool-bash:192-193`）。
- `resolve()` override 盖章 per-call policy：`request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`（`:84-86`）。
- `run()`：`danger-full-access` → 直接 `super.run`（`:91-94`）；否则 `confine(...)` 拿到 ConfinedArgv → `runArgv(spec, confined.argv)`（`:98`）；spawn 期 runner 缺失（`isRunnerSpawnFailure`）→ `SandboxUnavailableError`；settle 后**先判 runnerFailure 再判 denial**（runner 没跑 = 命令没执行；`:107-113`）。
- 后台：`start()` 里 wrap 后同步装 `processFacts`（`:122-143`），`onProcessDone` 盖章 `proc.sandbox = { mode, denied, enforcement, runnerFailed }`（`:150-167`）。
- 分类助手（`helpers.ts`）：`isRunnerSpawnFailure`（`:39-53`，ENOENT/EACCES + error.path 精确等于 runner + 排除调用方 cwd 不可用）+ `classifyRunnerFailure`（`:81-103`，按规则逐行）+ `matchesSignature`（`:112-116`）。

### 3.5 pwsh 执行器

`PwshLocalExecutor`（`packages/pwsh-local/src/index.ts:128-360`）是 bash-local 的逐调用镜像（刻意镜像，jscpd 忽略标注 `:16-17,28`）：

- `argv()`（`:217-219`）= `[pwshPath, '-NoLogo','-NoProfile','-NonInteractive','-Command', ENCODING_PREAMBLE + command]`；命令作为**单个 argv 元素**给 `-Command`，由 PowerShell 自己解析——没有中间 shell，因此不存在 `bash -c` 那种引号转义层（`:6-11`）。
- `ENCODING_PREAMBLE`（`:48-49`）钉死 UTF-8 输出（Windows PowerShell 5.1 默认 OEM 码页会乱码）。
- `pwshPath` 解析（`resolve.ts`）：显式配置 > 已知安装位置/PATH 探测 > 裸 `pwsh`；settings 变化时重新解析（`:175-180`）。
- 预留 `argv/runArgv/startArgv` 的 protected 钩子，供 `pwsh-sandbox` 以 bash-sandbox 同样方式 wrap（`:211-215, 349-359`）。

### 3.6 渲染契约：`[exit code: N]` 标记

`packages/shell/shell/src/render.ts:36-42` 的 `parseExitStatus` 是 shell 工具渲染标记（`[exit code: N]` / `[killed by signal: X]`）的**反向解析**：终端展示层只持有渲染文本（重放没有原始 `ShellRunResult`），所以必须从文本尾部把退出状态 pill 剥出来；要求"前导换行 + 字符串结尾"防止普通输出误匹配（`:28-32`）。其他标记（timeout、sandbox denial）携带 pill 不展示的事实，留在 body 里（`:23-26`）。`tool-bash` 的 `renderResult`（`tool-bash/src/index.ts:323-328`）与 `tool-pwsh` 共用此契约。

---

## 4. FS seam（`ctx.fs`）

### 4.1 词汇（FsTarget / 结果 / 错误）

`packages/fs/fs/src/types.ts`：

- **不透明标识**：`FsTargetKey`/`FsVersion` 都是 branded string（`:16-45`）；消费方**禁止解析** targetKey（本地后端用 realpath 字符串，远程后端可能是 URI/file id）。
- **FsTarget**（`:60-68`）：`targetKey`（稳定身份）+ `displayPath`（模型/UI 展示，随后端而异）。
- **观察**：`FsObservation = present(version) | absent`（`:52-54`）。
- **写意图/结果**：`FsWriteIntent = createIfAbsent | replaceIfVersion(version)`（`:123-125`，省略 = 无条件 create-or-overwrite，不是第三分支）；`FsWriteOutcome`（`:128-144`）带 `operation: 'create'|'update'`、`version`、LF 归一化的 `before`（diff 基础，可能为 null）与 `after`。
- **编辑**：`FsEditRequest {oldString,newString,replaceAll}`（`:147-154`）、`FsEditOutcome {version,before,after}`（`:157-168`）。
- **错误分类**：`FsErrorCode` 13 个稳定机器可路由码（`:175-188`），`FsError extends HarnessError`（`:196-202`）。

`FileSystem` 抽象（`packages/fs/fs/src/index.ts:86-250`）：`resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText`。**processPath 是执行世界的桥**："返回该 fs 执行世界中子进程可打开的规范绝对路径"（`:118-126`）——消费方把 targetKey 当不透明，但可把 processPath 交给另一个 OS 能力。三个事件（`:49-77`）：`fs/write-intent`、`fs/edit-intent`（单槽 waterfall 决策）、`fs/observed`（同步 emit 记录）。

### 4.2 观察策略（read-before-edit、fs/observed）

`packages/fs/fs-observation-policy/src/index.ts` **不注册服务，只注册事件监听器**（事件即策略 seam）：

```ts
class ObservedStateGate {
  private observed = new WeakMap<object, Map<string, FsObservation>>()   // owner(session) → targetKey → 观察
  writeIntent(target, actor) {
    const prior = this.get(owner, target.targetKey)
    return prior?.kind === 'present'
      ? { kind: 'replaceIfVersion', version: prior.version }   // 读过 → CAS 写
      : { kind: 'createIfAbsent' }                             // 没见过/确认不存在 → 只允许创建
  }
  editIntent(target, actor) {
    if (!owner || prior === undefined) throw new FsError(`edit requires reading "${...}" first`, 'FS_NOT_OBSERVED')
    if (prior.kind === 'absent') throw new FsError(`cannot edit ...: not found`, 'FS_NOT_FOUND')
    return { version: prior.version }
  }
  observe(target, observation, actor) { ... }                  // 'fs/observed' 同步记录
}
```

- owner 从 opaque actor 结构上取出 `agent.session`（`:36-41`，`types.ts:23-29`），WeakMap 弱持有 → session 被回收即释放状态。
- `apply()`（`:106-129`）挂三个监听：两个 intent waterfall **占满单槽且不调用 next()**（裸 provider = 无条件行为被替换）；`fs/observed` 必须同步不抛（emit 不 await）。
- 工具侧：`tool-fs/write.ts:111-122`——`ctx.waterfall('fs/write-intent', target, exec, () => undefined)` 拿 intent → `writeText` → `ctx.emit('fs/observed', target, {kind:'present', version: outcome.version}, exec)`。**没有 stat**：bare 默认永不制造 version 基准（`write.ts:1-5` 注释）。edit 同构（`edit.ts:112-120`）。
- 系统提示词里的 read-before-edit 措辞（`write.ts:63-67`、`edit.ts:77-81`）直接引用默认观察策略。
- 本地原子性：`fs-local/src/index.ts:91-104` 的 `withLock(targetKey)` 按 targetKey FIFO 串行化 mutating 操作，使 read→guard→write 窗口确定性有序（`:74-77`）；`editText` 在锁内 probe→stale check→readForEdit→applyLiteralEdit→writeFileAtomic（`:221-255`）。

### 4.3 fs-sandbox：按模式限制变更

`SandboxedFileSystem extends LocalFileSystem`（`packages/fs/fs-sandbox/src/index.ts:59-149`）：**只给两个变更操作加 per-call policy 围栏，读全部放行**。`checkedTarget`（`:126-148`）：

```ts
private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
  const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
  const { mode } = policy
  if (mode === 'danger-full-access') return target
  if (mode === 'read-only') {
    throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
  }
  // workspace-write: containment on the FRESH canonical path（捕获 resolve 后换掉的符号链接祖先）
  const fresh = await this.resolve(target.displayPath)
  for (const root of writableRoots(policy)) {
    if (await isPathUnder(fresh.targetKey, root)) { contained = true; break }
  }
  if (!contained) throw new FsError(..., 'FS_SANDBOX_DENIED')
  return fresh   // 返回“刚检查过的那个 target”去写 —— 没有 check-here-write-there TOCTOU
}
```

- **fence 是可信代码里对模型控制路径的策略检查，不是内核边界**——模块文档（`:10-18`）明说：操作是 seam 自己的 open/rename，只有目标路径不可信，canonicalize-then-contain 就是完整答案；对不可信**代码**的内核级隔离是 `ctx.shell` 的活（bash-sandbox）。与 code-runtime 同款姿态："containment, not a security boundary"。残余 TOCTOU（检查与 syscall 之间祖先 symlink 被换）由"委托前立即重新 canonicalize"收窄并被该威胁模型接受。
- **可写根与 Seatbelt 同源**：`writableRoots(policy)` 来自 `dsh-sandbox/roots.ts`——bash 与 fs 不会漂移（`:22-25, 38-39`）。
- **拒绝是结构化错误**（`FS_SANDBOX_DENIED`），不需要像 bash 那样从内核 stderr 推断文本。工具层 `FsSandboxController.mapError`（`tool-fs/src/sandbox.ts:124-130`）把它映射成模型面统一的 `[sandbox: file access denied under <mode> mode]` + 同轮 escalation 提示，同时保留结构化 code 供 retry/observer 分支。

### 4.4 tool-fs 的 UI 呈现意图（generic / terminal / diff）

工具通过 `presentCall`/`presentResult`（`dsh-tools` 的 view 契约）表达 UI 卡片意图，且**带元数据可重放**：

- `read` → `card: 'generic'`，`kind: 'read'`，标题 `Read <path> (offset - end)`，带 `locations`（`read.ts:196-202`）；结果把结构化窗口放 `presentationMeta`（`FsReadMeta`，`read-render.ts:220-231`），`presentResult` 从 meta 严格校验后还原 read 卡片（`readMetaFromMeta` `:258-272`，非法数据回退 generic）。
- `write`/`edit` → `card: 'diff'`，调用期用 args 画 diff（write 的 `oldText: null` 代表覆盖，`write.ts:132-139`），结果期优先用 `computeHunkDiffs(before, after)` 的上下文 diff（`diff.ts`），meta 缺失回退 args 全量 diff（`write.ts:143-148`、`edit.ts:151-165`）。
- `read_image` → generic（`read-image.ts:215-217`）。
- `str_replace_editor` → 按命令选择 generic/diff（`tool-str-replace-editor/src/index.ts:383-408`）。
- `tool-fs-search`（grep/glob）→ `card: 'generic'`、`kind: 'search'`、`rawInput`（`presentation.ts`，grep.ts:244、glob.ts:269），结果 meta 还原同样带防御性校验（`presentation.ts:176` 附近）。
- 术语澄清：`terminal` 卡片不在 fs 工具里；"generic/terminal/diff"三意图中 fs 族实际用 generic（read/search/image）与 diff（write/edit/str_replace），"terminal"意图属于 `tool-terminal`/`tool-bash-persistent` 的 PTY 视图。

### 4.5 本地后端的原子写与读路径（补充）

- **原子写**（`fs-local/src/fsio.ts:540-615`）：同目录私有 staging 目录（`.basename.pid.uuid.tmpdir`，0700）→ 临时文件 `open('wx')` 0600 → Windows 上复制目标 DACL（`copyFileDacl`，保留被覆盖文件的 ACL）→ `writeFile + sync` → 发布：`createIfAbsent` 用 `link`（已存在则 `FS_NOT_OBSERVED`，`throwGuardedCreateFailure` 校验目标）；Windows 有 mode 时用 `replaceFile`（ENOENT 回退 `rename`）；其余 `rename`。staging 清理失败不翻转已提交的写（`:596-600`）；abort-mid-write 映射为 `FS_ABORTED`（`:603`）。同目录 staging + rename 保证**同文件系统原子替换**，且目录 0700 避免临时文件被窥探。
- **读路径**（`tool-fs/src/read.ts`）：`stat` 先拿 `size`——`size ≥ streamMinSize` 走 `streamText`（chunk 扫描），否则 `readText`；`read-render.ts:111-144` 的 `buildWindow` 在 chunk 流上同时施加 offset/limit/maxLineLength/maxBytes 三重上限并**仍扫出精确总行数**（超 offset 报 `FS_NOT_FOUND`，`:96-99`）；每行超长截断加后缀（`:69-71`）。观察事件：read 成功后 emit `fs/observed {kind:'present', version}`（`read.ts`），这是后续 write/edit 的 CAS 版本来源。
- **tool-fs-search**（`packages/fs/tool-fs-search/src`）：grep/glob 两个模型面工具，底层是**打包的 ripgrep**（`ripgrep.d.ts` + `search-core.ts`），经 subprocess seam 以 collect 模式运行——即**文件搜索也走"执行世界"的子进程**（postmortem 0004 特别注明它"不跨沙箱化 bash"，避免把 `SANDBOX_UNAVAILABLE` 藏成 `SEARCH_FAILED`）。`presentation.ts` 定义 search 结果 meta 的防御性还原（非法 meta 回退 generic）。`direct-call.ts` 支持进程内直接调用（不经过工具注册表）。
- **tool-str-replace-editor**（`packages/fs/tool-str-replace-editor/src/index.ts`）：Claude Code 风格的多命令工具（`view/create/str_replace/insert`）建在 **`ctx.fs` + `ctx.sandboxPolicy`** 之上（`MutationPolicy` `:65-86`，mapError 只转 `FS_SANDBOX_DENIED` 为 marker；`resolveTarget` 强制绝对路径，`:88-98`）；`statExisting`（`:100-121`）在 stat 缺失时**主动 emit `fs/observed {kind:'absent'}`**——观察策略因此也能记录"确认不存在"（禁止后续 edit 但允许 createIfAbsent）；view 渲染 `cat -n` 风格行号 + `view_range` 校验（`:136-183`），目录 view 只列非隐藏且跳过 `node_modules`/`__pycache__`（`:191-199`）。它是"同一 fs seam 上再长一个工具族"的例证：观察策略与沙箱围栏对它同样生效。

---

## 5. 终端 seam（`ctx.terminals`）与 code-runtime

### 5.1 PTY 会话契约

`TerminalSessionService`（`packages/terminal/terminal/src/index.ts:105-474`）是**owner-scoped 的持久 PTY 注册表**——"后端拥有终端机制，本服务拥有 id、发布、授权与等待完成的清理"：

- **spawn 契约**（`:154-224`）：`spawn(owner, {type, name?, cwd?}, signal)` → 保留 name（owner 局部）、预留 pending spawn（`reserveSpawn` `:350-365`，可被 owner 清理 abort）→ 后端 `backend.spawn` → 发布前再验证 `disposing` 与 owner 存活（`:179-184`）→ 失败时回滚 close 未发布的 session（`:200-219`）。
- **授权**：所有操作经 `expectOwned`（`:387-392`）——未知 id → `NO_SESSION`，异主 → `FOREIGN_SESSION`。
- **send 是排他操作**：每 session 同时最多一个 `TerminalSendOperation`（`:243-254`，`SEND_ACTIVE`），`done` 按 `TerminalWaitReason = 'stdin_read'|'inferred_idle'|'timeout'|'session_exit'`（`types.ts:29`）settle；`cancel()` = 请求 SIGINT。
- **清理三路径**：`kill(owner,id)`（`:285-301`，幂等）；owner 被 dispose（`ensureOwnerCleanup` `:322-333` → `disposeOwned`）；服务 dispose（`disposeAll` `:435-454`，best-effort：一个卡住的 session 不能连坐其他 session）。
- **信号面**：`TerminalSignal = 'SIGINT'|'SIGTERM'|'SIGKILL'|'SIGTSTP'|'SIGHUP'`，与 subprocess 的 `SubprocessTerminalSignal` **逐成员一致**但刻意不跨 seam 依赖（`types.ts:36` 与 `subprocess/types.ts:201` 双向注释）。
- **terminal-bash 后端**（`packages/terminal/terminal-bash/src/index.ts`）：`inject ['terminals','sandboxPolicy','subprocess']`（`:25`）；用 `ctx.subprocess.spawnTerminal` 起 PTY（`session.ts` 的 `LocalPtySession` 包 `SubprocessTerminalHandle`）；子环境注入 `DSH_SHELL/DSH_SESSION_ID/DSH_PTY_SESSION_ID`（`:55-72`）；**sandbox/mode 围栏**（`:34-53`）：session 打开期间禁止切换 sandbox 模式（`internal/dispatch` 拦截 `sandbox/mode` 事件，有活动 PTY 则抛错）——PTY 进程树无法随模式切换重新约束。
- 工具面：`tool-terminal` 的 `terminal_open/send/read/signal/close` + `tool-bash-persistent` 的持久 bash（owner-isolated）。

### 5.2 code-runtime：CodeRunRequest/Result、绑定命名空间

`packages/code-runtime/code-runtime/src/index.ts:102-135`：`CodeRuntime.run(request)` + 两个只读描述符 `language`（'typescript'|'python'，informational）+ `isolation`（'worker-thread'|'process'|'container'，**诊断标签而非安全声明**）。共享保留集：

- `RESERVED_BINDING_GLOBALS = {console, __dsh_main__, __builtins__, __name__, __debug__}`（`:40-43`）——**跨后端统一的保留集**保证"一个后端合法的命名空间列表在所有后端都合法"（Python 后端的 `__debug__` 是编译期常量，注入不可达）。
- `RESERVED_ERROR_MEMBERS`（`:55-58`）+ `DUNDER_MEMBER /^__.+__$/`（`:64`）+ `PORTABLE_RESERVED_WORDS`（ECMAScript ∪ Python 保留字并集，`:76-87`）——添加新语言 = 必须审查拓宽该并集（by design）。
- `CodeBindingNamespace {global, functions, errorClass?}`（`types.ts:49-65`）：`global` 必须匹配语言可移植标识符 `[A-Za-z_][A-Za-z0-9_]*` 且非保留字（`$tools` 这种 JS-only 拼写被刻意拒绝）；函数名是任意字符串，**运行时必须以 null-prototype 处理 `__proto__`/`constructor`**。
- `CodeRunRequest {program, bindings, signal}`（`:73-89`）；`CodeRunFailure.kind = 'exception'|'timeout'|'abort'|'worker-exit'|'invalid-output'|'output-limit'`（`:103-108`）；`CodeRunResult {value?, logs, error?}`（`:115-127`）——**error 是结果字段，run() 永不 reject**（与 `ShellExecutor.run` 的 resolve-on-failure 契约一致）。

### 5.3 worker-thread 后端

`WorkerThreadCodeRuntime`（`packages/code-runtime/code-runtime-worker-thread/src/index.ts:238-559`）：

- **每 run 一个全新 Worker**（`:378-393`）：`env: {}`（比 scrub 更彻底）、`execArgv: []`（不继承 tsx/test-runner 的 loader hooks）、`resourceLimits.maxOldGenerationSizeMb`（溢出 → `worker-exit`）；程序经 `node:module` 的 `stripTypeScriptTypes` 去类型（`STRIP_WRAP` 包成 async 函数体，位置保持，`:84, 302-309`）。
- **预算**：`computeMs` = 事件循环**忙时**（`eventLoopUtilization` 每 25ms 采样，`:537-542`，忙时计量不可游戏化、await 慢绑定不累计）；`maxWallMs` 兜底（`:543-545`，必须 ≤ `MAX_TIMER_DELAY_MS` 否则 setTimeout 会钳成 1ms，`:267-269`）。
- **hostile-peer 端口**（`:142-165` parseWorkerMessage 逐字段重建，`:462-507` onCall）：重复 id 忽略、未知名回 failure、绑定 throw 变成程序侧 rejection；`Object.hasOwn` 防原型链伪造。
- **输出账本**（`OutputLedger` `:169-229`）：logs/完成值/失败消息合一个字节上限，超限报 `output-limit` 并保留日志前缀。
- **worker 侧**（`worker.ts:1-14` 是纯胶水，逻辑在 `bootstrap.ts` 里以"普通函数 + 注入 port"形式编写以便单测在进程内跑每行）：`runWorkerMain` 在 worker 里把程序包成 async 函数执行（`STRIP_WRAP` 已被 host 剥过类型）、patch `console`/`process.stdout.write` 捕获有序日志（`LogBuffer`，`bootstrap.ts:49-60`，同样按 JSON 字节记账）、注入命名空间全局（null-prototype 对象 + `Object.hasOwn` 查函数名）、按声明物化 `errorClass` 错误构造器（`defineBindingErrorField` 用捕获的 `Object.defineProperty` 写 memberNameProperty，`bootstrap.ts:17-23`）、经 port 以 `WorkerToHost` 消息流式回传日志并最终回 `done`（`protocol.ts` 定义 `call/log/done/output-limit/reply` 消息形状）。host 侧 `parseWorkerMessage`（`index.ts:142-165`）对每一条入站消息**逐字段重建**——peer 是模型代码，可能 post 任何形状（`index.ts:133-141` 注释："forged extra field never rides along; a non-number call id can never be echoed into a reply"）。
- **teardown**（`:278-283`）：标记 disposed → 所有在飞 run settle 为 abort → **await 每个 worker 退出**（无 worker 活得比 fiber 久）。

### 5.4 工具面与输出净化的契约

- **tool-terminal**（`packages/terminal/tool-terminal/src/index.ts`）：六个模型面工具（spawn/send/read/signal/close/list，`render.ts` 渲染）。owner 身份 = 执行时的**精确 Agent 对象**（`:2-3`）；后台 send 复用通用 `ctx.jobs`（扩展 `JobKindMap['pty-send']`，`:18-22`）；`maxResultBytes` 默认 256KiB 封顶一次完整终端结果（`:30-46`）。
- **终端输出净化**（`terminal-bash/src/sanitize.ts`）：流式 `TerminalSanitizer` 剥掉 CSI/OSC/短转义序列（保留跨 chunk 的拆半序列，`:24-60`），可识别受控 shell 的私有 OSC 标记 `133;D;`（`PROMPT_MARKER_PREFIX`，`:6`）与受控提示符 `dsh> `（`CONTROLLED_PROMPT`，`:9`）——这是"前台命令已回到 shell 提示符"的**可证明**信号，支撑 send 的 `inferred_idle` wait reason。`terminal-bash/src/index.ts:55-72` 的子环境用 `PROMPT_COMMAND` 在每次提示前重打标记并重设 `PS1`（命令覆盖 PS1 也不影响下次提示的 readiness）。
- **终端模式冻结围栏**（`terminal-bash/src/index.ts:34-53`）：以 `internal/dispatch` 全局监听 `session/event`，当事件是 `sandbox/mode` 且该 owner 有活动 PTY（`terminals.hasOwnerActivity`）时**抛错拒绝切换**——PTY 进程树一旦以某模式约束，无法安全重约束，这是"执行世界"里少数在工具运行时冻结策略的状态机。

---

## 6. LSP 与 E2B（快速浏览）

### 6.1 LSP

- `packages/lsp/lsp/src/index.ts`：`ctx.lsp` 服务 + provider 注册表；操作是**闭集** `'goToDefinition'|'findReferences'|'goToImplementation'|'hover'`（`docs/subsystems/lsp.md:19`），新增操作是跨 seam/provider/tool 的编译期改动。`LspQueryRequest` 全字段必填——**没有 resolve() 步骤**（`lsp.md:40-42`）。
- `lsp-stdio`（`packages/lsp/lsp-stdio/src/host.ts:32-59`）：`canonicalizeWorkspace` 通过 **`ctx.fs`** 把 workspace 解析成 `FsTarget`，再取 `fs.processPath`（子进程 cwd）与 `fs.fileUrl`（LSP 初始化 URI）——**LSP 主机显式站在 fs/subprocess 共享执行世界里**。`framing.ts:19-40` 是 `Content-Length` 分帧编解码（`MAX_HEADER_BYTES` 64KiB + `maxMessageBytes` 上限防敌意/损坏 server 耗尽内存）；`connection.ts`/`instance.ts` 用 subprocess 的 raw pipe（`stdio: 'pipe'`）做 JSON-RPC 传输，LSP server stderr 用"诊断 tail"形态（无 spill 的 collect）捕获；`translate.ts` 负责 seam 坐标 ↔ 协议坐标（零基 UTF-16 ↔ 工具的一基行号）换算。

### 6.2 E2B：远程沙箱如何作为 provider 替换

- `packages/e2b/e2b/src/index.ts:1-4` 开宗明义："**Capability adapters await the same SDK handle, so filesystem and process operations inhabit one remote Linux world**"——`E2BRuntime`（`:74-182`）懒创建单一 `Sandbox`（`secure: true`、`onTimeout: 'kill'`、私有 `runtimeRoot` 权限 700，`:151-179`），teardown `sandbox.kill()`。
- `subprocess-e2b`：`E2BSubprocessRuntime extends SubprocessRuntime`，`inject ['e2b']`（`packages/e2b/subprocess-e2b/src/index.ts:52-57`），pollMs 轮询远程状态；`fs-e2b`：实现 `FileSystem` 于远程沙箱文件系统（base64 编码规范路径、dsh-version 元数据、远程原子暂存写，`packages/e2b/fs-e2b/src/index.ts`）。
- **迁移证据**：加载 `e2b + fs-e2b + subprocess-e2b`（替换 `fs-local + subprocess-local`）后，`bash-local`/`tool-bash`/`tool-fs`/lsp 消费方**零改动**——因为消费方只见 seam 抽象；`quoteE2BShellArg`/`e2bControlEnvs`（随机 HOME 隔离 E2B 硬编码 login shell，`e2b/src/index.ts:27-40`）是适配器内部细节。这印证 sandbox.md:5 的说法："容器、microVM、远程执行是**整套能力 seam 的兄弟实现**，而不是 `ctx.sandbox` 的 provider"。

---

## 7. 设计哲学观察

1. **"同一执行世界"是硬契约，有四处代码证据**：
   - `subprocess/src/index.ts:81-82`："Executable paths belong to one execution world shared with the mounted filesystem provider"；
   - `fs/src/index.ts:118-126`：`processPath`/`fileUrl` 显式地把 fs target 翻译成"该世界子进程可打开的路径 / file: URI"（消费方如 LSP host、ACP 子代理用它取 cwd）；
   - `fs-e2b + subprocess-e2b` 共享同一个远程 `Sandbox` 句柄（`e2b/src/index.ts:1-4`）；
   - `bash-local.spawnSpec` 的 `cwd: spec.workdir` 直接来自 session cwd（与 `sandboxPolicy.workspaceRoot` 同源，`sandbox-policy:139`）。
   因此"换 provider 整体迁移"（本地 → E2B）时，fs 与 subprocess 必须**成对**替换，路径/进程命名空间才仍然一致——这正是 seam 抽象保证的替换单元。

2. **Seam 三件套的严格纪律**：每个能力 seam = 抽象 Service Definition（`ctx.x`，含类型词汇 + 契约 JSDoc）+ 至少一个 Service Provider（本地实现，注册同名服务，加载第二个会因 cordis 重复服务抛错）+ Consumer（执行器/工具）。`docs/capability-seams.md` 的表格逐行标注（如 `ctx.sandbox` seam：`sandbox`/`sandbox-local`/`bash-sandbox`+`terminal-bash`，`:451`）。sandbox 在这里最纯粹：`confine(argv, policy)` 一个方法，三平台四 runner 全部藏在 provider 后面。

3. **沙箱与工具解耦，但 hooks 横跨工具族**：沙箱词汇（模式、denial marker、escalation 序列）在 `dsh-sandbox` 包里，被 `tool-bash` 和 `tool-fs` **两个族**共享（`escalation.ts:1-17`）；`FsSandboxController`（`tool-fs/src/sandbox.ts`）与 bash 工具用同一个 `approveEscalation`/`sandboxDenialMarker`；`ctx.sandboxPolicy` 是唯一 policy 所有者，被 fs/bash/terminal 三个 enforcing 消费族读取（`sandbox-policy:10-16`）。工具层只做三件事：schema 广告（按 `sandboxMode` 能力事实）、per-call 解析、错误映射——不重复任何沙箱逻辑。

4. **"显式 > 隐式（package 边界）"**：`SubprocessSpawnSpec` 零默认、`ShellExecRequest → resolve() → ShellExecSpec`、`LspQueryRequest` 无 resolve、`CodeRunRequest` 不带隐藏 `??`（默认是实现的**校验过**的 config）——默认值一律在消费者/配置边界显式结算。

5. **事件即策略 seam**：`fs/write-intent|edit-intent|observed` 让观察策略插件**不加服务**就改变工具行为（裸 provider = 无条件写）；`sandbox/mode` 事件让 session 日志成为模式状态的唯一存储（重放即状态，无外部配置存储）；`internal/dispatch` 被 terminal-bash 用来做"有活动 PTY 禁止切模式"的围栏——策略通过事件叠加，可移除而不破坏工具。

6. **报告事实而非解释**：enforcement 是报告的（`full|partial`）、denial/runnerFailure 是分类的（`ShellSandboxInfo`）、方言是 per-backend 的（`denialSignatures` 不跨后端并集）——消费方不猜内核在干什么；同时**fail-closed 是绝对底线**：`SandboxUnavailableError`（wrap 期）、landlock exit 125 + 致命行（runner 期）、windows-acl runner exit 127 + `windows-acl-run:`（runner 期）、`AclSandbox` "child is NEVER spawned unrestricted"、worker-thread 无环境无 execArgv——任何环节证伪约束即拒绝执行。

7. **containment vs security boundary 的姿态**：fs-sandbox 的 fence 与 code-runtime 的 worker 都自称"containment, not a security boundary"；真正的不可信代码隔离委托给 `ctx.shell` 的内核沙箱（bwrap/landlock/seatbelt/windows-acl）。层次清晰：工具路径（可信代码，策略围栏）< 一次性命令（内核约束）< 持久 PTY（约束 + 模式冻结围栏）。

8. **"报告事实"延伸到结果分类的每个角落**：`ShellSandboxInfo` 的 `mode/denied/enforcement/runnerFailed` 与进程退出状态**正交**（`shell/src/types.ts:16-30`）；`ShellRunResult.timedOut/aborted` 是 first-cause 互斥（`types.ts:119-131`）；`TerminalSendResult.waitReason` 与 `sessionStatus` 独立（`terminal/src/types.ts:82-91`）；`CodeRunResult.error` 是字段而非异常（`code-runtime/src/types.ts:110-127`）。整条执行栈的共识：**把分类交给消费者，把事实交给结果**。

9. **失败必须可归因**：subprocess 的 spawn 失败 reject、shell 层把 spawn 失败 settle 成 `killed` 并从 read 路径送达、bash-sandbox 区分 runner 缺失（`SandboxUnavailableError`）与约束内 denial、windows-acl runner 用 `windows-acl-run:` + 127 自证失败、landlock 用 125 + 致命行 + 精确信息行排除——每个失败路径都有机器可路由的结构化信号（错误码/签名/规则），没有"猜"。

10. **settings/事件/注入三种策略改写通道并存且不重叠**：执行器配置经 `installSettingsSection` 运行时改写（bash-local/pwsh-local）；沙箱模式经 session 日志事件折叠（sandbox-policy）；观察/意图经 `fs/*` 事件叠加（fs-observation-policy）——三者分别改写"执行参数""执行策略""工具行为"，各守各的包边界。

---

## 8. 端到端调用链走读（三条主线）

把上面所有部分串起来，看三条从模型输入到内核/文件系统的完整链路。

### 8.1 主线一：`bash` 工具执行一条受限命令

```
模型参数 { command, description, workdir?, timeoutMs?, sandbox_permissions?, justification? }
  → tool-bash execute（packages/shell/tool-bash/src/index.ts:330-390）
      ├─ resolveSandboxPolicy(exec) = ctx.sandboxPolicy.resolve({session})   // :199-200
      ├─ （若升级）approveBashEscalation(...) → approvedMode                  // :334-339
      ├─ dshEnv = ctx.shellEnv.collect(exec)                                  // :341
      ├─ request = { command, workdir, dshEnv, sandboxPolicy }                // :342-348
      ├─ run_in_background ? jobs.start(run: ctx.shell.start(ctx.shell.resolve(request)))  // :365-377
      │                    : ctx.shell.run(ctx.shell.resolve({...request, signal}))         // :380-383
  → bash-sandbox.resolve 盖章 policy（bash-sandbox/src/index.ts:84-86）
  → SandboxBashExecutor.run（:88-114）
      ├─ policy.mode === 'danger-full-access' ? super.run（不碰 ctx.sandbox）: 继续
      ├─ confined = ctx.sandbox.confine(['bash','-c',command], policy)       // :177-179
      │     └─ sandbox-local.confine → selectRunner → runnerArgv → [runner, ...profileArgs, '--', 'bash','-c',command]
      │            Linux: bwrap/landlock（probe 仲裁）；darwin: seatbelt；win32: windows-acl
      └─ runArgv(spec, confined.argv)
            → deadline(signal, timeoutMs) 融合超时/取消（bash-local:223-240）
            → ctx.subprocess.spawn(spawnSpec)                                  // bash-local:226
                  → LocalSubprocessRuntime.spawn → spawnSubprocess
                        → detached 进程树、collect 收集器（tail-keep + spill）、graceMs、abort→terminate()
            → await handle.done → finalOutput(readFrom(0))
            → classifyRunnerFailure（先）→ classifyDenial（后）→ result.sandbox 盖章   // bash-sandbox:107-113
  → 渲染：[exit code: N] / [killed by signal: X] / [sandbox: ...] marker + [stderr] 段
```

关键点：**命令字符串只在 `confine()` 调用前一刻变成 argv**；沙箱包住的是"bash 解释器 + 命令文本"，`bash -c` 内部再起的任何子进程都被内核规则（mount/Landlock/Seatbelt/受限令牌）约束。

### 8.2 主线二：`write` 工具（观察策略 + 沙箱围栏 + 原子写）

```
模型参数 { file_path, content, sandbox_permissions?, justification? }
  → tool-fs write execute（packages/fs/tool-fs/src/write.ts:102-129）
      ├─ sandboxPolicy = sandbox.resolvePolicy('write', args, exec)  // sandbox.ts:87-108（升级或 standing）
      ├─ target = ctx.fs.resolve(file_path, sessionResolveOptions(...))   // :108
      ├─ intent = ctx.waterfall('fs/write-intent', target, exec, () => undefined)  // :111
      │     └─ fs-observation-policy: 读过→replaceIfVersion(observed version)；未读/缺失→createIfAbsent  // index.ts:65-71
      ├─ outcome = ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)
      │     └─ SandboxedFileSystem.writeText（fs-sandbox:84-92）
      │           └─ checkedTarget（:126-148）：read-only→FS_SANDBOX_DENIED；
      │                workspace-write→重新 resolve + writableRoots 包含性检查→返回 fresh target
      │           └─ LocalFileSystem.writeText（fs-local:166-219）
      │                 └─ withLock(targetKey) → probe → 意图守卫（FS_STALE_VERSION / FS_NOT_OBSERVED）
      │                 └─ fsio.writeFileAtomic（fsio.ts:540-615）：staging dir → tmp 文件 → sync → rename/link/replaceFile
      ├─ （错误时）remediateFsError(sandbox.mapError(...))  // write.ts:115-119：FS_SANDBOX_DENIED → [sandbox: ...] marker
      └─ ctx.emit('fs/observed', target, {kind:'present', version: outcome.version}, exec)  // :122
  → 结果含 before/after → presentationMeta diffs → UI diff 卡片（write.ts:132-148）
```

关键点：**观察策略（读后写）与沙箱围栏（模式 fence）是两个独立叠加层**——前者是事件策略（可卸载），后者是后端实现（换 provider 就没有了）；两者都由 `sandboxPolicy` 供给"该调用该用哪种模式/哪个版本"的决策输入。

### 8.3 主线三：持久 PTY 的一次 send

```
tool-terminal send { sessionId, text, submit }（tool-terminal/src/index.ts）
  → ctx.terminals.startSend(owner, id, request)（terminal/src/index.ts:243-254）
      ├─ expectOwned：id 存在 + owner 精确匹配（:387-392）
      └─ record.session.startSend → terminal-bash LocalPtySession（session.ts:77+）
            → SubprocessTerminalHandle.write(text)（subprocess-local/terminal.ts）
            → node-pty 写入；输出经 TerminalSanitizer 净化（sanitize.ts，剥 CSI/OSC）
            → 检测受控提示符 OSC 标记（PROMPT_COMMAND 每次提示前打 133;D;）
            → waitReason ∈ stdin_read | inferred_idle | timeout | session_exit
                 （inferred_idle 由 ProcessInspector.isStdinWaiting 证明前台组阻塞在 stdin 读，
                   见 process-inspector.ts:286-297 的 /proc/<tid>/syscall 探测）
  → 结果 viewport + sessionStatus；后台 send 经 ctx.jobs（JobKindMap['pty-send']）
```

关键点：PTY 是**跨调用持久**的（session 注册表持有），且 spawn 时同样被 `terminal-bash.spawnArgv` 包进沙箱（`terminal-bash/src/index.ts:74-83`）；因此"有活动 PTY 时禁止切换 sandbox 模式"（`:34-53`）是保持执行世界自洽的必要围栏。

---

## 9. 关键代码摘录（集中汇总）

**摘录 1 —— seam 的 ConfinedArgv 与 confine 契约（`packages/sandbox/sandbox/src/index.ts:95-116, 175`）：**

```ts
export interface ConfinedArgv {
  argv: string[]                       // runner + profile + '--' + 调用方 argv
  enforcement: SandboxEnforcement      // 'full' | 'partial'
  denialSignatures: readonly string[]  // 本后端的 denial 方言
  runnerFailureRules: readonly RunnerFailureRule[]
}
// abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
```

**摘录 2 —— bash 执行器把 argv 交给沙箱并消费返回的 argv（`packages/shell/bash-sandbox/src/index.ts:88-114` 节选）：**

```ts
const confined = this.confine(spec.command, { ...policy, mode })
result = await this.runArgv(spec, confined.argv)     // spawn 的是被包的 argv
...
const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules)
if (runnerFailure !== undefined) throw new SandboxUnavailableError(mode, runnerFailure.detail)
return { ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement } }
```

**摘录 3 —— kill 升级路径（`packages/subprocess/subprocess-local/src/spawn.ts:439-453`）：**

```ts
const terminate = (): void => {
  if (treeExitObserved || graceTimer !== undefined) return
  void observeTreeExit()
  if (treeExitObserved) return
  kill('SIGTERM')
  graceTimer = setTimeout(() => { kill('SIGKILL') }, spec.graceMs)
}
```

**摘录 4 —— fs 观察策略的 read-before-write（`packages/fs/fs-observation-policy/src/index.ts:65-71, 78-88` 节选）：**

```ts
writeIntent(target, actor) {
  const prior = owner ? this.get(owner, target.targetKey) : undefined
  return prior?.kind === 'present'
    ? { kind: 'replaceIfVersion', version: prior.version }
    : { kind: 'createIfAbsent' }
}
// editIntent: 未读 → FS_NOT_OBSERVED；确认不存在 → FS_NOT_FOUND；读过 → CAS 版本
```

**摘录 5 —— landlock-run 自限制后 exec（`native/landlock-run/packages/entry/src/main.c:230-262, 295` 节选）：**

```c
static int restrict_self(const struct cli *cli, int *partial) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) return fail(NOT_ENFORCED_MESSAGE, NULL);   // ENOSYS/EOPNOTSUPP → fail closed
  *partial = abi < MAX_ABI;
  ...
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("landlock ruleset error", strerror(errno));
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) return fail("landlock ruleset error", strerror(errno));
  ...
}
execvp(cli.command[0], cli.command);   // ruleset 随 execve 继承给被包命令
```

---

## 10. 官方文档要点（docs/subsystems/*.md 补充）

以下要点是各 seam 文档相对源码的**契约性表述**，与源码逐条对应：

- **sandbox.md**（`docs/subsystems/sandbox.md`）：
  - "只有前两个模式能发给 provider；`danger-full-access` 消费者 spawn 自己的原始 argv 且不调用 `ctx.sandbox`"（`:23`）。
  - "容器、microVM、远程执行是**整套能力 seam 的兄弟实现**，不是 `ctx.sandbox` 的 provider"（`:5`）——这正是 e2b 包的定位。
  - enforcement 是"报告的"事实：`full`=后端治理模式承诺的每个文件效果；`partial`=老 ABI 或活动后端只治理子集，"要求绝对边界的消费方必须拒绝或呈现该差异"（`:30`）。
  - `ConfinedArgv` 的两个 stderr 分类器正交：denial = 约束**正常工作**时拦住命令；runnerFailure = runner 在命令执行前拒绝/失败（`:118`）。
  - 工作根规范化的原因：cwd 含 `symlink/..` 时必须识别"spawn 进程实际运行的目录"（`:43`）。
- **subprocess.md**（`docs/subsystems/subprocess.md`）：
  - "一个 provider 的 spawn 工作目录、可执行路径、普通进程与终端会话与所挂载 filesystem provider 处于**同一路径与进程命名空间**"（`:11`）。
  - 消费矩阵（`:5`）：bash 执行器用 collect 批输出、LSP 用 raw 协议管道、PTY 后端用 terminal 原语、ACP 子代理后端用 piped ndjson + 继承 stderr。
  - handle 契约（`:132-160`）：collect 读器取整流字节 offset 且不消费（独立 reader 互不吞输出）；`waitForExit` 观察整树，足够消费方搭自己的 teardown 梯（ACP 的 stdin-EOF-first `disposeAcpChild` 是模板）。
- **shell.md**（`docs/subsystems/shell.md`）：
  - request/spec 分离是仓库"explicit > implicit at package boundaries"规则的实例（`:13-15`）。
  - **正交结果独立报告**：进程可以既超时又 exit 0（它捕获了信号），所以 `timedOut/aborted/signal/exitCode` 各是各的字段，调用方绝不会把被截断的运行读成干净成功（`:105-107`）。
  - `stdin`/`env`/`stdoutMaxBytes` 是受信进程内插件输入，`dsh-tool-bash` 不暴露（`:101-103`）。
- **filesystem.md**（`docs/subsystems/filesystem.md`）：
  - 观察策略**可选**：没有它，seam = FileSystem 定义 + provider + tool-fs 消费方，write/edit 无条件；加上它行为变成 read-before-write/edit——"移除它不会破坏工具，因为工具调 `ctx.fs` 并派发事件，不调策略方法"（`:7`）。
  - `lstat` 是路径级 no-follow 原语（`resolve` 故意跟随 symlink 产生稳定身份），信任边界规则可先 `lstat` 拒绝 `symlink`（`:74`）。
- **terminal.md**（`docs/subsystems/terminal.md`）：`TerminalWaitReason` 与 `TerminalSessionStatus` 独立（静默/超时返回时顶层 shell 可能仍活着；`session_exit` 才意味着 shell 退出而非任意前台子进程）（`:11`）。后端无法清理部分启动资源时抛 `TerminalBackendCleanupError`，让 disposal 保留清理失败而不替换调用方的取消原因（`:27`）。
- **code-runtime.md**（`docs/subsystems/code-runtime.md`）：错误是结果字段、`run()` 永不 reject（与 `ShellExecutor.run` 的 resolve-on-failure 契约一致）（`:39`）；`isolation` 描述符"是诊断标签，**不是安全声明**"（`:161`）；实现必须保持 run 之间互相隔离（无跨 run 状态）并在 teardown 前终止且等待在飞 run（`:161`）。
- **lsp.md**（`docs/subsystems/lsp.md`）：四个查询操作是**闭集**，新增操作是跨 seam/provider/tool 的编译期改动（`:11,19`）；`LspQueryRequest` 全字段必填、无 `resolve()` 步骤（`:40-42`）。
- **scope.md**（`docs/subsystems/scope.md`）：`packages/core/scope` 提供 per-agent 可见性 + 共享生命周期的注册上下文原语（`ScopeKey`/`Scoped`/`ScopeLayer`/`ScopedLayers`），是"一个注册上下文同时意味着按 agent 可见性和共享生命周期所有权"的实现，与执行世界的沙箱无关；`isolate` 一词在 cordis 层指服务隔离（`ctx.isolate(name, label)`，`docs/cordis-api/context.md:39-61`）与 preset 的 `isolate` realm（`docs/architecture.md:112`）——给不同 session 不同能力集的组合手段。
- **native 文档**：`native/landlock-run/README.md` 之外，`docs/cli-contract.md` 钉死 argv 文法/退出码/报告行（entry 包 `index.ts` 与二进制同版共存，`entry/src/index.ts:5-10`）；`docs/support-matrix.md` 说明 ABI 级别决定 full/partial；`docs/postmortem/0004-*.md` 记录 runner 分类教训（见 §1.3）。

---

## 11. 附注与阅读提示

- 任务清单中的 `docs/native/README.md` **不存在**；native 模块的权威文档是 `native/landlock-run/README.md`（+ `docs/cli-contract.md`、`docs/support-matrix.md`、`docs/architecture.md`）。
- `docs/subsystems/scope.md` 讲的是 `packages/core/scope`（per-agent 注册可见性/共享生命周期），与"执行世界"的隔离概念不同；真正的"isolate"语义在 cordis 层（`ctx.isolate`/cordis.yml 的 `isolate` realm，`docs/cordis-api/context.md:39-61`）——执行世界里与之最接近的是 `terminal-bash` 的 PTY 模式冻结围栏与 code-runtime 的 per-run 全新 worker。
- 强相关历史：`docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md`（runner 失败 vs denial 分类的教训，直接塑造了 `RunnerFailureRule` 的"状态门控 + 信息行精确排除"）；`docs/subprocess.md` 的 handle/termination 契约（`:132-160`）；`docs/shell.md` 的 request/spec 分离（`:13-15`）与独立结果字段（`:105-107`）。
- 沙箱方言/失败规则的最新权威表在 `packages/sandbox/sandbox-local/src/index.ts:205-240`（`DENIAL_SIGNATURES` + `RUNNER_FAILURE_RULES`），与 `examples/acp-agent/tests/fixtures/partial-landlock-sandbox.ts` 的装配快照保持对齐（`:228-230` 注释）。
