# C2 报告：DeepSeek Harness 的 Web 宿主与浏览器客户端体系

> 分析对象：`E:\WorkSpace\LLM_Projects\deepseek-harness`（下文所有路径均为仓库内相对路径）。
> 范围：`apps/cli`、`apps/web`、`packages/boot/*`、`packages/host/{webserver,frontend-static,apiproxy,plugin-inventory}`、`packages/client/{connection,modules,hmr,runtime,web,web-react,locale,ui-slots,ui-layout,ui-primitives}`、`packages/bundle/web-app`、`packages/api/remotes` 及官方文档。

## 0. 全景：一条启动链，两个构建面，三种消费者

DSH 的 Web 体系可以用一句话概括：**同一个 Cordis 插件树同时是 Node 宿主（Host）与浏览器客户端（Client）两个面的共同"配置"**。启动时：

1. `dsh` CLI 解析出 profile 名 → 把 profile 的 bundle 层与 patch 层叠成一个 Cordis 入口列表 → `boot()` 用 Loader 挂载插件树（纯 Node 进程）。
2. 树里的 `webserver` 行监听 `127.0.0.1:3080`；`frontend-static` 行认领 fallback 席位服务 SPA dist；`client-modules` 行扫描树中声明了 `dsh.client` 的包并把它注入 `index.html` 的 `window.__DSH_BOOT__`。
3. 浏览器打开页面 → 拿到 `__DSH_BOOT__` 插件图 → 内置的客户端模块系统按图拉取各插件的 `/plugins/<id>/client.js` bundle → 在浏览器里再跑一棵 Cordis 插件树（壳 + 运行时 + 各 `ui-*` 插件）。
4. 浏览器里这棵树的插件通过 `/api/*`（HTTP POST RPC）与两个 WebSocket 下行流（事件推送）跟 Node 侧的树通信——**浏览器是宿主插件的另一个消费者**。

各包在双面中的角色（`packages/…` 下的 `src/` 与 `src/client/` 常是同一包的 Node 面与浏览器面，靠 package.json 的 `exports["./client"]` 区分）：

| 包 | Node/Host 面 | 浏览器/Client 面 |
|---|---|---|
| `client/modules` | `ctx.clientModules`：扫描、构图、`/plugins/<id>/client.js`、index tap | `ctx.modules`：`ClientModuleSystem`（懒 CJS 模块表） |
| `client/connection` | `ctx.connection`：`/api` HTTP 桥 + 两个 WebSocket downlink | `WebApiClient`：fetch 上行 + WS 下行 |
| `client/hmr` | 轮询 bundle 变化、`/plugins/events` SSE 广播 | 监听 SSE 并热替换 fiber |
| `client/runtime` | 空壳（无 host 行为） | `ctx.sessions/workspaces/slots/…` 运行时服务 |
| `host/apiproxy` | `ctx.apiProxy`：传输无关的 RPC 网关 | `AbstractApiClient`/`IApiClient`（同一包内的 `fetch/client.ts`） |
| `client/web` | — | shell kernel（`boot.tsx`、`AppRoot`、`app-shell`） |

传输层全貌（详见 §2.4 与 §3.3）：

```
浏览器                                            Node 宿主
┌────────────────────────────┐    POST /api/<method>     ┌─────────────────────────────┐
│ WebApiClient (fetch)       │ ─────────────────────────▶ │ webserver (node:http)       │
│   unary / respond          │ ◀───────────────────────── │  → trust fence (loopback)   │
│                            │   200 + ServerResponse     │  → HostConnectionService     │
│   events.mux / events.host │ ───── WebSocket 下行 ────▶ │  → WebSocketDownlinks        │
│   (readWebSocket, 只收)     │ ◀───────────────────────── │  → api.events.mux/host       │
│   HMR: EventSource         │ ───── SSE /plugins/events ▶│  → client-hmr (广播)         │
└────────────────────────────┘                            └─────────────────────────────┘
```

---

## 1. 启动链：`dsh` 命令 → 运行中的插件树

### 1.1 CLI 入口与参数归属

`apps/cli/src/bin.ts` 是自执行分发器（`#!/usr/bin/env node`）：先 `parseDshArgs`（`apps/cli/src/args.ts:112`），再按 `mode` 动态 import 对应 runner——`profile`（`profile-boot.ts`）、`plugin`（转发给 pnpm）、`dump-config`（`dump-config.ts`）。动态 import 是刻意设计：无关模式的代码不进各自的分发路径（`bin.ts:2-7`）；版本号从 `../package.json` 读（`bin.ts:20-25`）。launcher 只解析它自己的旗标：`--profile <name>`、`--patch <path>`（可重复）、`--dump-config`、`--dump-default-config`（`apps/cli/src/args.ts:130-134`）。

关键设计是**参数归属分层**（`apps/cli/src/args.ts:1-16`）：launcher 不认识的第一个 token 之后的所有参数原样透传给被引导的树，由树内注入的 app 插件（如 web 的 `web-startup`）通过 `ctx.cmdlineArgs` 读取并自己用 commander 解析——`dsh --profile web --port 8080` 里 `--port` 属于 web app，不是 launcher。为此 launcher 的 commander 程序用 `allowUnknownOption() + passThroughOptions() + enablePositionalOptions()` 让未知 token 直接滑进 `args`（`args.ts:126-130`）；`web` 是 `--profile web` 的硬编码别名子命令（`args.ts:156-169`）；`plugin` 子命令把剩余参数逐字转发给 profile 目录里的 pnpm（`args.ts:171-181`）。错误/帮助/版本经 `exitOverride` 变成 `CommanderError` 返回 exit code（`args.ts:183-187`）。

`bin.ts` 先 `loadLayeredEnv('dsh')`（`packages/boot/app-boot/src/index.ts:177-198`）冻结环境快照：继承环境 > 调用目录 `.env` > `$DSH_HOME/.env`。`readEnvLayer`（`index.ts:139-164`）先解析后应用，并拒绝文件里出现 bootstrap-only 变量名（`PATH`、`NODE_OPTIONS`、`DSH_*`、`XDG_*` 前缀等，`index.ts:93-128`）——这些只能由启动环境决定；快照随后经 `ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, …)` 注入（`apps/cli/src/profile-boot.ts:252`），让所有插件从同一不可变来源解析启动期环境值。

### 1.2 profile 解析与 patch 层叠加

`apps/cli/src/profile-boot.ts:142-171` 的 `composeProfile` 把 profile 组装成 **5 个有序 patch 层**（应用顺序即优先级从低到高）：

1. **bundle 层**：`dsh.profile.bundles` 里每个 bundle 包的 `dsh.bundle.patch`（如 `@deepseek-ai/dsh-base` 的 patch、`@deepseek-ai/dsh-web-app` 的 `cordis.patch.yml`）；
2. **profile 用户层**：`$DSH_HOME/profiles/<name>/cordis.patch.yml`；
3. **home 用户层**：`$DSH_HOME/cordis.patch.yml`（机器级偏好，压过 profile 层，`profile-boot.ts:49-51, 147`）；
4. **`--patch` 覆盖层**（argv 顺序）；
5. **telemetry 开关**（`DSH_TELEMETRY_DISABLED`，任意非空值都禁用，隐私开关宁关勿开，`profile-boot.ts:80-83`）与 agent-preset 根路径补丁（`profile-boot.ts:159-167`：把 SHIPPED preset 根塞进 `agent-presets` 行的 config）。

profile 本身是一个目录（`packages/boot/app-boot/src/profile.ts:104-111`），由 `loadProfile` 解析（`profile.ts:371-403`）：bundle 包名**双锚点解析**（dsh 安装目录优先，profile 目录其次，`profile.ts:344-355`，保证 `@deepseek-ai/dsh-base` 永远来自运行中的 dsh 安装而非 profile 本地副本）；内置模板 `PROFILE_TEMPLATES = { web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], headless: […] }` 首次使用时自动初始化（`profile.ts:114-117`），初始化还会写 `pnpm-workspace.yaml`（`nodeLinker: hoisted`）供 out-of-tree 插件使用（`profile.ts:138-143, 152-168`）。`healProfilesModuleFallback`（`profile.ts:223-255`）维护 `$DSH_HOME/profiles/node_modules` 平面符号链接场（BFS 覆盖 app 的 dependencies + peerDependencies 闭包，peer 也参与——Service Definition 包常是 peer），使任何 profile 里的裸包名都能经 Node 父目录查找解析到安装内插件。

关键：整棵树是"**空根 + patch 层**"。`prepareProfile` 每次引导都会重写 `cordis.yml` 为 `[]`（`profile-boot.ts:60-64, 101`），因为 Loader 的自释放会把当前树回写进文件，不重写会导致下次启动时 bundle 行重复。root 文件存在的唯一意义是给 Loader 一个 include 锚点（`baseUrl` 与 dump 锚定同一个文件）。

### 1.3 `boot()`：从 patch 列表到运行中的 Cordis 树

`packages/boot/app-boot/src/index.ts:757-802` 的 `boot()` 是启动链的心脏：

1. `new Context()`，`ctx.baseUrl` 指向配置目录，`provide('dshHomePath', …)` 供 `!!js` 配置表达式使用；
2. `ctx.plugin(Loader)` 挂载 vendored Cordis Loader；
3. 运行 `prepare` 钩子（CLI 在这里注入 `DSH_LAUNCH_ENVIRONMENT_KEY` 与 `cmdlineArgs/appExit`，`profile-boot.ts:248-259`）；
4. `mountRootInclude(ctx, configPath, patches, bareModuleBaseUrl)`（`index.ts:486-529`）：把 `cordis:include` 与 `cordis:group` 注册为 builtin（二者走环境模块管线，因此配置目录外的 agent preset 也能用 group 行），再创建 id 恒为 `'include'` 的根条目（固定 id 保证启动诊断稳定），config 是 `{ path: fileURL, patches }`；`bareModuleBaseUrl` 存在时用子类化 Include 把裸包名解析锚到安装目录（`index.ts:492-504`）；
5. `await ctx.get('loader')?.await()` 等待树沉降，`assertEntriesActivated`（`index.ts:692-725`）审计每个启用的 entry 都有 ACTIVE fiber：FAILED 的 await 回收原始栈、PENDING 的列出缺失服务；之前还有 `assertEntriesLoaded` 检查"启用的 entry 必须非空 fiber"（`index.ts:658-664`）。审计抛错前会经过一个 rejection checkpoint（`index.ts:565-572`），让 `installFailLoud` 合并 Loader 的重复通知；
6. 失败路径 `ctx.fiber.dispose()` 后抛带 `{ cause }` 的标签化错误（`host preparation failed` / `plugin tree failed to load`），并把最深层 cause 的栈附上（`index.ts:786-801`）。

`installFailLoud`（`index.ts:609-649`）把晚到的 unhandled rejection 转成一条 `dsh: fatal load failure: <stack>` + `exit(1)`；带 `release` 钩子时先等它（上限 `FAIL_LOUD_RELEASE_TIMEOUT_MS = 2000`，`index.ts:578`）——终端型 surface 要在退出前交还终端（raw mode、bracketed paste），且失败诊断先写、release 后再退出，避免悬挂 disposer 吞掉原因。

`runProfile`（`apps/cli/src/profile-boot.ts:207-300`）在其后还做了两件长生命周期的事：

- 信号接线：SIGTERM→exit 0（supervisor 常规停止）、SIGINT→130（用户中断，`profile-boot.ts:216-225`）；信号在整个启动窗口内拥有 teardown 权，不只 boot() 返回后；
- **用户层热更新**：若树里没有 HMR 服务则补挂 `cordis-plugin-hmr`（web bundle 显式禁用了共享 HMR 行，见 `packages/bundle/web-app/cordis.patch.yml:21-23`），再 `watchUserPatches`（`index.ts:232-265`）分别盯 profile 与 home 两个 `cordis.patch.yml`，改动时通过 `entry.update({ config: { …includeConfig, patches } })` **事务性重放** patch 列表——bundle 层在下方、overlay 在上方，用户编辑永远挤不掉它们（`profile-boot.ts:240-245` 的 `composeLive`，且每次 `structuredClone` 防止 insert 行按引用混叠——同一个 patch 对象被复用会把用户覆盖烤进 bundle 的内存 insert 行，删掉覆盖也无法还原）。

```ts
// apps/cli/src/profile-boot.ts:240-259 —— 热重载合成 + boot 装配（节选）
const composeLive = (): PatchOptions[] => structuredClone([
  ...composed.bundlePatches,
  ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
  ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
  ...composed.overlays,
])
const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {
  app.current = hostCtx
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
  provideCmdline(hostCtx, {
    args: options.args,
    exit: code => void shutdown.shutdown(code),
  })
})
```

### 1.4 `--dump-config` 如何工作

`apps/cli/src/dump-config.ts:30-52`：**完全不 boot、不执行 `!!js`**，纯离线合成：

1. `prepareProfile(profile, !defaultOnly)`——`--dump-default-config` 跳过用户层解析（这是坏掉的 `cordis.patch.yml` 的恢复诊断路径，`apps/cli/src/args.ts:98-102`，且 dump 拒绝任何 app 参数——它无法运行 app 的命令行 provider，打印一个与真实 boot 不同的树会误导）；
2. 把 bundle 层 +（可选）profile 层 + home 层 + `--patch` 层组装成 `ConfigDumpLayer[]`（每层带标签）；
3. `renderConfigDump`（`packages/boot/app-boot/src/index.ts:379-442`）读 root `cordis.yml`，用 include 自身的 `entryListSchema`/`applyEntryPatches` **逐步快照**（每加一层做一次 `applyEntryPatches`，patch 每次 `structuredClone`），逐行比对前后快照推导每条行的来源与被打补丁的层（`index.ts:420-440`），输出带 `# == <源文件>, patched by <层>` 注释的可加载 YAML——`!!js` 表达式原样打印不求值。因为用的是 boot 同一条 `applyEntryPatches` 单次调用路径，连 patch 可见性 corner case（后层 patch 到前层 config 替换引入的 group 子行）都不会漂移；无匹配行的 patch 经 warn 报告，镜像 Loader 的启动警告（`index.ts:411-419`）。

### 1.5 端到端追踪：`dsh web --port 8080`

把整条启动链串起来看一个具体调用：

1. **argv 解析**：`parseDshArgs(['web','--port','8080'])`（`apps/cli/src/args.ts:112`）→ `web` 子命令 action（`args.ts:166-169`）→ `resolveBoot` 得 `{mode:'profile', profile:'web', patches:[], args:['--port','8080']}`（`args.ts:83-103`）——`--port` 不在 launcher 语法里，滑进 `args`。
2. **环境冻结**：`loadLayeredEnv('dsh')`（`apps/cli/src/bin.ts:33`，`app-boot/index.ts:177-198`）。
3. **profile 组装**：`runProfile` → `composeProfile('web', [])`（`profile-boot.ts:208`）→ `prepareProfile('web')`（`profile-boot.ts:98-103`，首次运行自动 `initProfile` 写 `$DSH_HOME/profiles/web/`）→ 解析 `dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`（`profile.ts:114-117`）→ 两个 bundle 的 patch 层 +（可能存在的）用户层 + home 层。
4. **boot**：`boot('dsh', rootConfig, patches, prepare)`（`profile-boot.ts:248`）→ `mountRootInclude` 挂 `cordis:include` → 树沉降 → `assertEntriesActivated`。树里（`packages/bundle/web-app/cordis.patch.yml`）：
   - `web-startup` 行（`cordis.patch.yml:107-108`）`inject: ['cmdlineArgs']`，其 `apply`（`packages/bundle/web-app/src/startup.ts:65-82`）用 `parseCmdline` 让 commander 解析 `['--port','8080']`，action 校验（`--host 0.0.0.0` 被拒：会把 RCE 暴露给网络，`startup.ts:69-71`）后 `ctx.provide('webStartup', {port:8080, trustedHosts:[]})`；
   - `webserver` 行（`cordis.patch.yml:115-120`）`inject: ['webStartup']`，config `port: !!js ctx.webStartup.port ?? 3080`——Loader 只在 `webStartup` 激活后求值该表达式，flag 打败默认值；
   - `web-runtime` 行（`cordis.patch.yml:130-136`）`apply`（`web-app/src/index.ts:135-185`）：`resolveLanTrust` 采样 LAN IP → `provide('webRuntime')` → `ctx.plugin(FrontendStatic, {distIndex})` 认领 fallback 席位 → 挂 prompt 段与 `DSH_WEB_URL` → Loader 沉降后打印 `dsh web: http://127.0.0.1:8080`（`index.ts:159-184`）。
5. **浏览器传输**：`client-connection` 行（`cordis.patch.yml:156-163`）`inject: ['webRuntime']`，`trustedHosts: !!js ctx.webRuntime.trustedHosts`（LAN 字面量 + `--trusted-host`）；`apply`（`connection/src/index.ts:130-196`）注册 `/api` prefix 路由与两个 WS upgrade 路由，网关挂 `toFetchHandler(apiProxy)`。
6. **客户端装配**：`client-modules` 行（`cordis.patch.yml:151-152`）扫描树中全部 `dsh.client` 包（`ui-*` 花名册，`cordis.patch.yml:174-275`）构图并注入 `__DSH_BOOT__`；浏览器打开 `http://127.0.0.1:8080` → `frontend-static` 的 fallback 回 `index.html`（过 index tap 注入图）→ shell kernel 跑 §3.2 的引导。

注意第 4 步里 `--port` 的流向：launcher → `cmdlineArgs` 服务 → `web-startup`（commander action）→ `webStartup` 服务 → `!!js` 配置表达式 → `WebServer.Config`——**每一层都只通过服务/类型交接，没有任何一行代码直接读 `process.argv`**。

---

## 2. Web 宿主：webserver、静态资源、apiproxy 网关与事件推送

### 2.1 webserver：路由注册、匹配顺序、fallback 席位、index tap

`packages/host/webserver/src/index.ts` 是纯 `node:http` 载体，**不认识任何 harness 概念、不服务任何文件**（`index.ts:1-9`）；Electron 形态完全绕过它（dist 走 `file://`，fetch 走 IPC 桥）。核心服务 `WebServer`（`index.ts:59-264`）：

- 路由表三张：`exact: Map`、`prefixes: Map`、`upgrades: Map`，加一个 `fallback` 席位与 `indexTaps: ((html)=>string)[]`（`index.ts:65-70`）；
- **匹配顺序固定**（`index.ts:242-251` 的 `match`）：exact 表命中 → 否则前缀表取**最长前缀胜出**（`prefix` 匹配 `p` 与 `p/<anything>`）→ 否则 fallback 席位；未认领时 404。路由注册顺序对请求无语义——命名路由被组合成不相交集合，重复 `(kind, path)` 抛错（`index.ts:94-101`）；
- `registerUpgrade` 注册 exact-path 的 HTTP upgrade 路由（一个 socket 只能有一个协议主人，`index.ts:109-115`），`server.on('upgrade')` 里查表派发、跟踪 `upgradedSockets` 以便 dispose 时一并关闭（`index.ts:181-214, 228-238`）；
- `registerFallback` **单席位**：二次注册抛错（`index.ts:125-131`）；`tapIndex` 注册纯 html→html 变换，由 fallback 拥有者在对每个 index 响应调用 `applyIndexTaps` 时按注册序应用（`index.ts:139-145, 259-263`）；
- `[Service.init]`（`index.ts:148-239`）激活即监听，listen 失败 = FAILED fiber（boot 审计上报）；`port` getter 返回 OS 分配端口（`config.port: 0` 时）；请求处理异常被包进 `.catch` 记 warn 回 400（或毁 socket），**绝不杀进程**（`index.ts:170-180`）——一次坏 %-escape 或客户端中途断连不能杀死整个 host。

```ts
// packages/host/webserver/src/index.ts:242-251 —— 匹配顺序：exact → 最长前缀 → fallback
private match(pathname: string): WebRoute | undefined {
  const exact = this.exact.get(pathname)
  if (exact !== undefined) return exact
  let best: WebRoute | undefined
  for (const [prefix, route] of this.prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (best === undefined || prefix.length > best.path.length) best = route
  }
  return best
}
```

### 2.2 静态资源与 SPA 回退

`packages/host/frontend-static/src/index.ts` 认领 fallback 席位。语义被锁死（`index.ts:56-109`）：

- 非 GET/HEAD → 405（命名路由拥有自己的方法处理，fallback 只管静态，`index.ts:98-105`）；
- `resolve(normalize(join(distRoot, pathname)))` 后路径越出 dist 根 → 403（防穿越；Windows 用 `sep` 而非 `/` 判定——`resolve()` 在 Windows 上产出反斜杠路径，用 `/` 会拒绝每个合法子路径，`index.ts:60-68`）；
- `/` 或 index 本身 → `renderIndex()` = `webServer.applyIndexTaps(readFile(distIndex))`，即**每个 index 响应都过 index tap**（boot-manifest 注入点，`index.ts:69-77`）；
- 其余命中读文件，扩展名查 MIME 表（`.html/.js/.css/.svg/.json/.map/.webmanifest`，`index.ts:37-45`），未知扩展发 `application/octet-stream`；
- 文件缺失（ENOENT/EISDIR）→ 回退到 index.html 且 **HTTP 200**（SPA 路由，`index.ts:78-85`）。

dist 位置是组合应用的装配事实：`packages/bundle/web-app/src/index.ts:116-124` 的 `resolveDistIndex` 用 `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` 解析，从不硬编码（注释明说"workspace knowledge of this bundle, never user config"）。web-app 的 `apply`（`index.ts:135-185`）还做：`resolveLanTrust` 采样 bind 后的 LAN IPv4 字面量并 `provide('webRuntime')`（`index.ts:85-92`，DNS-rebinding 用 IP 字面量天然安全）、挂 prompt 段 `app:web-surface`（`index.ts:95-106, 141-148`）、注册 `DSH_WEB_URL` bash 变量（`index.ts:149-158`）、等 Loader 沉降后打印 URL 行（`index.ts:159-184`——URL 行是就绪信号，supervisor 一看到它就 RPC，所以必须等 `/api` 路由挂完）。

### 2.3 apiproxy：浏览器调用的 host 网关

`packages/host/apiproxy/src` 是**传输无关**的网关：`ApiProxyService`（`index.ts:69-126`）把 `createApiProxy(ctx, …)`（`api-proxy.ts`，约 3700 行）的闭包实现挂为 `ctx.apiProxy`；它**不注册任何路由**——物理载体（浏览器 HTTP、Electron IPC、进程内注入）自行包裹它（`index.ts:1-13`：Transport-agnostic by design）。服务注入依赖 `agentDefaultModel/agents/attachments/directoryPicker/llm/sessions/subagents/sessionQuery/tools/userQuestions/workspaceRegistry`（`index.ts:70-73`），全部来自宿主树。

浏览器路径上，载体是 `packages/client/connection/src/index.ts` 的 `apply`（`index.ts:130-196`）：

1. 注册 `prefix: '/api'` 路由（`index.ts:161-173`），请求先过**浏览器信任围栏** `isTrustedApiRequest`（DNS-rebinding 与跨站防御，`api-request-trust.ts`；非 loopback 部署必须在 config `trustedHosts` 里声明权威——`0.0.0.0` bind 时 CLI 自行推导 LAN IP 字面量），再 `bridge(req, res, fetchHandler, maxRequestBodyBytes)`（`http-bridge.ts`，缓冲 JSON body；`maxRequestBodyBytes` 有容量断言：必须 ≥ 聚合图片 base64 上限 + 1MiB 头寸，`index.ts:32-44`）；
2. `fetchHandler`（`index.ts:139-160`）对每个请求先查 `PRIVILEGED_METHODS`（`index.ts:89-119`：`settings.*`、`credentials.*`、`host.pickDirectory/openPath`、`agentPreset.read/copy/openDocument/remove`、`llm.discoverModels` 等——这些即使受信主机也要**钉死在 loopback**，因为它们是配置/密钥/探测类能力；`settings.describe` 返回每个暴露命名空间的配置、`credentials.describe` 报告任意环境变量名是否配置，都是匿名调用者不该有的侦察面）→ 命中且非 loopback 即 403；`GET /api/events.*` 回 426 要求 WebSocket 升级（`index.ts:150-155`）；否则转 `toFetchHandler(apiProxy)`。

`toFetchHandler`（`packages/host/apiproxy/src/fetch/handler.ts:243-319`）是协议核心——**两段式解析**，HTTP 状态只表达载体（404 未知路径 / 415 非 JSON / 400 非 JSON body / 500 handler 崩溃），业务错误永远是 200 + `ServerResponse` 信封（`handler.ts:1-7`）：

- 无信封直读通道：`GET /api/events.mux`、`GET /api/events.host`（SSE 包装，`handler.ts:254-259`）、`GET /api/session.export`（host-only 下载，query 参数经 domain schema 校验，`handler.ts:260-271`）；
- `POST /api/<method>`：先强校验 `content-type: application/json`（跨站写围栏：浏览器对 text/plain 等"简单 POST"不发 CORS preflight，恶意页面可盲执行副作用 RPC——虽然响应跨域不可读，`session.prompt` 仍会跑；只收 JSON 就强制进入本服务器永不应答的 preflight，`handler.ts:277-286`）；
- `UNARY_ROUTES`（`handler.ts:90-143`）**按 `RpcMethodMap` 键编译器锁死**的调度表：`methodFor(path)` 把路径段收窄成 map key（单点收窄，`handler.ts:146-148`），每行 `{schema, invoke}` 对被类型检查锁在该行的 payload 类型上——schema 贴错行是编译错误；`handleUnary`（`handler.ts:178-192`）先 schema 解析 payload（失败 200 + bad-request），再 `route.invoke(api, {rpcId, payload}, signal)`；
- 信封校验失败时用 `INVALID_REQUEST_RPC_ID = RpcId('invalid-request')` 哨兵补全响应（响应必须是合法 `ServerResponse`，否则服务器的显式错误报告会变成客户端解析失败，`handler.ts:155-161`）；
- `POST /api/respond`：浏览器对"请求批准/提问"帧的应答通道（`handler.ts:296-300`）。

```ts
// packages/host/apiproxy/src/fetch/handler.ts:83-90 —— 编译器锁死的 unary 调度表
type UnaryRoutes = {
  [K in keyof RpcMethodMap]: {
    schema: z.ZodType<Wire<RequestPayload<K>>>
    invoke(api: ApiProxy, request: RpcRequest<RequestPayload<K>>, signal: AbortSignal): Promise<RpcResponse<ResponseValue<K>>>
  }
}
const UNARY_ROUTES: UnaryRoutes = {
  'session.list': { schema: sessionListRequestSchema, invoke: (api, r) => api.sessions.list(r) },
  'session.search': { schema: sessionSearchRequestSchema, invoke: (api, r, signal) => api.sessions.search(r, signal) },
  'session.create': { schema: sessionCreateRequestSchema, invoke: (api, r) => api.sessions.create(r) },
  // …每个 RpcMethodMap 行都有一行，缺行/贴错 schema 直接编译失败
}
```

### 2.4 事件推送：每个流订阅 vs 广播

两条语义不同的推送路径：

**a) 业务事件 = 每订阅者独立流（per-stream subscription）**。`events.mux`/`events.host`（`api-proxy.ts:3366-3469` 与后续）为**每个打开的流**创建一个 `FrameQueue`：

- 流打开时先推基线：对每个已存在 session 推 `session/subscribed`（含 `lastSeq`，`api-proxy.ts:449-451`）、重放仍 pending 的 `approval/requested` 与 `question/requested`（rpcId 原样复用，供刷新恢复——重新连接的客户端还能应答旧请求，`api-proxy.ts:3373-3384`）、`session/queue` 快照（`api-proxy.ts:3388-3393`）、`session/jobs` 基线（`api-proxy.ts:3398-3406`）、workspace/archive 快照（host 流）——"reconnect = 重开流 + 重拉历史"的机制支撑；
- 然后 `ctx.on('session/event'|'session/created'|'session/disposed'|…)` 为**这个流**注册监听器，把新事件推进**它自己的** queue（`api-proxy.ts:3411-3464`），并顺带维护每会话 open-call 表用于 tool view 配对（`api-proxy.ts:3410-3429`）；`queue.iterate(signal, cleanup)` 在信号中止时退订并删 queue（`api-proxy.ts:3465-3468`）；
- 也就是说：N 个浏览器标签 = N 条 mux 流 = N 份订阅，各自有各自的基线回放。`MuxFrame`/`HostFrame` 联合类型见 `api/events.ts:69-108, 127-155`（session/event 直通 + session/queue 全量快照 + session/projection + host/session-added 等）。
- 物理载体是**下行专用 WebSocket**（`packages/client/connection/src/websocket-downlink.ts`：`ws` 的 `WebSocketServer({noServer:true})` + `handleUpgrade`，逐帧 `send`（`websocket-downlink.ts:23-34`），收到客户端消息直接 `close(1008, 'downlink only')`——上行只走 HTTP，WS 是纯下行（`websocket-downlink.ts:109-111`）；实现 throw 时发一帧 `stream/error` 再关（`websocket-downlink.ts:36-44, 118-137`），客户端必须看到失败而不是静默断开。

**b) HMR 通知 = 真广播（fan-out）**。`packages/client/hmr/src/index.ts:148-190` 的 `GET /plugins/events`（SSE）维护 `connections: Set<ServerResponse>`，`onRebuilt` 时对**所有**连接写同一帧（`index.ts:180-183`）；打开时先推一条 `: connected` 注释行 + 当前 graph 快照（`index.ts:159-161`）。

### 2.5 插件清单（plugin-inventory）

`packages/host/plugin-inventory/src/index.ts:43-70`：`PluginInventoryGateway`（`TypertRemoteService`）的 `@Remote('list') list()` 每次调用直接读 `ctx.loader.entries()`，把每个非 group entry 投影成 `{entryId, moduleName, enabled, fiberPhase}`——只读、无缓存（cordis `internal/plugin` 事件已维护 `Entry.fiber`/`Fiber.state`，再加缓存只会多一个需要同步的生命周期真相）。`FiberState` 跨包 const enum 用本地镜像表转成字符串相位（`index.ts:23-40`）。通过 Typert Remote 协议暴露给浏览器（`ui-settings-plugin-inventory` 消费），只读投影正是"浏览器读宿主 Loader 状态"的受控口径。

### 2.6 RPC 信封协议与错误模型

`packages/host/apiproxy/src/api/rpc.ts` 定义**四象限消息模型**——物理载体（HTTP/WS/进程内 SSE）与逻辑消息解耦，消息是四成员判别联合（`rpc.ts:1-6, 180`）：

- `ClientRequest`（`type:'client-request'`, rpcId, method, payload）——客户端发起的调用，载体是 `POST /api/<method>` body；
- `ServerResponse`（`type:'server-response'`, rpcId 回声, result）——上述 POST 的响应体；**rpcId 由发起方铸造、响应永远回声、从不新铸**（`rpc.ts:14-18`）；
- `ServerRequest`（`type:'server-request'`, rpcId, method, payload）——服务器发起的消息（下行流帧）：可应答的（approval/question requested，rpcId 稳定、重放时复用）与纯推送（session/event 等，rpcId 标识这一次推送）共享此形；是否期待响应由 method 静态决定（严格二分，无第三类，`rpc.ts:159-170`）；
- `ClientResponse`（`type:'client-response'`）——对 ServerRequest 的应答，载体是 `POST /api/respond` body；`RpcReceipt`（`{accepted:true} | {accepted:false, reason:'not-pending'|'bad-response'}`）属于载体层，晚到/重复响应得 `not-pending`（`rpc.ts:182-187`）。

签名层窄形 `RpcRequest<P>`/`RpcResponse<T>`（`rpc.ts:131-140`）：rpcId 显式在签名里、绝不混进业务 payload；`RpcResult<T> = {ok:true,value} | {ok:false,error}`（`rpc.ts:110`），**方法永不抛业务错误**——业务失败是 `RpcResult` 的错误分支，抛异常 = 实现崩溃 = 500（载体层，`fetch/handler.ts:186-191`）。错误模型是**闭合错误码联合**：`RpcErrorDetailsMap`（`rpc.ts:32-96`）是 code → details 类型的表（第二个与 `RpcMethodMap` 同构的表：新错误码 = 一行 + schema 一个分支），`RpcError` 由它分布式展开（`rpc.ts:105-107`），`switch (error.code)` 可窄化 details（`bad-request`、`session-conflict`、`settings-conflict`（带 expected/actual revision 供客户端重读重试）、`model-discovery-failed` 等）。`transportError`（`rpc.ts:119-124`）把载体异常折进 `RpcResult` 错误分支——每个载体消费者统一折叠方式。

### 2.7 信任与安全围栏

浏览器载体把"不可信同源消费者"的假设落到四道围栏：

1. **DNS-rebinding 围栏**：`isTrustedApiRequest`（`packages/client/connection/src/api-request-trust.ts`）校验请求 `Host` 头是 loopback 字面量或在 `trustedHosts` 声明列表里；`0.0.0.0` bind 时 `resolveLanTrust` 采样本机 LAN IPv4 字面量自动喂入（`web-app/src/index.ts:85-92`）——IP 字面量天然免疫 DNS 重绑定（攻击者控制名字、控制不了 IP 字面量），且 `--trusted-host` 只认裸权威（host 或 host:port），坏条目在插件加载时响亮失败（`connection/src/index.ts:136`）。
2. **特权方法 loopback 钉死**：`PRIVILEGED_METHODS`（`connection/src/index.ts:89-119`）里的方法即使受信主机也以空信任列表再过一次围栏（`index.ts:145-149`）——`settings.*`/`credentials.*` 是配置与密钥侦察面，`host.openPath` 驱动宿主桌面，`llm.discoverModels` 让 HOST 向调用者指定的 URL 发 GET 并回报结果（匿名 LAN 调用者会有一个探测宿主可达性的探针）。
3. **跨站写围栏**：`/api` POST 只收 `application/json`（`fetch/handler.ts:277-286`）——text/plain 等"简单 POST"不发 CORS preflight，恶意页面能盲执行 `session.prompt`（响应跨域不可读，副作用仍发生）；只收 JSON 强制进入本服务器永不应答的 preflight。
4. **载体层上限**：`http-bridge.ts` 的 `bridge` 按 `content-length` 与流式累计双重检查 `maxRequestBodyBytes`（默认 160 MiB，`http-bridge.ts:12, 47-66`，为默认 100 MiB 聚合图片 base64 展开 + 头寸设计），超限 413 + `connection: close`；客户端断连检测挂 `ServerResponse 'close'` 而非 `IncomingMessage 'close'`（后者在 body 读完后立即触发，会让每个 SSE 流刚开就 abort，`http-bridge.ts:38-46`）。

其余两个方向：WS upgrade 先过围栏再升级（拒绝时回写 403 响应而非升级，`websocket-downlink.ts:144-153`）；HMR `/plugins/events` SSE 只广播 bundle 重建（dev-only 通道，生产图无 HMR 行）。

### 2.8 路由清单：谁注册了什么

把 shipped web 组合里的全部命名路由/upgrade/席位汇总（注册点均在宿主树行内）：

| 路径 | 种类 | 注册者 | 行为 |
|---|---|---|---|
| `/api` | prefix 路由 | `client-connection`（`connection/src/index.ts:161-173`） | 信任围栏 → `bridge` → `toFetchHandler(apiProxy)` |
| `/api/events.mux`、`/api/events.host` | exact upgrade | `client-connection`（`index.ts:193-194`） | WS 下行：mux/host 事件流（每个订阅者一条） |
| `/plugins` | prefix 路由 | `client-modules`（`modules/src/index.ts:242-244`） | `GET/HEAD /plugins/<id>/client.js[.map]` bundle 服务 |
| `/plugins/events` | exact 路由 | `client-hmr`（`hmr/src/index.ts:166-179`） | SSE 广播 graph/rebuilt 帧（dev-only） |
| `(未匹配)` | fallback 席位 | `frontend-static`（`web-app/src/index.ts:139` 经 `frontend-static`） | SPA dist：403 穿越 / 405 非 GET / miss→index.html 200 |
| `/`（index 响应） | index tap | `client-modules`（`modules/src/index.ts:246-248`） | 每个 index 响应注入最新 `__DSH_BOOT__` 图 |

此外 webserver 内部还有未暴露的「未认领 fallback 时 404」与「handler 抛错回 400」兜底（`webserver/src/index.ts:158-164, 170-180`）。

### 2.9 网关内部：交互域与应答通道

`createApiProxy`（`api-proxy.ts`）除了 unary 域方法，还实现两个**可应答的服务器发起交互**——它们让"宿主主动问浏览器"成为一等公民：

- **用户提问（question/requested）**：宿主需要向用户提结构化问题时，把问题放进 `pendingQuestions` 表并经 mux 流推 `question/requested` 帧（rpcId 是稳定的逻辑 id，`api-proxy.ts:3373-3381`）；浏览器在 UI 上作答后 `POST /api/respond` 回 `ClientResponse`，宿主查表解决该 rpcId（`respond` 域，`fetch/handler.ts:296-300`；`RpcReceipt` 的 `not-pending` 覆盖晚到/重复响应，`api/rpc.ts:182-187`）。
- **批准（approval/requested）**：同样经 mux 推帧（带 approvalId/toolName/callId），解决后 `broadcast({type:'approval/resolved', …})`（`api-proxy.ts:1436`）；**重连恢复**的关键是 mux 流打开时把仍 pending 的 approval/question 用原 rpcId 重放（`api-proxy.ts:3382-3384`）——刷新页面的客户端还能继续应答旧请求，不丢交互。
- 交互的取消面：`ask` 的 abort signal 驱动 turn cancel，`cancelled` 会推给订阅者（`api-proxy.ts:1382-1387`）；退出时 pending 交互随网关生命周期回收。

域的完整清单（`ApiProxyService` 的字段，`apiproxy/src/index.ts:82-94`）：`sessions, subagents, workspace, host, goals, skills, agentPresets, settings, credentials, llm, events, downloads, respond`——每个域一个 `api/<domain>.ts` + `.schema.ts` 对（`api/sessions.ts` + `sessions.schema.ts` 等），schema 文件是双面共用的 wire 校验（`rpc.schema.ts` 的信封 + 各域的请求/值 schema）。

---

## 3. 浏览器客户端：页面加载后发生什么

### 3.1 `window.__DSH_BOOT__` 从哪来、内容是什么

**来源**：Node 侧 `ClientModuleRegistry`（`packages/client/modules/src/index.ts:184-459`）扫描宿主 Loader 的 entry，凡是 package.json 声明 `dsh.client`（`platform: 'web'`，可选 `inject` 边、可选 `immediately`）且 `exports["./client"]` 指向构建产物的包，都进表（`index.ts:332-365`）。构图 `graphRow`（`index.ts:150-158`）为每个包生成一行，`shortHash` 是 sha1 前 12 位（`index.ts:144-147`）：

```jsonc
// window.__DSH_BOOT__ 的实际形状（WebBootGraph，packages/client/modules/src/client/manifest.ts:50-69）
{ "rev": "<graph 内容 hash>",
  "entries": [
    { "id": "@deepseek-ai/dsh-client-runtime",
      "url": "/plugins/@deepseek-ai/dsh-client-runtime/client.js?rev=<bundle hash>",
      "rev": "<bundle hash>" },
    { "id": "@deepseek-ai/dsh-client-ui-goal", "url": "…", "rev": "…",
      "inject": ["…"], "immediately": true }
  ] }
```

- `rev` 是 bundle 内容 hash，随 URL 作缓存破坏查询参数；graph `rev` hash 全部行（`index.ts:315-318`），任何行变化都改变它；
- 注入方式：`injectBootManifest`（`index.ts:168-175`）把 JSON（`<` 转义为 `\u003c` 防脚本逃逸，插件控制的字符串不能突破 script 元素）作为 `<head>` 里**第一条** `<script>`——先于 shell bundle 读取；没有 `<head>` 的夹具页则前置；
- 扫描是增量式：每个 `internal/plugin` 发射把 fiber 的 entry 名标脏，微任务 flush 与激活扫描共用同一实现（`index.ts:218-239, 403-419`），但失败姿态相反——激活时坏声明/缺 bundle 聚成一个响亮 `AggregateError`（FAILED fiber，boot 审计上报，`index.ts:82-100`），稳态时只记 warn 不毒化他人（`index.ts:407-414`）；包元数据（含"不是客户端包"的否定结论）按名缓存、永不过期——插件集变更重启生效，bundle 内容变更只能经 `rebuilt()` 进入图（`index.ts:274-292`）；
- bundle 路由 `GET/HEAD /plugins/<id>/client.js[.map]`（`index.ts:421-457`）：id 可含 scope 斜杠，未知 id/未构建 → 响亮 404（绝不让 SPA fallback 把 HTML 当 JS 发出去），`no-cache` + rev query 锚定一致性。

**消费端**：`packages/client/modules/src/client/manifest.ts:108-144` 的 `parseBootManifest` 把原始 wire 拆成两个视图——`modules`（模块表：id/url/rev）与 `plugins`（entry 组合：id/inject/immediately，缺失字段归一化）。**wire 是双面唯一的单源**：Node 面生产同一形状，浏览器面消费同一形状（`manifest.ts:44-48`：Wire single source）。

**一个包如何入表**（以 `ui-goal` 的真实声明为例，`packages/client/ui-goal/package.json`）：

```jsonc
"exports": {
  ".":       { "types": "./lib/types/index.d.ts",  "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  // …
},
"dsh": {
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-conversation"
    ],
    "platform": "web"
  }
}
```

- `exports["./client"]` 指向 `lib/client.js`——`clientExportOf` 解析它（`modules/src/index.ts:132-142`），`platform: 'web'` 是进入花名册的闸门（`index.ts:350-353`）；
- `dsh.client.inject` 里的包名声明**浏览器侧的依赖边**（模块表视角的 package-name 边），而 `ui-goal` 的 `exports.inject`（`client/index.ts:41`）才是 Cordis entry 的注入声明——两边一致，缺一不可；
- bundle 脚本 `"bundle": "tsdown"`——客户端 bundle 由每个包的 tsdown 构建（`lib/client.js`），不是 monorepo 单一构建；`apps/web`（包名 `@deepseek-ai/dsh-web-frontend`）只是 Vite 构建的 **shell**（`apps/web/package.json` 的 description：vite build over the client-web shell library; dist/ served by dsh web），其 `dist/` 由 `web-app` 的 `resolveDistIndex` 服务（`web-app/src/index.ts:116-124`）。

### 3.2 client/runtime 引导流程：shell kernel

`packages/client/web/src/boot.tsx` 的 `AppWebEntry`（`apps/web/src/main.ts` 只做 `new AppWebEntry(el).run()`，`main.ts:8-10`）是**引导内核**——它自己不能是 loader entry（加载页必须在插件失败时仍能工作；`boot.tsx:1-9` 的"shell self-sufficiency rule"：shell 不 value-import 任何插件包），唯一例外是 modules 包（模块系统无法通过自己抵达，`boot.tsx:6-9`）。`run()`（`boot.tsx:97-143`）按序：

1. `parseBootManifest(window.__DSH_BOOT__)`——缺/坏即抛（没有合法 manifest 的页面无法启动任何东西）；
2. `new ClientModuleSystem({modules, staticModules: getStaticModules()})`，`registerStatic(APP_SHELL_ID, AppShell)` 注册壳自有的 assembly 模块，`registerStatic(MODULES_ID, ModulesClient)` 采纳 modules 包自身（裸包名 = graph 行 id = entry 名，带后缀的 key 会错过 statics 分支触发真实 fetch，`boot.tsx:103-111`），`window.__DSH_MODULES__ = this.modules` 放握手槽（wrapper 的 apply 读它 provide `ctx.modules`）；
3. 渲染加载页 `<AppRoot …/>`（React 根，显示 fiber 状态/失败报告；`loader-status.ts` 的状态 store 驱动进度）；
4. **并行**：`prefetchImmediateTier()`（为每个 `immediately` 行拉脚本注册 factory，`boot.tsx:151-158`）+ `new Context()`；
5. `runPluginBoot`（`boot.tsx:161-208`）：`ctx.plugin(Loader)` → **在任何 entry 存在前** `loader.internal = this.modules`（否则浏览器里 `tree.import` 的裸动态 import 必炸——正确的 tripwire，但不是路径，`boot.tsx:165-168`）→ 等 prefetch 屏障（跨包同步 require 边需要所有 immediately factory 先注册；单行失败静默、由 create 侧 import 重试并拥有响亮失败，`boot.tsx:183`）→ 按 `[MODULES_ID, ...plugins, APP_SHELL_ID]` 并发 `loader.create({name})`（app-shell 是内核追加的壳自有序，`boot.tsx:189-204`）→ `loader.await()` + `assertEntriesActive()` 全量扫 fiber（无 fiber=import 失败，PENDING=缺服务，`boot.tsx:216-237`）；
6. 成功置 `settled` 信号，AppRoot 一次性切到真实 UI；失败留在加载页渲染失败报告。

```ts
// packages/client/web/src/boot.tsx:161-207 —— 插件面引导（节选）
private async runPluginBoot(prefetching: Promise<void>): Promise<void> {
  const ctx = this.ctx
  await ctx.plugin(Loader)
  const loader = ctx.loader
  loader.internal = this.modules as never   // 模块系统先于任何 entry 注入
  ctx.on('internal/status', (fiber) => { … this.status.set(entry.options.name, STATE_LABELS[entry.fiber.state]) })
  await prefetching                            // immediately 层工厂先注册
  const rows = [MODULES_ID, ...this.manifest.plugins.map(row => row.id).filter(id => id !== MODULES_ID), APP_SHELL_ID]
  await Promise.all(rows.map(async (name) => {
    this.status.set(name, 'loading')
    const id = await loader.create({ name })
    if (loader.resolve(id).fiber === undefined) this.status.set(name, 'failed')
  }))
  await loader.await()
  this.assertEntriesActive()
}
```

settle 后：app-shell entry（`packages/client/web/src/app-shell.ts:35-50`）`ctx.slots.install(createSlotRenderer())`（一次性安装渲染器）并 `provide('appShell', …)`；`buildRenderApp`（`app.tsx:26-44`）的渲染就是**程序里唯一的 ctx 级 renderSlot 调用**：`ctx.slots.renderSlot('root', {})`——整棵 UI 树挂在内置 `root` 槽上（ui-layout 的 AppFrame 占据它，`app.tsx:38-43`）。

### 3.3 connection 的传输：HTTP POST 上行 + WebSocket 下行

浏览器侧 `WebApiClient`（`packages/client/connection/src/client/web-api-client.ts:13-90`）继承 `AbstractApiClient`（`packages/host/apiproxy/src/fetch/client.ts:244-513`）：

- **上行（unary/respond）**：`doFetch` = `globalThis.fetch`（`web-api-client.ts:14-16`）；`callUnary`（`fetch/client.ts:333-350`）走 `POST /api/<method>`，信封 `{type:'client-request', rpcId, method, payload}`（rpcId 由 `mintRpcId` = `crypto.randomUUID` 铸造，浏览器/Node 通用，`fetch/client.ts:298-301`），`serverResponseSchema` 解析 + **rpcId 回声校验**（`fetch/client.ts:344`），第二级 `UNARY_VALUE_SCHEMAS` 校验业务值——与 handler 侧的请求校验表互为镜像，同样由 `RpcMethodMap` 编译期锁死（`fetch/client.ts:172-225`）；默认 30s 超时，`AbortSignal.any([timeout, callerSignal])` 合并（`fetch/client.ts:227-228, 313-317`），`host.pickDirectory` 是 `'caller-signal-only'` 例外——原生对话框合法地比普通 unary 开得久（`fetch/client.ts:436-440`）；
- **下行（事件流）**：`openMux`/`openHost` override 成 `readWebSocket`（`web-api-client.ts:34-90`）——`ws://`/`wss://`（按页面协议推导）建连，`serverRequestSchema`+`frameSchema` 双段解析，坏帧丢弃不杀流（`web-api-client.ts:51-64`），异步生成器 + 内部 inbox 队列实现"惰性拉取"（无人 for-await 就不读 socket，`web-api-client.ts:74-82`）；`onOpen` 在 open 事件时触发（连接就绪握手用）；
- **信封观察**：`AbstractApiClient` 有微任务批量的信封缓冲与 `subscribeEnvelopes`（`fetch/client.ts:246-290`）——帧风暴不能每帧一次消费者更新，诊断/日志消费者订阅批次；
- 注意这里没有 SSE/轮询：**POST JSON 上行、WS 纯下行、事件永远不轮询**。进程内测试形态 `InProcessApiClient(toFetchHandler(api))` 完全不过网络（同构点，`fetch/client.ts:520-541`），且 `doFetch` 忠实复刻真 fetch 的 abort 语义（handler 无视 signal 时也拒绝，`fetch/client.ts:529-540`）。

连接生命周期由 `ConnectionController`（`packages/client/connection/src/client/connection.ts:61-202`）管理：一代（generation）= 两条流 + `host.describe` 握手，**全部就绪才 `onConnected`**（严格就绪握手：describe 证明 unary 可达、两个 onOpen 证明物理流已建立——否则 resync 会跑在 subscribed 基线之前；3s 超时防坏代理，`connection.ts:132-159`）；任一流断 → `reconnecting` + 指数退避重连（500ms 起 ×2 封顶 10s，带抖动，`connection.ts:91-95`）；sink 异常被隔离（业务层崩了不能拖垮连接层，`connection.ts:194-201`）。`client/runtime` 的 `apply`（`packages/client/runtime/src/client/index.ts:188-233`）把 `onMuxEnvelope/onHostEnvelope/onConnected/onStateChange` 接到 `SessionRuntime`/`WorkspaceRuntime`：mux 帧进 session 层、host 帧进 session+workspace 层、`host/remote-event` 帧经 `ctx.remote.$dispatch` 扇出（`index.ts:204-217`）、`onConnected` 发 `connection/reset` 事件让 wire 派生缓存重拉（`index.ts:218-222`）、`reconnecting` 时 drop 代际交互状态（`index.ts:223-230`）。

### 3.4 客户端插件如何注册（`dsh.client` 字段）与模块图组合

- **声明**：包 package.json 里 `"dsh": { "client": { "platform": "web", "inject": […], "immediately": true } }` + `exports["./client"]` 指向构建出的 bundle（`packages/client/modules/src/index.ts:109-142, 344-365`；`clientExportOf` 支持字符串与单层条件形式，`index.ts:132-142`）。
- **bundle 执行只注册**：每个 bundle 是个经典 `<script>`，执行时调用 `window.__ModuleLoader__.load({id, factory})`（`packages/client/modules/src/client/system.ts:86-95`）——**只注册 factory，不跑模块体**（懒 CJS 模型，`manifest.ts:9-26`：一切副作用——CSS 注入也包括——都在 factory 闭包里，物化时才跑）。重复注册即抛（bundle 被执行两次而没 invalidate 永远是 bug）。
- **组合 = 按需物化**：`ClientModuleSystem.import`/`makeRequire` 的分支顺序（`system.ts:142-178`）：seed 词（平台单例）→ 静态注册（app-shell/modules）→ 已物化 record → 已注册 factory（递归物化）→ graph 行（先 `arrive` 拉脚本再物化）→ 否则**响亮抛错**（运行时镜像构建期 bundle 纯度门，`system.ts:151-155, 170-174`）。`materialize` 有重入守卫（factory 形态的 CJS 无法交付部分导出，环即致命，`system.ts:114-133`），并把物化时注入的 `<style>` 标签记账到 `data-plugin`（HMR 用，`system.ts:41-51`：preset 发的标签自带 data-plugin，未标记的认领给物化插件）。`import` 的同步 require 分支没有加载分支——加载是异步的，所以只有已注册的 bundle 能被 require，跨插件值导入本来就是构建错误（`system.ts:18-25`）。
- **平台单例表** `getStaticModules`（`packages/client/web/src/seed.ts:25-40`）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`ui-slots`、`web-react`、`ui-primitives`、`ui-attachment`、`schema-form`——fetch 的 bundle 解析 externals 只认这张表（`satisfies PlatformModule` 编译期锁死，`seed.ts:29-40`），值保持 shell 静态 import 所以每个 bundle 看到同一实例。
- **`dsh.client.inject` 边**：bundle 内 `exports.inject`（如 `['slots','sessions','remote','remote.goals','locale']`，见 `ui-goal/src/client/index.ts:41`）被 Loader 当作 entry 注入声明——**浏览器里的插件激活顺序由服务依赖等待（fiber inject waiting）决定**，与 Node 侧完全同构；graph 行的 `inject` 只是信息性元数据（预检展示/HMR diff），权威边在包声明里（`manifest.ts:57-59`）。

### 3.5 HMR 机制

`packages/client/hmr` 双侧：

- **Node 半**（`src/index.ts:57-191`）：一个 interval（默认 500ms）`statSync` 轮询每个 graph 行的 bundle（网络挂载没有 inotify，轮询是设计选择，`index.ts:7-9`），stat 变化 → `ctx.clientModules.rebuilt(id)` 重 hash → rev 真变才经 `onRebuilt` 通知（`index.ts:64-80`）；watch 集通过 `onGraphChanged` 与 graph 同步（`index.ts:118-131`）；同时开 `/plugins/events` SSE 广播 `graph`/`rebuilt` 帧（`index.ts:148-190`）。构建侧 `pnpm run dev:web` 的 watcher 是触发者——没有它，轮询观察到无变化，整条链空闲（`index.ts:7-10`）。
- **浏览器半**（`src/client/index.ts:98-181`）：`EventSource('/plugins/events')` 收 `rebuilt` 帧 → `reload(id)`：
  1. `modLoader.invalidate(id)`（删旧 factory+record，**必须先 invalidate 再 prefetch**——活 factory 使 prefetch 变 no-op 且重复注册响亮报错，`client/index.ts:110-116`）；
  2. `prefetch` 注册新 factory（纯注册无副作用）；
  3. **registry-first teardown**：先 `entry.ctx.registry.delete(runtime.callback)` 再排空旧 fiber 的 `inertia`、`delete entry.fiber`——顺序错了 Loader 的 self-dispose 分支会把 entry 永久标 `disabled`（`client/index.ts:118-129`，module 注释 `38-52` 解释了为什么不走朴素的 `fiber.dispose()→refresh()`）；
  4. 删旧 `<style data-plugin>`（`client/index.ts:87-91, 132`）；
  5. `entry.refresh()` 物化新 factory（CSS 在此注入）并重插插件（`client/index.ts:137-139`），`entry.fiber?.await()` 表面化 apply 失败。
- **级联零手写**：下游 fiber 以 provider fiber uid 作为激活纪元，换 provider 自动级联到 UI 依赖（`client/index.ts:11-14`）；无回滚策略，失败留 FAILED 状态供 shell 状态投影（`client/index.ts:60-63`）；reload 串行化队列防交错（`client/index.ts:144-164`）；插件可自我重载（旧 bundle 闭包跑完在途 reload，新 bundle 重开通道，`client/index.ts:54-58`）。生产图里根本没有 HMR 行（`cordis.patch.yml:21-23` 禁用共享 HMR），`client-hmr` 行空闲待命。

### 3.6 运行时客户端服务速览（runtime/client）

`packages/client/runtime/src/client/index.ts` 只做装配与类型合并，主体在 `sessions/`、`workspaces/`、`conversation/` 子目录：

- `SessionRuntime`（`sessions/service.ts`）是会话状态机：列表/当前选择/历史拉取/会话 CRUD，消费 `connection.api`（`IApiClient`）与 `ctx.remote`，向 UI 暴露 `ctx.sessions`（`contract/sessions.ts` 的 `ISessions` 面）；`SessionProvideChannel`（`sessions/provide.ts`）是提供通道（物化/投影单一实现，测试运行时共用）；
- `SessionManager`（`sessions/manager.ts`，1131 行）是实例簇 `Map<SessionId, Session>` + 帧派发入口 + 列表状态（`manager.ts:1-3`）。列表快照 `SessionListSnapshot`（`manager.ts:43-55`）有两个正交轴：`state`（idle/loading/error，拉取活动）与 `phase`（pending/ready，**到达生命周期**——`ready` 单调不回退，`manager.ts:26-34`；空数组在 pending 时表示"什么都没到"而非"什么都没有"）；列表数据**绝不进 zustand**，React 经 `subscribe`/`getListSnapshot` 连接（`manager.ts:2-3`）；`mergeOrderedBaseline`（`ordered-baseline.ts`）合并有序基线；subagent 目录、jobs-by-session 都投影进快照；
- 会话事件经 `handleMuxEnvelope` 喂给 conversation 装配器（`conversation-assembler.ts`）产出 `ConversationSnapshot`（节点树：user/assistant/tool/todo 等，`contract/conversation.ts` 的节点联合）；`projection-store.ts` 是 push 模型的投影值存储（host 算好整值经 `session/projection` 帧推送，客户端按 `seq` 高者胜，`index.ts:104-108`）；
- `SlotRegistry` 服务层在 `slots.ts`（见 §4.1）；`conversation/event-registry.ts`/`view-registry.ts` 是会话节点定义与视图构建器注册表（`conversation.chat.node` 等 slot 的 business 面）；
- `WorkspaceRuntime`（`workspaces/service.ts`）管工作区列表/初始选择，同样消费 `connection.api` + host 帧；
- `Notifier`（`sessions/notifier.ts`）把批量变更通知给快照订阅者；`pending.ts` 建模待处理交互（queue/steering/context 三种 placement）；`remotes.ts` 是会话域 Remote 方法到 `IApiClient` 的接线——运行时内部的域服务都遵循"业务代码只碰 payload 直接方法、载体铸 rpcId"的纪律（`fetch/client.ts:71-85`）。
- 类型合并的妙处：`client/index.ts:124-151` 用 `declare module '@deepseek-ai/dsh-client-ui-slots'` 给 `SessionStandardProps`/`GlobalStandardProps` 填上真实成员（`useSession`、`sessionId`、`useProjection`、`useSessions`、`useWorkspaces`）——ui-slots 声明空座位，runtime（subject 所在处）合并具体类型，依赖方向保持"框架 → 业务"。

### 3.7 加载页与失败报告（AppRoot）

`packages/client/web/src/AppRoot.tsx` 是 shell 根组件：`useSyncExternalStore` 订阅三个 kernel 信号（`settled`/`status`/`error`），未 settle 时渲染加载页，settle 后**一次性**切到 `props.renderApp()`（`app.tsx:26-44` 的 `ctx.slots.renderSlot('root', {})`）。失败时留在加载页并列出每个 failed entry 名 + sweep 报告（`AppRoot.tsx:37-56`）——"fail loud, no partial UI"。

`loader-status.ts` 的细节值得注意：

- `FiberState` 是跨包 const enum，没有运行时对象可 import（esbuild 管线不能跨模块内联），所以本地镜像 `FIBER_STATE` 保留类型同时给值（`loader-status.ts:21-28`，与 `app-boot/index.ts:671-673`、`plugin-inventory/src/index.ts:23-30`、`client/web/src/loader-status.ts` 三处各自镜像——代码注释互相指向对方保持对齐）；
- 状态 store 是**手写的**（`loader-status.ts:100-111`），不是运行时插件的 snapshot-store 机制——shell 自足规则：内核不得 value-import 任何插件包，加载页必须在插件失败时（尤其失败时）仍工作（`loader-status.ts:7-12`）；
- `internal/status` 订阅把每个 fiber 状态投影成一行（`boot.tsx:173-177`）——AppRoot 显示的是真实 fiber 状态的投影，不是转述（`loader-status.ts:2-6`）；copy-on-write 保证 `getSnapshot` 引用只在写时变化（useSyncExternalStore 契约，`loader-status.ts:92-93`）。

### 3.8 从页面刷新到可对话：浏览器侧全生命周期

把 §3.1–§3.7 串成一条时间线（假设 host 已在 `127.0.0.1:8080` 运行）：

1. **导航**：浏览器 GET `/` → webserver fallback（`frontend-static`）读 `dist/index.html` → `applyIndexTaps` 注入 `<script>window.__DSH_BOOT__ = {…图…}</script>` 到 `<head>` 首位（`modules/src/index.ts:168-175`）→ 200 + text/html。
2. **manifest 解析**：shell bundle（`apps/web` 的 `main.ts` → `boot.tsx` 的 `AppWebEntry.run`）读 `__DSH_BOOT__`，`parseBootManifest` 拆成 modules/plugins 两视图（`boot.tsx:98`）。
3. **模块系统就位**：`new ClientModuleSystem(...)` + `registerStatic`(app-shell, modules) + `__DSH_MODULES__` 握手槽（`boot.tsx:100-112`）；渲染加载页（`AppRoot`，spinner + "Loading plugins…"）。
4. **immediately 层预取**：并行 `prefetch` 每个 `immediately` 行（如 runtime、locale、ui-layout、ui-conversation、modules 等）——`<script src="/plugins/<id>/client.js?rev=…">` 执行并注册 factory（`boot.tsx:151-158`、`system.ts:99-111`）。
5. **插件树启动**：`ctx.plugin(Loader)` + `loader.internal = modules` + 等 prefetch 屏障 + 并发 `loader.create` 每个 entry（`boot.tsx:161-204`）——**浏览器版 Cordis Loader** 按 entry 的 `inject` 依赖等待逐个激活 fiber：modules（provide `ctx.modules`）→ connection（provide 传输）→ runtime（`slots/sessions/workspaces` 服务 + 启动 `ConnectionController`）→ ui-layout（占 root 槽）→ 各 `ui-*` 注册进槽。
6. **连接建立**：`ConnectionController` 一代握手——两条 WS（mux/host）open + `host.describe` 成功 → `onConnected`（`connection.ts:132-159`）→ runtime 的 `sessions.handleConnected()` 拉列表基线、`workspaces.handleConnected()`、发 `connection/reset`（`runtime/client/index.ts:218-222`）。
7. **UI 呈现**：`loader.await()` + 全量扫 fiber 全 ACTIVE → `settled=true` → AppRoot 切 `renderApp()` = `ctx.slots.renderSlot('root', {})`（`app.tsx:41`）→ AppFrame 渲染 sidebar/conversation/details，会话列表经 `useSessions` 选择器钩子进 UI。
8. **可对话**：用户输入 → ui-conversation 的 composer 槽 → `ctx.remote` 或 `connection.api.sessions.prompt({...})` → POST `/api/session.prompt` → 网关 → 宿主 `api.sessions.prompt` → 模型流经 `session/event` 帧 → mux WS 推回 → `SessionRuntime.handleMuxEnvelope` → conversation 装配器增量更新 `ConversationSnapshot` → 槽组件重渲染。
9. **断线**：任一流挂 → `reconnecting` + 退避重连；重连成功 = 新一代握手 + 基线重放（mux 流打开时宿主重推 subscribed/queue/jobs 基线，`api-proxy.ts:3368-3406`）——客户端状态收敛不需要额外协议。
10. **HMR（仅 dev）**：`pnpm run dev:web` 的 watcher 重写某个 bundle → `client-hmr` Node 半轮询发现 → `rebuilt(id)` 改 rev → `/plugins/events` 广播 `rebuilt` → 浏览器半 invalidate→prefetch→registry-first teardown→`entry.refresh()` 原地换 fiber（§3.5）。

这 10 步里没有一步是浏览器自己"发明"的：manifest、插件集、bundle 内容、服务依赖图全部来自宿主树。

### 3.9 开发工作流：`pnpm run dev:web` 与 HMR 链

生产与开发的关键差别只有**一条额外的 host 行**与**一个构建 watcher**：

- **构建侧**：`apps/web` 的 `watch` 脚本是 `vite build --watch`（`apps/web/package.json`），`pnpm run dev:web` 让每个 `dsh.client` 包的 tsdown `--watch` 并行重写 `lib/client.js`；各包 bundle 的产物路径即 `exports["./client"]` 指向的位置，`client-hmr` 的 Node 半按 `clientPath(id)` 轮询的就是这些文件（`hmr/src/index.ts:118-131`）。
- **watch 链**：文件写入 →（≤500ms）`statSync` 变化 → `rebuilt(id)` 重 hash → rev 变 → `onRebuilt` → SSE `rebuilt` 帧 → 浏览器半 `reload(id)`（§3.5）。`rebuilt()` 是 bundle 内容进入图的**唯一入口**（`modules/src/index.ts:274-292`），插件集变化（新增 `dsh.client` 包）仍要重启——元数据缓存永不过期是显式设计（`modules/src/index.ts:16-19`）。
- **Vite 与生产共用同一套产物语义**：`apps/web` 的 Vite 构建只是 shell（拒绝独立 serve，`vite.config.ts:7-19`），插件 bundle 从不进 shell 包——所以 HMR 是"插件级"的：react/cordis/shell 的变化仍意味着整页刷新（`client/hmr/src/client/index.ts:8-10`）。
- 文档化的更新契约（web-app 的 prompt 段，`web-app/src/index.ts:95-106`）：客户端插件改动在 `dev:web` 运行期间无需刷新自动生效；shell 与普通包改动需重建 Web 产物并刷新页面——这是给模型 agent 的明确边界。

---

## 4. UI 插件体系：slots / layout / 典型插件

### 4.1 插槽模型（ui-slots）

`packages/client/ui-slots/src/index.ts` 是**零运行时依赖的纯核心**（React 类型除外）：

- `SlotMap`（`index.ts:24`）与 `LocaleNamespaceMap`（`index.ts:34`）都是**空接口 + 声明合并**：每个 UI 包用 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'sidebar': {…} } }` 贡献槽位契约，注册点与组件 props 全部类型推导；`keyof SlotMap & string` 是 declare-merge 键模式（空图里是 `never`，真实程序里是字符串联合，`index.ts:11-15`）；
- 槽位有两个轴：`SlotKind`（`'single' | 'list' | 'keyed' | 'chain'`，`index.ts:88`）与 `SlotScope`（`'root' | 'session-maybe' | 'session'`，`index.ts:91`）；`SlotEntryDef`（`index.ts:100-122`）声明 owner props 份额、keyProps、hookContext、inject 面；
- **声明即认领**：`register({name, children: {...}})` 里 `children` 表既声明子槽、又授予本 entry 渲染这些子槽的独占权（`ChildrenDecl`，`index.ts:145`），并把运行时 spec（kind/scope）钉进去；渲染通过 props 里的 `renderSlot`/`renderSlotChain` 下放（`PropsRenderSlots`，`index.ts:336-363`）；声明了 children 却不用 renderSlot 会在编译期失败（`RendersCheck`，`index.ts:518-524`）；`chain` 槽由每个 entry 的纯 selector（`ChainSelect`，`index.ts:257`）在渲染时按 priority 序路由，首个非 null 当选（如 `conversation.composer`）；
- `SlotCore.register`（`index.ts:741-896`）运行时校验：未声明槽注册抛错、子槽二次声明抛错、single/keyed/list 同 cell 同 priority 二次注册抛错（不同 priority 是 shadowing，最低者渲染，`index.ts:797-824`）、链槽缺 `select` 抛错、store 句柄跨 scope 挂载抛错（`index.ts:835-843`）；
- 组件 props 是**四份额交集** `ComposedProps`（`index.ts:442-450`）：运行时份额（owner + 标准 kit）+ 子槽渲染份额 + store 份额 + 注册者 inject 面（`hooks` 舱转成 `use<Name>` 选择器钩子，`index.ts:411-432`）+ locale `t` 席位（`index.ts:80-85`）；
- 变化传播：版本号同步 bump + `subscribe` 微任务批量通知 + `subscribeDeclaration` 同步通知（`index.ts:663-676`）；`reportEntryError` 支持"崩溃退位"（abdicate：崩溃的 entry 从 cell 退休让位给下一个幸存者，`index.ts:1098-1106`）；disposer 级联拆除声明子树（`index.ts:1129-1149`）。

`SlotRegistry`（`packages/client/runtime/src/client/slots.ts:93-471`）是 Cordis Service 层：`onMutate → ctx.emit('slots/changed')`（`slots.ts:106`）、经 `ctx.effect` 把注册绑到调用方 fiber（插件卸载 = 级联拆除，且 register 必须是原型方法——service proxy 在调用时把 `this.ctx` 绑到调用者 context，箭头属性会把 this 冻在服务自己的根 ctx 上静默破坏按插件销毁，`slots.ts:119-126, 464-471`）、store 实例轴（handle × scope，session 实例按 sessionId 缓存、scope 死亡时 `pruneStoreScope` 清持久化状态，`slots.ts:422-436, 272-279`）、`install(renderer)` 一次性装渲染器、`installLocale(face)` 装 locale 面（均 boot-once，`slots.ts:213-238`）、`inject(key, cb)` 按声明生命周期装效果（`slots.ts:143-205`）。

**store 契约**（`packages/client/ui-slots/src/store.ts`）是框架中立的：`StoreSpec<T,A>` = `{init: ()=>T, persist?: string, actions: ActionsDecl}`（`store.ts:44-48`）——actions 是纯 immer-draft 变换、也是 store 的**完整写集（审计面）**：组件只能通过这些写（`store.ts:19-28`）；`BakedActions` 把 draft 参数烤掉（`store.ts:35-37`）；`StoreInstance` 是 create() 的产物（`getSnapshot/subscribe/actions/clearPersisted`，`store.ts:58-73`）——**引擎不骑 React hook**（引擎住在 React-free 的 runtime），渲染机制自己把 `useStore` 钩子绑到这个源上并缓存（`store.ts:50-57`）；句柄绝不在模块级 export（模块缓存身份是跨插件 reload 的伪装单例，`store.ts:76-80`）。

### 4.2 布局：ui-layout 的 AppFrame 与四个子槽

`packages/client/ui-layout/src/client/index.ts`：

- 一次 `ctx.slots.register({name:'root', children:{'sidebar','conversation','details','shell.overlay'}, store: createLayoutStore, inject: …}, AppFrame)`（`index.ts:116-143`）同时完成四件事：占据内置 root 槽、声明四个子槽（声明=独占渲染权）、座入布局 store（面板几何）、把 store 的 bound actions 接进 `ctx.layout` 服务（`index.ts:133-136`）；
- 四个子槽（`index.ts:33-84`）：`sidebar`（single/root，owner 收 collapsed/width，`index.ts:94-99`）、`conversation`（single/**session-maybe**——同 React 身份跨会话切换保状态）、`details`（single/session）、`shell.overlay`（**list**/root——加性席位，点击穿透直到 opt-in，`index.ts:73-83`）；文档明说"要自己加浮层就注册 shell.overlay，别注册 root"（root 是 single，第二个 entry 会 shadow 掉整个框架，`slots.ts:26-42`）；
- `ctx.layout` 是跨插件面板动作契约（`service.ts` 的 `LayoutController`）；主题由第二个 effect 投影到 `document.body`（`index.ts:147-155`，`theme-presenter.ts` 纯 DOM 写、事件驱动无 React 路径）。全局样式归 `ui-theme`（`--dsw-*` token 与语义别名），组件样式用 CSS Modules，特征组件不许定义全局主题（`docs/web-styling.md:9-21`）。

### 4.3 典型 UI 插件：ui-goal（投影 + Remote 调用）

`packages/client/ui-goal/src/client/index.ts:47-99` 是教科书式客户端插件：

- `inject = ['slots','sessions','remote','remote.goals','locale','conversationEvents']`（`index.ts:41`）——**fiber 注入等待**决定激活时机；
- `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({name:'conversation.chat.node', key:'command-input', locale: NS}, GoalCommandInputView))`（`index.ts:51-55`）：子槽由 ui-conversation 声明，ui-goal 注册 **keyed 单元**；
- `ctx.slots.inject('conversation.input.dock', …)`（`index.ts:72-99`）：注册 GoalDock 到输入坞的 list 槽（`id:'goal', order:10`），`inject: (sessionId) => GoalBarActions` 工厂返回**业务面**——四个变更动词（onEdit/onPause/onResume/onClear），内部先 `sessions.binding(sessionId).session.projections.faceOf('goal')` 读当前投影拿 `{id, revision}` 作 CAS ref，再 `await ctx.remote.goals.edit(sessionId, ref, {objective})`（`index.ts:60-97`）；**CAS ref 在调用时读**，没有陈旧围栏——RPC 的 CAS 就是守卫；
- **投影模式**：live goal 经 `useProjection('goal')` 到达（历史尾页播种 + `session/projection` 帧更新），所以这个插件**没有 store、没有刷新链、没有事件监听**（`index.ts:1-9`）；`GoalProjection`/`GoalRef` 类型从 `@deepseek-ai/dsh-goal/client`（域的纯 outlet）type-only 引入；
- 字典：`ctx.locale.register('goal', {zh, en})` + `LocaleNamespaceMap` 合并（`index.ts:30-38, 49`），组件拿类型化 `t` 席位（`locale: NS` 注册选项）。

```ts
// packages/client/ui-goal/src/client/index.ts:72-99 —— 一个典型 UI 插件入口（节选）
ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
  name: 'conversation.input.dock',
  id: 'goal',
  order: 10,
  locale: NS,
  inject: (sessionId): GoalBarActions => ({
    onEdit: async (objective) => {
      const ref = refOf(sessionId)
      if (ref === undefined) return noCurrentGoal
      return await ctx.remote.goals.edit(sessionId, ref, { objective })
    },
    onPause: async () => {
      const ref = refOf(sessionId)
      if (ref === undefined) return noCurrentGoal
      return await ctx.remote.goals.pause(sessionId, ref)
    },
    // …onResume / onClear 同构
  }),
}, GoalDock))
```

**浏览器插件调用 host RPC 的完整路径**：`ctx.remote.<域>.<方法>`（Typert Remote 生成的客户端）→ `IApiClient` 域方法（`fetch/client.ts:474-481` 的 `goals.create/edit/…`）→ `callUnary` 铸 rpcId + 信封 → `POST /api/goal.edit` → webserver `/api` 路由 → 信任围栏 → `toFetchHandler` 的 `UNARY_ROUTES` → `api.goals.edit`（宿主 `createApiProxy` 闭包）→ 宿主 Cordis 服务。Remote 贡献装配在 `packages/api/remotes/src/client/index.ts:105-122`（`commandsRemote, goalsRemote, dynamicRemote, pluginInventoryRemote, messageFeedbackRemote` 逐个 `ctx.remote.$mount`）。

`ui-goal/src/client/slots.ts` 展示了 inject 面的类型纪律：`GoalBarActions` 只含四个变更动词（`slots.ts:20-31`），**live goal 值不在 face 里**——它经 `useProjection('goal')`（框架标准 kit）到达，inject 只带变更回调、live 状态走投影（`slots.ts:1-8`："callbacks from inject, live state from useProjection"）；`GoalActionResult = RemoteResult<unknown>`（`slots.ts:17`），条带只渲染失败——成功的突变值经投影到达，成功值在这里保持未读（`slots.ts:13-16`）。

**UI 插件骨架模板**（从 ui-goal/ui-layout/ui-settings/locale 归纳）：一个 `ui-*` 包 = `src/index.ts`（host 面，多为空/仅类型）+ `src/client/index.ts`（浏览器入口）+ `src/client/*.tsx`（组件）+ package.json 的 `dsh.client` 声明 + tsdown bundle。浏览器入口的标准形状：

```ts
// 模板：一个典型 UI 插件的客户端入口
declare module '@deepseek-ai/dsh-client-ui-slots' { /* SlotMap / LocaleNamespaceMap 合并 */ }
export const inject = ['slots', 'sessions', 'remote', '…域服务', 'locale', 'conversationEvents'] // 依赖等待
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '…: dictionaries')      // 字典
  ctx.slots.inject('…父槽', () => ctx.slots.register({                          // 注册进已声明槽
    name: '…槽', key/id/order, locale: NS,
    inject: (sessionId) => ({ …业务动词, 内部调 ctx.remote.… }),
  }, SomeComponent))
}
```

### 4.4 其他 UI 包速览

- **ui-settings**（`packages/client/ui-settings/src/client/index.ts:33-35`）只做 `new SettingsScopeBinder(ctx)`：提供 `ctx.settingsScope`——设置命名空间的宿主传输（`settings-scope.ts`），每个偏好行绑定持久段时经 `bind` 惰性解析（`inject=[]` 什么都不等，`index.ts:20-24`）；槽类型契约在 `contract/slots.ts`；设置**外壳**（sidebar.settings 占据者、导航、chrome）放在 `ui-settings-general`，因为壳依赖 ui-sidebar 会经 ui-layout/ui-theme 形成引用环（`index.ts:1-9`）。
- **locale**（`packages/client/locale`）以同样模式工作：`LocaleNamespaceMap` 合并 + `ctx.locale.register(NS, {zh, en})` + 槽组件拿类型化 `t` 席位；ui-slots 的 `PropsLocale` 保证声明了 `locale:` 的注册才拿到 `t`（`ui-slots/index.ts:80-85`）。
- **ui-primitives**（`packages/client/ui-primitives`）是共享组件库（Button/Modal/Menu/Toast/MarkdownText/TerminalBlock/JsonTree 等，纯展示）+ 平台 seed 表成员（`seed.ts:38`）；ui-theme 拥有全部 token；web-react（`packages/client/web-react`）是 React 绑定层：`createSlotRenderer`、`bindSnapshotSelector`、`scoped-slots`、`session-provider`、`use-invoke`——把 ui-slots 的纯注册表接到 React 渲染树。
- web bundle 的客户端花名册（`packages/bundle/web-app/cordis.patch.yml:174-275`）列出全部 `dsh.client` 行：ui-theme、locale、ui-layout、ui-sidebar、ui-settings(×4)、ui-conversation、ui-tool、ui-cordis、ui-workflow-run、ui-deliverables、ui-workspace、ui-input-trigger、ui-commands、ui-skill、ui-subagent、ui-jobs、ui-goal、ui-message-feedback、ui-model-selection、ui-permission、ui-agent-preset、ui-settings-plugins、ui-plan、ui-user-questions、ui-trajectory——**一个 UI 功能 = 一个 `dsh.client` 行 = 一个浏览器插件 bundle**，与 host 侧工具行（tool-bash 等）在同一 patch 文件里并列，同一棵树的投影。

### 4.5 React 绑定层（web-react）如何把注册表接到渲染树

`packages/client/web-react` 是 ui-slots 的 React 出口，几个关键成员：

- `createSlotRenderer()`（`renderer.ts` 的 `SlotRenderer` 实现）：`renderRoot` 从 `SlotCore.entriesOfSlot(key)` 取当前胜者（single 槽取 priority 最低的活 entry，list 槽按 `order` 细化），渲染时把四份额 props（owner + 标准 kit + renderSlot 下放 + store 实例 + inject 面 + locale `t`）组合后传入组件；用 `useSyncExternalStore` 订阅 `subscribe`/`getVersion`，槽注册变化 → 重渲染；entry 崩溃经边界捕获后 `reportEntryError`（abdicate 让位给 cell 下一个幸存者）；
- `bindSnapshotSelector`（`bind.ts`）：把 `getSnapshot`-风格的可观察对象绑成 `use<Name>` 选择器钩子——ui-slots 的 `PropsHooks` 类型（`ui-slots/index.ts:421-424`）消费的就是这个形状；app-shell 用它对 `sessions.list` 绑定出 `useSessions`（`app.tsx:30`）；
- `session-provider.tsx`：session 作用域子槽的框架注入座位——`SessionProvider` 订阅 runtime 的会话选择，按 `key=sessionId` 重挂载 children（`ui-slots/index.ts:312-325` 的 `SessionAreaProps`/`SessionProviderComponent` 契约）；
- `scoped-slots.tsx`：keyed/list 槽的 dispatch 组件（entryKey/only/fallback 选项，`ui-slots/index.ts:224-230` 的 `RenderOpts`）。

装配关系：`app-shell` 的 `apply` 调 `ctx.slots.install(createSlotRenderer())`（`app-shell.ts:39`）——**渲染器安装是 shell 领地**（web-react 是 shell 打包的），但 `ctx.slots` 要等 runtime entry 激活才存在，所以落在 inject 集合保证时序的 app-shell entry 上（`app-shell.ts:36-39`）。

---

## 5. 设计哲学观察

### 5.1 Host/Client 双面架构：同一 monorepo 双构建面

- 同一包的 `src/index.ts`（Node 面）与 `src/client/index.ts`（浏览器面）通过 `exports["./client"]` 区分；`client/connection/src/client/api.ts:5` 明确写"NEVER import the package root: it drags bootHost/cordis into the browser bundle"。构建面隔离是**导入纪律 + 编译器**保证的：`apps/web/vite.config.ts` 只把 shell 需要的少量包（`web`/`web-react`/`ui-slots`/`ui-primitives`/`modules/client` 等）别名到源码（`vite.config.ts:138-149`），插件包**绝不**打进 shell bundle——它们运行时经模块系统到达（`vite.config.ts:131-137`）；`node:module` 被 stub（`vite.config.ts:141`）、`process.versions.node` 被 define 成 `'0.0.0'`、`process.execArgv` 成 `[]`、`process.env.CORDIS_SHARED` 成 `undefined`，使 vendored Loader 的内部加载器探测落空（`vite.config.ts:151-159`），为浏览器里注入 client loader 留位。`apps/web` 的 Vite 还**拒绝独立 serve**（`vite.config.ts:7-19`：bare Vite 无法注入 `__DSH_BOOT__`，`pnpm dev` 直接抛错）——shell 不是独立应用，`dsh web` 才是它的运行时。
- 契约类型跨面共享：`apiproxy/api/`（类型 + zod schema，浏览器安全、零 Node 依赖）是 Node 面与浏览器面的共同词汇；`fetch/client.ts` 与 `fetch/handler.ts` 的请求/值 schema 表互为镜像、`RpcMethodMap` 单点键控，任何一侧贴错 schema 都是编译错误（`fetch/handler.ts:74-82` 的 UnaryRoutes 注释："a schema pasted onto the wrong row is a type error, not a runtime surprise"）。
- 构建面还体现在**构建配置本身**：`packages/api/remotes` 有 `tsconfig.host.json` 与 `tsconfig.client.json` 两个 tsconfig 面（`tsdown.config.ts` 按面产出 `lib/` 与 `lib/client/`）；`client/connection` 的 `./api` 与 `./client` 子路径导出是浏览器安全通道，`NEVER import the package root` 是硬纪律（`client/api.ts:1-6`）。monorepo 用 `exports["./client"]` 条件导出把同一源码切到两个构建产物，Node 侧 tsdown 产 `lib/index.js`、浏览器侧 tsdown 产 `lib/client.js`——双面是**构建产物层面**的，不是运行时约定的。
- 双面同构还体现在**失败语义**：Node 面有 `assertEntriesActivated` 全量扫 fiber，浏览器面有 `boot.tsx:216-237` 的 `assertEntriesActive`——同名同义，两侧对"插件树必须全部 ACTIVE 否则响亮失败"的约定一致；两侧都有 fail-loud 的激活审计（host：`app-boot/index.ts:692-725`；client：`boot.tsx:161-208`）。
- **三处 FiberState 镜像**：`app-boot/index.ts:671-673`、`plugin-inventory/src/index.ts:23-30`、`client/web/src/loader-status.ts:21-28` 各自镜像 vendored 的 const enum（const enum 无运行时对象、esbuild 不能跨模块内联），代码互相注释指向对方保持对齐——跨构建面的常量共享靠"镜像 + 编译期类型"而非运行时 import（运行时 import 会拖进不该有的依赖面）。

### 5.2 插件同构：host 插件与 client 插件共享契约

- 一个包可以同时是 host 行与 client 行：`client/modules` 的 Node 半是宿主服务、浏览器半是模块表；`client/connection` 的 Node 半注册 `/api` 路由、浏览器半是 `WebApiClient`；`client/hmr` 双侧同包。`cordis.patch.yml:147-172` 里这些行既是 `dsh.client` 花名册（modules 半扫描进 `__DSH_BOOT__`）又是宿主行——**行级双面**（row-level dual-face）。
- **RPC 契约即类型**：`ctx.remote.<域>` 的方法签名由 host 端 `TypertRemoteService` 装饰器（`@Remote('list')`，`plugin-inventory/src/index.ts:56`）生成，client 端 `…/remote` 贡献装配（`api/remotes/src/client/index.ts:105-122`），payload 词汇两侧共用（`api/remotes/src/client/index.ts:48-88`"this assembly is the one place both planes legitimately meet"）——client 贡献命名自己要发的东西时不用 import 任何 host 包。
- **事件词汇同源**：`host/remote-event` 帧把 host 的 cordis 事件**逐字转发**给浏览器（`events.ts:154`，无投影、无脱敏、无改名），allowlist 由 `API_REMOTE_FORWARDED_EVENTS` 单一控制点拥有（`packages/api/remotes/src/remote-events.ts`），`api/remotes/src/index.ts:33-41` 有编译期形状门（每个名字必须是声明过的事件、不得绑定 Scope、必须单向），浏览器侧 `ctx.remote.$on` 读到的就是宿主声明本身——不扁平化、不重述。

### 5.3 "浏览器是另一个插件消费者"的体现

- **配置即真相**：浏览器里跑什么插件**完全由宿主树的 `dsh.client` 声明决定**，shell 做零组合决策（`boot.tsx:31-34`："Composition lives in the host graph; the shell makes zero composition decisions"；app-shell 是唯一的 shell-own 模块，还是以 graph entry 身份挂载的）；`__DSH_BOOT__` 是宿主 Loader 树的投影，宿主改一行 patch → 浏览器图变。
- **生命周期同构**：浏览器插件是**真正的 Cordis entry**——有 fiber、inject 等待、effect 卸载、HMR 原地换 fiber（`client/hmr/src/client/index.ts:10-14` 直接复用 vendored Loader 的 `_refresh` 纪元级联）；浏览器侧的加载顺序、失败语义、卸载级联与 Node 侧由同一套 Loader 机制给出。
- **信任边界在"谁发起"而非"谁实现"**：`PRIVILEGED_METHODS` 钉死 loopback（`connection/src/index.ts:89-119`）、`trustedHosts` 是 DNS-rebinding 围栏而非认证（`index.ts:74-87`）、`/api` 只收 `application/json` 防跨站写（`fetch/handler.ts:277-286`）——浏览器被当作**不可信但同源**的消费者，能力边界由宿主组合（哪些行挂载、哪些域 expose）与传输围栏（loopback/受信主机/方法钉死）共同给出，而不是由浏览器代码自己声明。
- **传输选择反映角色**：上行稀少（用户操作）用带 rpcId 回声校验的 POST；下行密集（会话事件流）用**每订阅者独立**的下行专用 WebSocket（宿主为每个流重放基线，多标签各自收敛）；HMR 通知是唯一真广播（幂等通知，丢了下次重建再通知）。三个通道对应三种"宿主→浏览器"关系：请求-应答、订阅-推送、广播-通知。
- **同一网关，多载体**：`ctx.apiProxy` 传输无关，浏览器走 `WebApiClient`，Electron 走 IPC 桥（`webserver/index.ts:7-8`），测试走 `InProcessApiClient`（`fetch/client.ts:520-541`）——"browser 是另一个插件消费者"的另一半是"浏览器只是载体之一"。

### 5.4 设计原则清单（从代码里读到的显式原则）

| 原则 | 证据 |
|---|---|
| **组合即配置，双面同树** | `__DSH_BOOT__` 是宿主 Loader 树投影；shell 零组合决策（`boot.tsx:31-34`） |
| **shell 自足** | 内核不 value-import 插件包，加载页必须能独立工作（`boot.tsx:1-9`、`loader-status.ts:7-12`、`AppRoot.tsx:2-10`） |
| **插件 bundle 只注册、物化才跑** | 懒 CJS：副作用全在 factory 闭包（`modules/src/client/manifest.ts:9-26`） |
| **声明即认领** | 槽声明=渲染独占权（`ui-slots/index.ts:145`）；dsh.client 声明=进图 |
| **单席位/单拥有者** | fallback 席位（`webserver/index.ts:125-131`）、root 槽（`runtime/client/slots.ts:26-42`）、渲染器 boot-once（`slots.ts:213-221`） |
| **响亮失败，无静默降级** | 激活审计（host `app-boot/index.ts:692-725` / client `boot.tsx:216-237`）、未知 id 404（`modules/index.ts:440-456`）、require miss 抛错（`system.ts:151-155`） |
| **失败绝不死进程** | 请求异常回 400（`webserver/index.ts:170-180`）、sink 异常隔离（`connection.ts:194-201`）、listener 异常隔离（`modules/index.ts:281-289`） |
| **注册可逆** | 一切经 `ctx.effect`/`register` 返回 disposer；卸载=级联（`slots.ts:119-126`、`profile.ts` 的 watch 语义） |
| **契约即类型** | RpcMethodMap 单点键控两侧（`fetch/handler.ts:83-90`、`fetch/client.ts:172-225`）；SlotMap/LocaleNamespaceMap 声明合并 |
| **wire 单一来源** | `WebBootEntry` 双面同形（`manifest.ts:44-48`）；事件词汇宿主声明直通（`api/remotes/src/index.ts:33-41`） |
| **信任按发起方而非实现方** | PRIVILEGED_METHODS 钉 loopback（`connection/index.ts:89-119`）；trustedHosts 是围栏非认证 |
| **每订阅者独立状态** | mux/host 流每流基线回放（`api-proxy.ts:3366-3469`）；HMR 是唯一广播 |
| **不可变/克隆防混叠** | patch 每次 structuredClone（`profile-boot.ts:240-245`、`app-boot/index.ts:412`） |
| **冗余生命周期真相为零** | plugin-inventory 直接读 loader（`plugin-inventory/index.ts:50-68`）；状态 store 手写避免依赖插件包 |
| **参数归属分层** | launcher 只解析自己的旗标，app 旗标走 `cmdlineArgs` 服务（`boot/cmdline/index.ts`） |

---

## 6. 术语表

- **profile**：`$DSH_HOME/profiles/<name>` 目录——package.json（`dsh.profile.bundles` 有序 bundle 列表 + 依赖）+ `cordis.patch.yml`（用户层）。
- **bundle**：声明 `dsh.bundle.patch` 的 npm 包；其 patch 是树的一个完整层。
- **patch 层**：`cordis-plugin-include` 的 `PatchOptions` 列表（id-targeted config 覆盖 / disable / insert），按序叠加在空根上。
- **host 行 / client 行**：同一 Cordis entry 的 Node 面 / 浏览器面；`dsh.client` 声明的包自动成为 client 行。
- **`__DSH_BOOT__`**：宿主注入 `<head>` 首位的 `WebBootGraph`——浏览器插件图的 wire 单源。
- **`__ModuleLoader__`**：内核安装的 bundle 注册槽（`load({id, factory})`）。
- **`__DSH_MODULES__`**：内核握手槽——模块系统实例先于 cordis 存在，wrapper 插件读它 provide `ctx.modules`。
- **slot / 槽**：`SlotMap` 声明合并出的 UI 座位；`single/list/keyed/chain` × `root/session-maybe/session` 双轴。
- **RPC 四象限**：`ClientRequest/ServerResponse/ServerRequest/ClientResponse` 判别联合（`api/rpc.ts:180`）。
- **mux 流 / host 流**：浏览器订阅的两条事件流——全会话聚合 / 宿主级信息。
- **downlink**：只下行的 WebSocket 事件通道（上行一律 HTTP POST）。
- **rev**：bundle 内容 sha1 前 12 位，作缓存破坏与一致性锚点。
- **fiber**：Cordis 插件实例生命周期单元（PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING）；`inject` 等待决定激活顺序。

---

## 7. 关键文件索引

| 关注点 | 文件:行 |
|---|---|
| CLI 分发 | `apps/cli/src/bin.ts:27-53` |
| CLI 参数语法 | `apps/cli/src/args.ts:112-191` |
| profile 组装/热重载 | `apps/cli/src/profile-boot.ts:142-171, 207-300` |
| boot 核心 | `packages/boot/app-boot/src/index.ts:757-802` |
| include 挂载 | `packages/boot/app-boot/src/index.ts:486-529` |
| 配置 dump | `apps/cli/src/dump-config.ts:30-52`；`packages/boot/app-boot/src/index.ts:379-442` |
| profile 解析 | `packages/boot/app-boot/src/profile.ts:344-403` |
| cmdline 服务 | `packages/boot/cmdline/src/index.ts:68-119` |
| webserver | `packages/host/webserver/src/index.ts:59-264`（match: 242-251） |
| 静态回退 | `packages/host/frontend-static/src/index.ts:56-109` |
| API 网关服务 | `packages/host/apiproxy/src/index.ts:69-126` |
| 事件流实现 | `packages/host/apiproxy/src/api-proxy.ts:3366-3469` |
| fetch 载体（host） | `packages/host/apiproxy/src/fetch/handler.ts:243-319` |
| fetch 载体（client） | `packages/host/apiproxy/src/fetch/client.ts:244-513` |
| 浏览器传输接线 | `packages/client/connection/src/index.ts:130-196` |
| WS 下行 | `packages/client/connection/src/websocket-downlink.ts:51-138` |
| 浏览器连接循环 | `packages/client/connection/src/client/connection.ts:61-202` |
| 客户端模块表 | `packages/client/modules/src/client/system.ts:59-196` |
| 扫描/构图/注入 | `packages/client/modules/src/index.ts:184-459` |
| 引导内核 | `packages/client/web/src/boot.tsx:68-238` |
| 运行时服务 | `packages/client/runtime/src/client/index.ts:188-233` |
| HMR 双侧 | `packages/client/hmr/src/index.ts:57-191`；`src/client/index.ts:98-181` |
| 插槽核心 | `packages/client/ui-slots/src/index.ts:678-1149` |
| 插槽 Service 层 | `packages/client/runtime/src/client/slots.ts:93-471` |
| 布局 | `packages/client/ui-layout/src/client/index.ts:33-155` |
| 典型 UI 插件 | `packages/client/ui-goal/src/client/index.ts:47-99` |
| web bundle patch | `packages/bundle/web-app/cordis.patch.yml:43-275` |
| Remote 装配 | `packages/api/remotes/src/client/index.ts:105-122` |
| 插件清单 | `packages/host/plugin-inventory/src/index.ts:43-70` |

## 8. 参考文档

- `docs/subsystems/web-server.md`（路由/fallback/tap 官方说明）
- `docs/subsystems/client-modules.md`（wire/扫描/注入）
- `docs/web-styling.md`（样式归属：ui-theme 拥有 token、ui-layout 应用、特征包只消费）
- `docs/cordis-primer.md`（Cordis 五概念：service/inject/事件模式/可逆效果/waterfall）
- `packages/boot/app-boot/README.md`（boot 导出与 profile 语义、双锚点解析、watchUserPatches）
- `apps/cli/README.md`（launcher 模式与参数归属）
- `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`（web-server.md 引用的分层说明）
