/**
 * The four SkillHub tool registrations over an already-resolved config. Split
 * from the plugin entry so tests can inject the network dependency without
 * changing the public plugin contract.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clamp, searchSkills } from './api.ts'
import { CATEGORY_KEYS } from './categories.ts'
import { sanitizeSortBy } from './config.ts'
import { installSkill, installedSlugs, listInstalled, uninstallSkill } from './install.ts'
import { skillHubPromptText } from './prompt.ts'
import { renderInstall, renderList, renderSearch, renderUninstall } from './render.ts'
import type { ResolvedConfig } from './types.ts'

/** One scanner verdict in the canonical card value. */
const SECURITY_REPORT_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    statusText: { type: 'string', required: true },
    reportUrl: { type: 'string' },
  },
} as const

/** One projected marketplace card in the canonical `skillhub_search` value. */
const SKILL_CARD_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    slug: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    category: { type: 'string', required: true },
    categoryLabel: { type: 'string', required: true },
    version: { type: 'string', required: true },
    downloads: { type: 'number', required: true },
    stars: { type: 'number', required: true },
    installs: { type: 'number', required: true },
    pageUrl: { type: 'string', required: true },
    owner: { type: 'string' },
    installed: { type: 'boolean' },
    iconUrl: { type: 'string' },
    verified: { type: 'boolean' },
    publisherName: { type: 'string' },
    security: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keen: SECURITY_REPORT_SPEC,
        sanbu: SECURITY_REPORT_SPEC,
      },
    },
  },
} as const

/**
 * Register the `tool:skillhub` prompt section and the four marketplace tools.
 * The prompt section assembles only for agents whose composition can see the
 * search tool, mirroring the visibility the schemas get.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param cfg - the resolved plugin config.
 */
export function applySkillHubTools(ctx: Context, cfg: ResolvedConfig): void {

  ctx.systemPrompt.section({
    name: 'tool:skillhub',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SKILLHUB'),
    text: ({ scope }) => {
      /* v8 ignore start -- the section and its tool register and dispose together, so no assembly sees one without the other. */
      if (ctx.tools.get('skillhub_search', scope) === undefined) {
        return ''
      }
      /* v8 ignore stop */
      return skillHubPromptText(cfg.maxResults)
    },
  })

  ctx.tools.register(defineTool({
    name: 'skillhub_search',
    description: 'Search or browse SkillHub, the skill marketplace, and show clickable skill cards. ALWAYS call this instead of web_search, skill-catalog, or shell commands when the user wants to find, recommend, or browse skills. Call EXACTLY ONCE per user message. You extract the search topic: pass a real keyword (PDF, weather), not the user\'s whole sentence. Omit query to browse popular skills. When the user asks for more, reuse the previous query and pass offset = the number of cards already shown. After cards appear, reply with AT MOST one short sentence.',
    parameters: {
      query: { type: 'string', description: 'Main keyword, e.g. PDF or weather. Optional when category is set or when browsing.' },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extra keywords/synonyms for this SAME call. Merged into one card group. Do not make extra skillhub_search calls.',
      },
      category: {
        type: 'string',
        description: `Optional first-level category: ${CATEGORY_KEYS.join(', ')}`,
      },
      sortBy: { type: 'string', description: 'score, downloads, stars, installs, updated_at. Default score.' },
      limit: { type: 'number', description: `Cards in this batch (1-80). Default ${cfg.maxResults}.` },
      offset: { type: 'number', description: 'Skip this many already-shown cards when the user wants more.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          queries: { type: 'array', items: { type: 'string' } },
          category: { type: 'string' },
          sortBy: { type: 'string', required: true, enum: ['score', 'downloads', 'stars', 'installs', 'updated_at'] },
          items: { type: 'array', required: true, items: SKILL_CARD_SPEC },
          total: { type: 'number', required: true },
          offset: { type: 'number', required: true },
          hasMore: { type: 'boolean', required: true },
          fallback: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    timeoutMs: cfg.timeoutMs + 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = (args.query ?? '').trim()
      const installed = await installedSlugs(cfg.skillsDir)
      const explicit = Number(args.limit)
      const limit = Number.isFinite(explicit) && explicit > 0 ? clamp(explicit, 1, 80) : cfg.maxResults
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      const sortBy = sanitizeSortBy(args.sortBy, query ? cfg.sortBy : 'downloads')
      return searchSkills(query, {
        cfg,
        queries: args.queries,
        category: args.category,
        sortBy,
        limit,
        offset,
        installed,
        signal: exec.signal,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: `SkillHub search: ${args.query || args.category || 'browse'}`,
      kind: 'search',
    }),
    presentResult: (_args, { isError }) => ({
      card: 'generic',
      title: isError ? 'SkillHub search failed' : 'SkillHub search',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_install',
    description: 'Install a SkillHub skill into the configured skills directory after the user chooses one. Pass the slug from skillhub_search. Do not print CLI commands. After success, say the skill is installed and discoverable by new conversations.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Skill slug from search, e.g. pdf-ocr-md' },
      version: { type: 'string', description: 'Optional exact version such as 1.0.0. Default is latest.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string', required: true },
          name: { type: 'string', required: true },
          version: { type: 'string', required: true },
          path: { type: 'string', required: true },
          files: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderInstall(value) }],
    },
    timeoutMs: cfg.timeoutMs + 15_000,
    async execute(args, exec) {
      return installSkill(args.slug, cfg, exec.signal, args.version)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Install skill: ${args.slug}`,
    }),
    presentResult: (_args, { isError }) => ({
      card: 'generic',
      title: isError ? 'Install failed' : 'Skill installed',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_list',
    description: 'List skills already installed in the SkillHub skills directory. Use when the user asks what skills are installed or to manage local skills.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skillsDir: { type: 'string', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                version: { type: 'string' },
                path: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderList(value) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const items = await listInstalled(cfg.skillsDir)
      return { skillsDir: cfg.skillsDir, items }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Installed skills',
      kind: 'search',
    }),
    presentResult: (_args, { isError }) => ({
      card: 'generic',
      title: isError ? 'List failed' : 'Installed skills',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_uninstall',
    description: 'Uninstall a locally installed skill by slug. Only removes a directory under the configured skills directory that contains SKILL.md.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Installed skill directory name / slug' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderUninstall(value) }],
    },
    async execute(args) {
      return uninstallSkill(args.slug, cfg.skillsDir)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Uninstall skill: ${args.slug}`,
    }),
    presentResult: (_args, { isError }) => ({
      card: 'generic',
      title: isError ? 'Uninstall failed' : 'Skill uninstalled',
    }),
  }))
}
