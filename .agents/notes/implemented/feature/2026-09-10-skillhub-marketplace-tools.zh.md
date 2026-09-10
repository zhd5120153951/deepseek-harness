# Agent Note: SkillHub marketplace tools integration

Status: implemented

## Problem

智能体此前没有第一方途径在对话中获取技能：获得一个新技能意味着离开 harness、在市场网站上找到包、手动下载并解压到技能目录。SkillHub 平台（skillhub.cn）提供公开 HTTP API，并且有两个实现了搜索与安装的开源 DeepSeek Harness 插件——官方的 `Tencent/skillhub` `dsh-plugin/` 与社区的 `cocofhu/skillhub`——但二者都是外部 npm 插件：复制了 harness 自身的插件机制、附带预编译的原生 JS Web 客户端，并遵循其自身约定而非本仓库的约定。

## Decision

官方实现的宿主侧能力现在以第一方 workspace 包交付：`@deepseek-ai/dsh-skillhub`，位于 `packages/skill/skillhub/`，属 skill 能力族。它注册四个模型工具——`skillhub_search`、`skillhub_install`、`skillhub_list`、`skillhub_uninstall`——以及 `tool:skillhub` 提示词段（段序 `TOOL_SKILLHUB`，在 `dsh-system-prompt` 中集中分配）。安装默认写入 `$DSH_HOME/skills`，即 `dsh-skill-filesystem` 发现的用户根目录，因此安装结果无需重启即可进入技能目录。该包为 opt-in：没有任何 shipped bundle 或 preset 挂载它。它随安装闭包发布（`apps/cli` 依赖），因此 profile 可按名称挂载——经 profile 的 `cordis.patch.yml` 插入一行——且该组合的启动冒烟通过。

本次集成是对 `Tencent/skillhub` v0.2.16 `dsh-plugin/` 的适配（保留上游逻辑的文件：`api.ts`、`categories.ts`、`http.ts`、`install.ts`、`unzip.ts`，以及其 `host.ts` 中的工具定义与渲染器），并按仓库约定重做：函数插件导出 + schemastery `Config` 与显式 `resolveConfig` 解析步骤（替代上游的 `skillhub.json` overlay 文件）、英文错误与渲染文本、closed output schema、类型化的 `systemPrompt.section()` 访问、逐文件 100% 测试覆盖，以及双语包文档。

三个上游面被有意排除。Web 客户端（预编译 `client.js` 市场面板、`/skillhub` 本地 HTTP API、自更新与重启机制）以原生 JS 形态无法满足 locale-owned 客户端文案规则，且 Web 端这些工具呈现为通用卡片。`skillhub_plugin_search`/`skillhub_plugin_install` 这两个 DSH 插件市场工具属于插件分发面，不属于 skill 能力族。上游的启动期网络自检被移除；其回归由单元测试固定。

## Verification

包内所有源文件达到逐文件 100% 覆盖：`api.spec.ts`（投影、合并、分页、回落）、`http.spec.ts`（截止时间、中止、基于 stub fetch 的错误映射）、`install.spec.ts`（暂存安装、路径穿越拒绝、frontmatter、清理）、`unzip.spec.ts`（中央目录与本地头布局、损坏样本）、`render.spec.ts`、`config.spec.ts`、`index.spec.ts`（注册、经真实注册表的执行、处置）与 `loader-composition.spec.ts`（经测试专用 cordis.yml 的真实 Loader 启动，包括端点 fail-loud 校验）。插件已进入生成的工具目录与配置目录。

## Alternatives considered

**为什么不选 cocofhu 实现？** 两个代码库本是同一份代码——v0.2.16 的 36 个源文件中 30 个字节级一致，cocofhu 是同一设计的社区分发。Tencent 仓库是平台官方主页：拥有工具依赖的 Open API 文档、官方 Skills、超集的测试套件，并固定了平台端点；cocofhu 的独有差异全部位于此处范围外的 Web 插件市场面。

**为什么不运行时安装上游插件？** `dsh plugin add @tencent/skillhub` 可以把该能力留在仓库之外，但已发布的插件面向外部分发构建（预编译 `lib/` 加 `prepare` 脚本），复制了本 harness 已拥有的 settings 与重启机制，其硬编码的模型可见文案与 Web 客户端绕过了本仓库的文档、i18n 与测试门禁。第一方集成使安全相关的安装规则可在原地审查与测试。

**为什么不立即做完整 Web 面板？** 上游 Web 体验（市场面板、详情弹窗、设置页）是一个大型客户端面，其文案必须通过类型化 locale 字典重建；先交付宿主侧工具即可获得模型可见能力，而不被该移植阻塞；包 README 已在已知限制中记录。

## Consequences

智能体现在可以在对话中搜索、安装、列出和卸载 SkillHub 技能，安装的技能在下一个对话中进入标准技能目录。代价：搜索与安装直接向配置的 `apiBase` 发起网络调用而非经过能力接缝；已安装技能是受信输入，其 SKILL.md 正文会成为模型可见指令；包下载不对照平台内容签名验证；Web 体验是通用卡片而非市场面板。本次集成跟踪一个上游代码库——上游对 API 映射或安装格式的后续变更需要一次有意识的移植，而非自动更新。
