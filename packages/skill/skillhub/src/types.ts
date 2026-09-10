/**
 * Wire and result vocabulary for the SkillHub marketplace tools. Types only —
 * no runtime code (packages/AGENTS.md).
 *
 * @module @deepseek-ai/dsh-skillhub/types
 */

/** Sort key accepted by the SkillHub search API and by `skillhub_search`. */
export type SortBy = 'score' | 'downloads' | 'stars' | 'installs' | 'updated_at'

/** Fully resolved plugin configuration after the entry's explicit resolve step. */
export interface ResolvedConfig {
  /** SkillHub API root, without a trailing slash. */
  apiBase: string
  /** SkillHub web root, without a trailing slash. */
  webBase: string
  /** Directory skill installs are written to. */
  skillsDir: string
  /** Cooperative deadline in milliseconds for one upstream request. */
  timeoutMs: number
  /** `user-agent` header sent with every upstream request. */
  userAgent: string
  /** Default batch size for `skillhub_search` cards. */
  maxResults: number
  /** Default sort key for keyword searches. */
  sortBy: SortBy
}

/** Per-request HTTP options resolved from the plugin config. */
export interface FetchOptions {
  /** Cooperative deadline in milliseconds for one upstream request. */
  timeoutMs: number
  /** `user-agent` header sent with every upstream request. */
  userAgent: string
}

/** One scanner's security verdict, as shown on the SkillHub platform. */
export interface SecurityReport {
  /** The scanner verdict as the platform reports it; unknown statuses are dropped before projection. */
  status: string
  /** Scanner-provided human-readable summary, capped at 80 characters. */
  statusText: string
  /** HTTPS report URL on the SkillHub platform, when the scanner published one. */
  reportUrl?: string
}

/** Security verdicts keyed by scanner. Absent scanners are omitted. */
export interface SecurityReports {
  /** Keen scanner report, when published. */
  keen?: SecurityReport
  /** Sanbu scanner report, when published. */
  sanbu?: SecurityReport
}

/** One marketplace skill projected into the model-facing card value. */
export interface SkillCard {
  /** Fully qualified platform id, e.g. `@owner/slug`. */
  id: string
  /** URL-safe skill identifier used by install and uninstall. */
  slug: string
  /** Display name, preferring the localized name the API returns. */
  name: string
  /** Short description, preferring the localized summary. */
  description: string
  /** First-level category key as assigned by the platform. */
  category: string
  /** Localized category label; unknown keys fall through unchanged. */
  categoryLabel: string
  /** Latest published version, empty when the API omits one. */
  version: string
  /** Total download count reported by the platform. */
  downloads: number
  /** Total star count reported by the platform. */
  stars: number
  /** Total install count reported by the platform. */
  installs: number
  /** Platform page URL for the skill. */
  pageUrl: string
  /** Owner handle, when the API exposes one. */
  owner?: string
  /** True when a skill with the same slug already exists in the skills directory. */
  installed?: boolean
  /** Icon URL, when the platform publishes one. */
  iconUrl?: string
  /** True when the publisher holds platform verification. */
  verified?: boolean
  /** Verified publisher display name; present only with `verified`. */
  publisherName?: string
  /** Scanner verdicts, when the platform published any. */
  security?: SecurityReports
}

/** Canonical value returned by one `skillhub_search` call. */
export interface SearchResult {
  /** The primary keyword this result answered; empty when browsing. */
  query: string
  /** Every keyword merged into this result, when more than one was accepted. */
  queries?: string[]
  /** Category filter applied to the search, when any. */
  category?: string
  /** Sort key the search ran with. */
  sortBy: SortBy
  /** One page of projected skill cards. */
  items: SkillCard[]
  /** The platform's total match count for the search. */
  total: number
  /** The offset this page starts at. */
  offset: number
  /** True when another page exists beyond `offset + items.length`. */
  hasMore: boolean
  /** True when the keyword search found nothing and popular skills were returned instead. */
  fallback?: boolean
}

/** Metadata of one skill directory under the configured skills directory. */
export interface InstalledSkill {
  /** Directory name; also the install/uninstall slug. */
  slug: string
  /** Frontmatter name, falling back to the directory name. */
  name: string
  /** Frontmatter description, empty when absent. */
  description: string
  /** Frontmatter version, when present. */
  version?: string
  /** Absolute path of the installed skill directory. */
  path: string
}

/** Canonical value returned by one `skillhub_install` call. */
export interface InstallResult {
  /** The installed skill slug. */
  slug: string
  /** Frontmatter name of the installed skill. */
  name: string
  /** Frontmatter version, or the requested version when the frontmatter omits one. */
  version: string
  /** Absolute path of the installed skill directory. */
  path: string
  /** Number of files written, excluding directories. */
  files: number
}

/** One skill entry in the platform's search response. */
export interface SkillHubSkillRaw {
  slug?: string
  name?: string
  displayName?: string
  description?: string
  description_zh?: string
  summary?: string
  summary_zh?: string
  category?: string
  downloads?: number
  stars?: number
  installs?: number
  stats?: {
    downloads?: number
    stars?: number
    installs?: number
  }
  version?: string
  iconUrl?: string | null
  ownerName?: string
  publisher?: {
    name?: string
    verified?: boolean
  }
  namespace?: {
    canonicalName?: string
    handle?: string
    publicSlug?: string
  }
  securityReports?: {
    keen?: { status?: string; statusText?: string; reportUrl?: string }
    sanbu?: { status?: string; statusText?: string; reportUrl?: string }
  }
}

/** Envelope of the platform's paginated skill-list response. */
export interface SkillHubListResponse {
  code: number
  message?: string
  data?: {
    skills?: SkillHubSkillRaw[]
    total?: number
  }
}
