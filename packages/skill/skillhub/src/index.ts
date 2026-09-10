/**
 * Model-facing SkillHub marketplace tools for the DeepSeek Harness: search the
 * skill marketplace, install skills into the directories the skill-filesystem
 * provider discovers, and list or uninstall them. This package owns schemas,
 * validation, prompt guidance, and install safety; the marketplace protocol
 * lives in `api.ts` and the installer in `install.ts`.
 *
 * @module @deepseek-ai/dsh-skillhub
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { applySkillHubTools } from './tools.ts'
import { defaultSkillsDir, sanitizeSortBy } from './config.ts'
import type { ResolvedConfig, SortBy } from './types.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'skillhub'

/** Services required by the SkillHub tool suite. */
export const inject = ['tools', 'systemPrompt']

/** Default SkillHub API root. */
export const DEFAULT_API_BASE = 'https://api.skillhub.cn'

/** Default SkillHub web root, used for skill page URLs. */
export const DEFAULT_WEB_BASE = 'https://skillhub.cn'

/** Default cooperative deadline (ms) for one upstream request. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** Default batch size for one `skillhub_search` call. */
export const DEFAULT_MAX_RESULTS = 12

/** Default `user-agent` header sent with upstream requests. */
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; skillhub/0.1)'

/** Plugin config: marketplace endpoints, install directory, and search bounds. */
export interface Config {
  /** SkillHub API root. Defaults to `https://api.skillhub.cn`. */
  apiBase?: string
  /** SkillHub web root used for page URLs. Defaults to `https://skillhub.cn`. */
  webBase?: string
  /**
   * Directory skill installs are written to. Defaults to `$DSH_HOME/skills`
   * (typically `~/.dsh/skills`), the user root `dsh-skill-filesystem` discovers.
   */
  skillsDir?: string
  /** Cooperative deadline (ms) for one upstream request; 3000–120000. Defaults to 20000. */
  timeoutMs?: number
  /** Cards in one default `skillhub_search` batch; 1–80. Defaults to 12. */
  maxResults?: number
  /** Default sort key for keyword searches. Defaults to `score`. */
  sortBy?: SortBy
  /** `user-agent` header sent with upstream requests. */
  userAgent?: string
}

/** Schemastery configuration for the SkillHub tools. */
export const Config: z<Config> = z.object({
  apiBase: z.string().default(DEFAULT_API_BASE),
  webBase: z.string().default(DEFAULT_WEB_BASE),
  skillsDir: z.string(),
  timeoutMs: z.number().step(1).min(3000).max(120_000).default(DEFAULT_TIMEOUT_MS),
  maxResults: z.number().step(1).min(1).max(80).default(DEFAULT_MAX_RESULTS),
  sortBy: z.union(['score', 'downloads', 'stars', 'installs', 'updated_at'] as const).default('score'),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})

/**
 * Resolve the plugin config into its runtime form: the explicit defaulting and
 * normalization step the tools close over. Endpoint URLs must be absolute
 * http(s) URLs and lose their trailing slash; the skills directory falls back
 * to the user root the skill-filesystem provider discovers.
 * @param config - the schemastery-validated config.
 * @returns the resolved config.
 * @throws when an endpoint is not an absolute http(s) URL.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    apiBase: normalizeEndpoint('apiBase', config.apiBase ?? DEFAULT_API_BASE),
    webBase: normalizeEndpoint('webBase', config.webBase ?? DEFAULT_WEB_BASE),
    skillsDir: config.skillsDir?.trim() || defaultSkillsDir(),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
    sortBy: sanitizeSortBy(config.sortBy, 'score'),
    userAgent: config.userAgent?.trim() || DEFAULT_USER_AGENT,
  }
}

function normalizeEndpoint(name: string, value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`skillhub: ${name} must be an absolute http(s) URL, got ${JSON.stringify(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`skillhub: ${name} must be an absolute http(s) URL, got ${JSON.stringify(value)}`)
  }
  return raw
}

/**
 * Register the SkillHub marketplace tools and their system-prompt guidance.
 * All registrations are effect-scoped and unregister when the plugin fiber
 * disposes. The tools install into `cfg.skillsDir`, which defaults to the
 * user root `dsh-skill-filesystem` discovers, so installs become visible to
 * the skill catalog without restarts.
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations.
 * @param config - the validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  applySkillHubTools(ctx, resolveConfig(config))
}
