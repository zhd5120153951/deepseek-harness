---
description: "SkillHub 技能市场工具的用户与维护者参考：智能体如何搜索、安装、列出和卸载技能，以及安装结果如何被技能目录发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skillhub

[English](README.md) | 中文

## Summary

SkillHub 市场工具让模型搜索 SkillHub 技能市场、把选中的技能安装到 `dsh-skill-filesystem` 提供方可发现的目录，并列出或卸载已安装技能。四个模型工具（`skillhub_search`、`skillhub_install`、`skillhub_list`、`skillhub_uninstall`）由 SkillHub 公开 HTTP API 支撑；安装经过暂存、校验并原子发布，`tool:skillhub` 提示词段把技能发现类请求路由到搜索工具。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在具备 `ctx.tools` 与 `ctx.systemPrompt` 的任意组合中挂载本插件。安装目标是 `skillsDir`，默认为用户技能根目录 `$DSH_HOME/skills`（通常是 `~/.dsh/skills`）——与 `dsh-skill-filesystem` 发现的根目录一致——因此安装完成后新对话即可在技能目录中看到，无需重启。

### When to choose it

当智能体需要在对话中从 SkillHub 市场获取技能时使用它。技能集合固定的封闭组合可以跳过；仅用技能注册表加 `dsh-skill-filesystem` 仍可服务本地已安装的技能。

### Mount and configure

```yaml
- name: '@deepseek-ai/dsh-skillhub'
  config:
    skillsDir: ~/.dsh/skills
```

| Field | Default | Meaning |
|---|---|---|
| `apiBase` | `https://api.skillhub.cn` | SkillHub API 根地址；绝对 http(s) URL |
| `webBase` | `https://skillhub.cn` | SkillHub Web 根地址，用于技能主页 URL |
| `skillsDir` | `$DSH_HOME/skills` | 技能安装目录 |
| `timeoutMs` | `20000` | 单次上游请求的协作超时（毫秒）；3000–120000 |
| `maxResults` | `12` | 一次 `skillhub_search` 默认返回的卡片数；1–80 |
| `sortBy` | `score` | 关键词搜索的默认排序键 |
| `userAgent` | `Mozilla/5.0 (compatible; skillhub/0.1)` | 上游请求携带的 `user-agent` 头 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-skillhub)是所有可接受字段的穷举来源。

### What the model gets

- **市场搜索。** `skillhub_search` 接受关键词、可选同义词、分类过滤、排序键与 offset，返回一页技能卡片，含名称、slug、描述、版本、下载量、认证与安全判定摘要；空关键词浏览热门技能，关键词无结果时回落到热门技能并标记 `fallback: true`。
- **带校验的安装器。** `skillhub_install` 下载技能包，要求根目录含 `SKILL.md`，归一化单一包裹顶层目录，拒绝逃逸安装目录的压缩包路径，并通过暂存目录发布，失败的安装不会留下半成品技能。
- **本地清单。** `skillhub_list` 按 frontmatter 的名称、描述与版本枚举已安装技能；`skillhub_uninstall` 只移除可识别为技能安装的目录，其余一律拒绝。
- **路由指引。** `tool:skillhub` 提示词段要求模型在技能发现场景调用 `skillhub_search` 而非网络搜索或 shell 命令，自行提取真实关键词，并在卡片出现后只用一句短话回复。

### Observable success and failures

安装成功返回 slug、名称、版本、绝对路径与文件数。超出平台语法的 slug 报告 `invalid skill slug`；缺少根 `SKILL.md` 的包报告 `skill <slug> has no SKILL.md`；非 zip 下载报告 `SkillHub download is not a zip archive`；对不含 `SKILL.md` 的目录发起卸载报告 `not installed or missing SKILL.md`。上游 HTTP 失败以携带状态码或超时信息的工具错误呈现，请求超时表现为 `timeout <ms> <url>`。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

本节说明市场能力的实现方式；可观察行为已在 [Use this package](#use-this-package) 与下方 Model Experience 一节完整覆盖。

### Design concept

包内将市场协议（`api.ts`）、包格式（`unzip.ts`）与文件系统生命周期（`install.ts`）同 `index.ts`/`tools.ts` 中的工具 schema 分离，使安全相关规则无需模型面即可单元测试。安装原子发布：文件先写入技能根目录内的暂存目录，再重命名就位，失败的暂存会被移除。slug 与压缩包路径校验发生在解析边界（`parseSlug`、`safeRelPath`），解析出的安装路径还会对照技能根目录复查，作为路径拼接的纵深防御。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema 与显式 `resolveConfig` 解析步骤 |
| [`src/tools.ts`](src/tools.ts) | 四个工具的注册与 `tool:skillhub` 提示词段 |
| [`src/api.ts`](src/api.ts) | 搜索 API 访问、卡片投影、关键词合并、offset 分页 |
| [`src/categories.ts`](src/categories.ts) | 一级分类键与本地化标签 |
| [`src/config.ts`](src/config.ts) | 环境推导的默认技能目录与排序键净化 |
| [`src/http.ts`](src/http.ts) | 带单请求截止时间与信号桥接的上游 fetch |
| [`src/install.ts`](src/install.ts) | 包下载、暂存安装、枚举、卸载与 frontmatter 字段 |
| [`src/unzip.ts`](src/unzip.ts) | 基于 `node:zlib` 的内存内 zip 解压 |
| [`src/prompt.ts`](src/prompt.ts) | `tool:skillhub` 段文本 |
| [`src/render.ts`](src/render.ts) | 四个结果面向模型的渲染文本 |
| — | 不发布运行时 invariant 伴随物；所有受检关系（安装目录约束、slug 语法）都在上述模块内实施并测试。 |

### Search behavior

`skillhub_search` 把模型的 offset 换算为平台页码加页内 skip，任意 offset 都可分页且不依赖上游页大小。两到四个可接受关键词会并发请求平台并按 slug 合并，保留每个 slug 下载量最高的投影，按下载量再按星数排序。关键词搜索无结果时回落到一个热门技能页并报告 `fallback: true`，渲染文本会据此说明。

### Install safety

下载必须形如 zip 包（依据 content type 或 `PK` 魔数）。解压在内存中完成：有中央目录时读中央目录，否则顺序读本地头；安装器要求根 `SKILL.md`，剥离单一包裹目录，校验每个成员路径，然后才暂存并重命名。卸载要求目标内存在可读的 `SKILL.md`，因此删除不可能触及非技能安装目录。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当包级契约不够时阅读以下页面。

- [Skill subsystem reference](../../../docs/subsystems/skills.zh.md) — 发现已安装技能的注册表与提供方词汇。
- [skill-filesystem package](../skill-filesystem/README.zh.md) — 其发现根目录承接本插件安装结果的提供方。
- [tool-skill package](../tool-skill/README.zh.md) — 把已安装技能暴露给模型的会话目录与加载器。
- [Generated tool catalog](../../../docs/tool-catalog.zh.md#deepseek-aidsh-skillhub) — 模型收到的精确工具 schema。

-----

<a id="model-experience"></a>
## Model Experience

### Prompt guidance

#### What the model sees

当 `skillhub_search` 可见时，智能体收到 `tool:skillhub` 提示词段：查找、推荐或浏览技能必须调用 `skillhub_search`；禁止打印安装或 shell 命令；固定关键词提取与 offset 分页行为；卡片出现后的回复限一句短话；安装调用必须以用户选中的卡片为前提；列出分类过滤项；并把已安装技能的管理路由到 `skillhub_list`/`skillhub_uninstall`。

#### Token effect

搜索工具可见的每个请求有一个固定段；分类清单增加少量数据依赖的尾部。

#### KV Cache effect

在工具集合与 `maxResults` 不变时前缀稳定。插件生命周期变化会使该段的缓存复用失效。

### Tool schemas

#### What the model sees

模型看到生成的 [`skillhub_search`、`skillhub_install`、`skillhub_list` 与 `skillhub_uninstall` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-skillhub)。搜索参数全部可选（关键词、同义词、分类、排序、limit、offset）；install 必填 `slug`、可选 `version`；uninstall 必填 `slug`；list 无参数。

#### Token effect

插件挂载期间每个请求有四个固定 schema。

#### KV Cache effect

工具定义与可见性不变时前缀稳定。

### Tool results

#### What the model sees

搜索返回规范页（query、sort、items、total、offset、`hasMore`、可选 `fallback`），渲染为内部卡片序号加一句短话的回复指令；渲染文本会为「还有吗」指明精确的 offset 调用。安装返回 slug、名称、版本、路径与文件数，渲染为安装完成说明；list 返回目录与技能摘要；uninstall 返回被移除的 slug 与路径。失败结果以 `Error: <message>` 形式携带抛出的消息。

#### Token effect

搜索页与安装结果属于数据依赖的工具结果 token，在压缩前会随后续步骤重发。

#### KV Cache effect

只追加；结果跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本包不适用的场景。它们是当前包约束，不是任务清单。

- **无 Web 面板与自定义卡片** — 上游插件的市场面板、详情弹窗与设置页未集成；Web 端这些工具呈现为通用卡片，未来的面板必须把客户端文案接入 locale-owned 字典。
- **无 DSH 插件市场工具** — 上游的 `skillhub_plugin_search`/`skillhub_plugin_install` 经分发面管理 Harness 插件，超出 skill 能力族的范围。
- **搜索与安装直接访问网络** — 工具用 `fetch` 调用配置的 `apiBase` 而非经过能力接缝；统一管控出口流量的部署需相应设置 `apiBase`。
- **已安装技能是受信输入** — 安装校验包形态而非内容意图；SKILL.md 正文会像本地手写技能一样成为模型可见指令。
- **无签名校验** — 扫描判定与发布者认证仅作为数据呈现，包下载不对照平台内容签名验证。
- **部分 frontmatter 解析** — 安装器只为结果元数据读取 `name`、`description` 与 `version`；完整 frontmatter（调用策略）由技能发现提供方在编目时解析。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
