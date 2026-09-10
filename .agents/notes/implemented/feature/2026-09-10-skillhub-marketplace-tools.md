# Agent Note: SkillHub marketplace tools integration

Status: implemented

## Problem

Agents had no first-party way to obtain skills during a conversation: acquiring a new skill meant leaving the harness, finding a package on a marketplace website, downloading it, and unzipping it into a skills directory by hand. The SkillHub platform (skillhub.cn) publishes a public HTTP API and two open-source DeepSeek Harness plugins that implement search and install on top of it — the official `Tencent/skillhub` `dsh-plugin/` and the community `cocofhu/skillhub` — but both are external npm plugins that duplicate the harness's own plugin mechanics, ship a prebuilt vanilla-JS web client, and are styled against their own conventions rather than this repository's.

## Decision

The host-side capability of the official implementation now ships as a first-party workspace package: `@deepseek-ai/dsh-skillhub` at `packages/skill/skillhub/`, a member of the skill capability family. It registers four model-facing tools — `skillhub_search`, `skillhub_install`, `skillhub_list`, `skillhub_uninstall` — and the `tool:skillhub` prompt section (section order `TOOL_SKILLHUB`, centrally allocated in `dsh-system-prompt`). Installs default to `$DSH_HOME/skills`, the user root `dsh-skill-filesystem` discovers, so an install reaches the skill catalog without restarts. The package is opt-in: no shipped bundle or preset mounts it. It ships inside the installation closure (`apps/cli` dependencies) so a profile can mount it by name — a row inserted through the profile's `cordis.patch.yml` — and the boot smoke for that composition passes.

The integration is an adaptation of `Tencent/skillhub` v0.2.16 `dsh-plugin/` (the upstream files whose logic was kept: `api.ts`, `categories.ts`, `http.ts`, `install.ts`, `unzip.ts`, plus the tool definitions and renderers from its `host.ts`), reworked to repository conventions: function-plugin exports with a schemastery `Config` and an explicit `resolveConfig` step (replacing the upstream `skillhub.json` overlay file), English error and render text, closed output schemas, typed `systemPrompt.section()` access, full per-file test coverage, and bilingual package documentation.

Three upstream surfaces were deliberately not integrated. The web client (the prebuilt `client.js` marketplace panel, the `/skillhub` local HTTP API, self-update, and restart machinery) cannot satisfy the locale-owned client-copy rule as shipped vanilla JS, and Web renders these tools as generic cards. The `skillhub_plugin_search`/`skillhub_plugin_install` DSH-plugin-marketplace tools belong to the plugin-distribution plane, not the skill capability family. The upstream startup network self-check was dropped; its regression is pinned by unit tests instead.

## Verification

The package carries per-file 100% coverage across its sources: `api.spec.ts` (projection, merge, paging, fallback), `http.spec.ts` (deadline, abort, error mapping over stubbed fetch), `install.spec.ts` (staged install, traversal rejection, frontmatter, cleanup), `unzip.spec.ts` (central-directory and local-header layouts, corruption), `render.spec.ts`, `config.spec.ts`, `index.spec.ts` (registration, execution through the real registry, disposal), and `loader-composition.spec.ts` (real Loader boot through a test-only cordis.yml, including the fail-loud endpoint validation). The plugin enters the generated tool catalog and configuration catalog.

## Alternatives considered

**Why not the cocofhu implementation?** The two codebases are the same code — 30 of 36 source files are byte-identical at v0.2.16, and cocofhu is the community distribution of the same design. The Tencent repository is the platform's official home: it owns the Open API documentation the tools depend on, ships the official skills, carries the superset test suite, and pins the platform endpoint; cocofhu's only deltas sit in the web-plugin-market surfaces that are out of scope here.

**Why not install an upstream plugin at runtime?** `dsh plugin add @tencent/skillhub` would keep the capability out of the repository, but the shipped plugin is built for external distribution (prebuilt `lib/` plus `prepare` scripts), duplicates settings and restart machinery this harness already owns, and its hardcoded model-facing copy and web client bypass this repository's documentation, i18n, and testing gates. First-party integration keeps the security-relevant install rules reviewable and testable in place.

**Why not a full web panel now?** The upstream web experience (marketplace panel, detail dialogs, settings page) is a large client surface whose copy must be rebuilt through typed locale dictionaries; shipping the host-side tools first delivers the model-visible capability without blocking on that port, and the package README records it under known limitations.

## Consequences

Agents can now search, install, list, and uninstall SkillHub skills in-conversation, and installed skills flow into the standard skill catalog on the next conversation. The trade-offs: search and install make direct network calls to the configured `apiBase` rather than going through a capability seam; installed skills are trusted input whose SKILL.md bodies become model-visible instructions; package downloads are not verified against platform content signatures; and the Web experience is generic cards rather than a marketplace panel. The integration tracks an upstream codebase — future upstream changes to the API mapping or install format need a deliberate port, not an automatic update.
