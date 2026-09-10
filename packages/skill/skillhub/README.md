---
description: "The SkillHub marketplace tools for users and maintainers: how agents search, install, list, and uninstall agent skills, and how installs become visible to the skill catalog."
kind: "package-reference"
---

# @deepseek-ai/dsh-skillhub

English | [中文](README.zh.md)

## Summary

The SkillHub marketplace tools let a model search the SkillHub skill marketplace, install a chosen skill into the directories the `dsh-skill-filesystem` provider discovers, and list or uninstall what is installed. Four model-facing tools (`skillhub_search`, `skillhub_install`, `skillhub_list`, `skillhub_uninstall`) are backed by the SkillHub public HTTP API; installs are staged, validated, and published atomically, and a `tool:skillhub` prompt section routes skill-discovery requests to the search tool.

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

Mount the plugin in any composition that has `ctx.tools` and `ctx.systemPrompt`. Installs target `skillsDir`, which defaults to the user skills root `$DSH_HOME/skills` (typically `~/.dsh/skills`) — the same root `dsh-skill-filesystem` discovers — so an install becomes visible to the skill catalog for new conversations without restarts.

### When to choose it

Use it when agents should obtain skills from the SkillHub marketplace during a conversation. Skip it for closed compositions with a fixed skill set; the plain skill registry with `dsh-skill-filesystem` alone still serves locally installed skills.

### Mount and configure

```yaml
- name: '@deepseek-ai/dsh-skillhub'
  config:
    skillsDir: ~/.dsh/skills
```

| Field | Default | Meaning |
|---|---|---|
| `apiBase` | `https://api.skillhub.cn` | SkillHub API root; absolute http(s) URL |
| `webBase` | `https://skillhub.cn` | SkillHub web root used for skill page URLs |
| `skillsDir` | `$DSH_HOME/skills` | Directory skill installs are written to |
| `timeoutMs` | `20000` | Cooperative deadline (ms) for one upstream request; 3000–120000 |
| `maxResults` | `12` | Cards in one default `skillhub_search` batch; 1–80 |
| `sortBy` | `score` | Default sort key for keyword searches |
| `userAgent` | `Mozilla/5.0 (compatible; skillhub/0.1)` | `user-agent` header sent with upstream requests |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skillhub) is the exhaustive source for every accepted field.

### What the model gets

- **A marketplace search.** `skillhub_search` accepts a keyword, optional synonyms, a category filter, a sort key, and an offset, and returns one page of skill cards with name, slug, description, version, download counts, verification, and security-verdict summaries; an empty keyword browses popular skills, and an exhausted keyword falls back to popular skills flagged `fallback: true`.
- **A validated installer.** `skillhub_install` downloads the skill package, requires a `SKILL.md` at its root, normalizes a single wrapping top-level directory, rejects archive paths that escape the install directory, and publishes through a staging directory so a failed install leaves no partial skill behind.
- **Local inventory.** `skillhub_list` enumerates the installed skills with their frontmatter name, description, and version; `skillhub_uninstall` removes a directory that reads as a skill install and refuses anything else.
- **Routing guidance.** The `tool:skillhub` prompt section tells the model to reach for `skillhub_search` for skill discovery instead of web search or shell commands, to extract a real keyword, and to reply with one short sentence after cards appear.

### Observable success and failures

A successful install returns the slug, name, version, absolute path, and file count. Slug values outside the platform grammar report `invalid skill slug`; packages without a root `SKILL.md` report `skill <slug> has no SKILL.md`; non-zip downloads report `SkillHub download is not a zip archive`; uninstall requests for a directory without `SKILL.md` report `not installed or missing SKILL.md`. Upstream HTTP failures surface as tool errors carrying the status or timeout, and a request deadline produces `timeout <ms> <url>`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the marketplace surface is built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

The package keeps the marketplace protocol (`api.ts`), the package format (`unzip.ts`), and the filesystem lifecycle (`install.ts`) separate from the tool schemas in `index.ts`/`tools.ts`, so the security-relevant rules are unit-testable without the model surface. Installs publish atomically: files are written to a staging directory inside the skills root, then renamed into place, and a failing stage is removed. Slug and archive-path validation happen at the parser boundaries (`parseSlug`, `safeRelPath`), and the resolved install path is re-checked against the skills root as join defense in depth.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, explicit `resolveConfig` step |
| [`src/tools.ts`](src/tools.ts) | The four tool registrations and the `tool:skillhub` prompt section |
| [`src/api.ts`](src/api.ts) | Search API access, card projection, keyword merge, offset paging |
| [`src/categories.ts`](src/categories.ts) | First-level category keys and localized labels |
| [`src/config.ts`](src/config.ts) | Environment-derived default skills directory and the sort-key sanitizer |
| [`src/http.ts`](src/http.ts) | Upstream fetches with per-request deadline and signal bridging |
| [`src/install.ts`](src/install.ts) | Package download, staged install, listing, uninstall, frontmatter fields |
| [`src/unzip.ts`](src/unzip.ts) | In-memory zip extraction over `node:zlib` |
| [`src/prompt.ts`](src/prompt.ts) | The `tool:skillhub` section text |
| [`src/render.ts`](src/render.ts) | Model-facing render text for the four results |
| — | No runtime invariant companion is published; every checked relation (install containment, slug grammar) is enforced and tested inside the modules above. |

### Search behavior

`skillhub_search` pages by translating the model's offset into a platform page plus an in-page skip, so arbitrary offsets work without assuming the upstream page size. Two to four accepted keywords run as parallel platform pages merged by slug, keeping each slug's highest-download projection and ordering by downloads then stars. When a keyword search returns nothing, the result falls back to one popular-skills page and reports `fallback: true` so the renderer can say so.

### Install safety

The download must look like a zip archive (content type or `PK` magic). Extraction reads the central directory when present and sequential local headers otherwise, entirely in memory; the installer requires a root `SKILL.md`, strips one common wrapping directory, validates every member path, and only then stages and renames. Uninstall requires a readable `SKILL.md` inside the target, so removal cannot reach a directory that is not a skill install.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider vocabulary that discovers installed skills.
- [skill-filesystem package](../skill-filesystem/README.md) — the provider whose discovery roots receive these installs.
- [tool-skill package](../tool-skill/README.md) — the session catalog and loader that expose installed skills to the model.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-skillhub) — the exact tool schemas the model receives.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt guidance

#### What the model sees

When `skillhub_search` is visible, the agent receives a `tool:skillhub` prompt section that requires `skillhub_search` for finding, recommending, or browsing skills; forbids printing install or shell commands; pins the keyword-extraction and offset-paging behavior; caps the post-card reply at one short sentence; gates install calls on a user-chosen card; lists the category filters; and routes installed-skill management to `skillhub_list`/`skillhub_uninstall`.

#### Token effect

One fixed section per request where the search tool is visible; the category list adds a small data-dependent tail.

#### KV Cache effect

Prefix-stable while the tool set and `maxResults` are unchanged. Plugin lifecycle changes invalidate reuse from the section.

### Tool schemas

#### What the model sees

The model sees the generated [`skillhub_search`, `skillhub_install`, `skillhub_list`, and `skillhub_uninstall` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-skillhub). Search arguments are all optional (keyword, synonyms, category, sort, limit, offset); install requires a `slug` with an optional `version`; uninstall requires a `slug`; list takes none.

#### Token effect

Four fixed schemas per request where the plugin is mounted.

#### KV Cache effect

Prefix-stable while the tool definitions and visibility are unchanged.

### Tool results

#### What the model sees

A search returns the canonical page (query, sort, items, total, offset, `hasMore`, optional `fallback`) rendered as internal card numbering plus a one-short-sentence reply instruction; the renderer names the exact offset call for "more". An install returns slug, name, version, path, and file count rendered as an install announcement; list returns the directory and skill summaries; uninstall returns the removed slug and path. Failure results carry the thrown message wrapped as `Error: <message>`.

#### Token effect

Search pages and install results are data-dependent tool-result tokens, resent on later steps until compaction.

#### KV Cache effect

Append-only; results follow the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit. They are current package constraints, not a task backlog.

- **No Web panel or custom cards** — the upstream plugin's marketplace panel, detail dialogs, and settings page are not integrated; Web renders these tools as generic cards, and any future panel must route client copy through the locale-owned dictionaries.
- **No DSH-plugin marketplace tools** — the upstream `skillhub_plugin_search`/`skillhub_plugin_install` tools manage Harness plugins through the distribution plane and are out of scope for the skill capability family.
- **Search and install reach the network directly** — the tools call the configured `apiBase` with `fetch` instead of going through a capability seam, so deployments that route all egress through a provider must set `apiBase` accordingly.
- **Installed skills are trusted input** — install validates package shape, not intent; SKILL.md bodies become model-visible instructions exactly like locally authored skills.
- **No signature verification** — scanner verdicts and publisher verification are surfaced as data, but package downloads are not verified against the platform's content signature.
- **Partial frontmatter parsing** — the installer reads only `name`, `description`, and `version` for result metadata; full frontmatter (invocation policy) is parsed by the skill discovery provider at catalog time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
