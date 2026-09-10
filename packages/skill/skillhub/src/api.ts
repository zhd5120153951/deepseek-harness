/**
 * SkillHub search API access: keyword search with offset pagination,
 * multi-keyword merge, and projection of platform entries into the
 * model-facing card vocabulary.
 */

import { categoryLabel, parseCategory } from './categories.ts'
import { sanitizeSortBy } from './config.ts'
import { fetchJson } from './http.ts'
import type {
  FetchOptions,
  ResolvedConfig,
  SkillCard,
  SkillHubListResponse,
  SkillHubSkillRaw,
  SearchResult,
  SecurityReport,
  SecurityReports,
  SortBy,
} from './types.ts'

/**
 * Validate and normalize a skill slug. Accepts the `@owner/slug` and `@slug`
 * display forms and projects both onto the bare slug the install and download
 * endpoints take.
 * @param raw - the model-provided slug.
 * @returns the lowercase bare slug.
 * @throws when the value is empty, names a path, or falls outside the slug grammar.
 */
export function parseSlug(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\\') || trimmed.includes('\0')) throw new Error('invalid skill slug')
  const s = trimmed.replace(/^@/, '')
  const slug = s.includes('/') ? s.split('/').filter(Boolean).pop() || '' : s
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(slug)) throw new Error('invalid skill slug')
  return slug.toLowerCase()
}

/**
 * Project one platform skill entry into the model-facing card. Entries without
 * a slug have no identity and are dropped.
 * @param raw - the platform entry as returned by the search API.
 * @param webBase - the platform web root, for page URLs.
 * @param installed - slugs already present in the skills directory.
 * @returns the card, or `null` when the entry carries no slug.
 */
export function mapSkill(raw: SkillHubSkillRaw, webBase: string, installed?: Set<string>): SkillCard | null {
  const slug = (raw.slug || raw.namespace?.publicSlug || '').trim()
  if (!slug) return null
  const name = (raw.name || slug).trim()
  const description = (raw.description_zh || raw.description || '').trim()
  const category = (raw.category || '').trim()
  const id = raw.namespace?.canonicalName || `@${raw.ownerName || 'skill'}/${slug}`
  const owner = raw.ownerName || raw.namespace?.handle
  const card: SkillCard = {
    id,
    slug,
    name,
    description,
    category,
    categoryLabel: categoryLabel(category),
    version: (raw.version || '').trim(),
    downloads: Number(raw.downloads) || 0,
    stars: Number(raw.stars) || 0,
    installs: Number(raw.installs) || 0,
    pageUrl: `${webBase.replace(/\/$/, '')}/skills/${encodeURIComponent(slug)}`,
    ...(owner !== undefined ? { owner } : {}),
    installed: installed?.has(slug) || false,
  }
  if (raw.iconUrl) card.iconUrl = raw.iconUrl
  const publisher = raw.publisher
  if (publisher?.verified) {
    card.verified = true
    const pubName = (publisher.name || '').trim()
    if (pubName) card.publisherName = pubName
  }
  const security = mapSecurityReports(raw.securityReports)
  if (security) card.security = security
  return card
}

/** Scanner verdicts the platform surfaces to users; others are suppressed. */
const VISIBLE_SECURITY = new Set<string>(['benign', 'scanning', 'suspicious', 'malicious'])

/**
 * Project the platform's scanner verdicts. Report URLs are restricted to
 * https and single-segment paths, because the card value is model-visible
 * untrusted data that must not smuggle non-web schemes.
 * @param raw - the raw `securityReports` value from the API.
 * @returns the projected verdicts, or `undefined` when none are visible.
 */
export function mapSecurityReports(raw: unknown): SecurityReports | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const out: SecurityReports = {}
  const keen = mapSecurityReport(src.keen)
  const sanbu = mapSecurityReport(src.sanbu)
  if (keen) out.keen = keen
  if (sanbu) out.sanbu = sanbu
  return out.keen || out.sanbu ? out : undefined
}

function mapSecurityReport(raw: unknown): SecurityReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { status?: unknown; statusText?: unknown; reportUrl?: unknown }
  const status = (typeof r.status === 'string' ? r.status : '').toLowerCase()
  if (!VISIBLE_SECURITY.has(status)) return undefined
  const report: SecurityReport = {
    status,
    statusText: (typeof r.statusText === 'string' ? r.statusText : '').slice(0, 80),
  }
  const url = typeof r.reportUrl === 'string' ? r.reportUrl : ''
  if (/^https:\/\//i.test(url) && !url.includes('..')) report.reportUrl = url
  return report
}

/**
 * Validate and project one paginated search response.
 * @param body - the decoded response envelope.
 * @param webBase - the platform web root, for page URLs.
 * @param installed - slugs already present in the skills directory.
 * @returns the projected page and the platform total.
 * @throws when the envelope reports a platform error.
 */
export function parseSearchResponse(
  body: SkillHubListResponse,
  webBase: string,
  installed?: Set<string>,
): { items: SkillCard[]; total: number } {
  if (body.code !== 0 || !body.data) throw new Error(body.message || 'SkillHub API error')
  const items: SkillCard[] = []
  for (const raw of body.data.skills || []) {
    const card = mapSkill(raw, webBase, installed)
    if (card) items.push(card)
  }
  return { items, total: Number(body.data.total) || items.length }
}

/**
 * Collect the accepted keywords for one search: the primary query plus the
 * optional synonyms, deduplicated case-insensitively, each at least two
 * characters, capped at four.
 * @param query - the primary keyword.
 * @param extra - the `queries` array or delimited string from the tool arguments.
 * @returns the accepted keywords in first-seen order.
 */
export function collectQueries(query: string, extra?: unknown): string[] {
  const out: string[] = []
  const add = (raw: unknown) => {
    const t = (typeof raw === 'string' ? raw : '').trim()
    if (t.length < 2) return
    if (out.some(x => x.toLowerCase() === t.toLowerCase())) return
    out.push(t)
  }
  add(query)
  if (Array.isArray(extra)) extra.forEach(add)
  else if (typeof extra === 'string') extra.split(/[,，、|]/).forEach(add)
  return out.slice(0, 4)
}

/**
 * Merge per-keyword pages into one deduplicated list, keeping each slug's
 * highest-download projection and ordering by downloads then stars.
 * @param groups - one projected page per keyword.
 * @returns the merged cards.
 */
export function mergeBySlug(groups: SkillCard[][]): SkillCard[] {
  const seen = new Map<string, SkillCard>()
  for (const items of groups) {
    for (const it of items) {
      const prev = seen.get(it.slug)
      if (!prev || it.downloads > prev.downloads) seen.set(it.slug, it)
    }
  }
  return [...seen.values()].sort((a, b) => (b.downloads - a.downloads) || (b.stars - a.stars))
}

/**
 * Translate an offset into a platform page request. The remainder stays a
 * local skip so arbitrary offsets page without assuming the upstream page size.
 * @param offset - items already shown.
 * @param limit - this call's page size.
 * @returns the upstream page, its size, and the in-page skip.
 */
export function pageFromOffset(offset: number, limit: number): { page: number; pageSize: number; skip: number } {
  const pageSize = Math.max(1, Math.min(100, Math.floor(limit) || 12))
  const off = Math.max(0, Math.floor(offset) || 0)
  return {
    page: Math.floor(off / pageSize) + 1,
    pageSize,
    skip: off % pageSize,
  }
}

/**
 * Run one model-facing skill search. Multiple keywords merge into one card
 * group; an empty keyword browses popular skills; a keyword search that finds
 * nothing falls back to popular skills and reports `fallback: true`.
 * @param query - the primary keyword; empty browses popular skills.
 * @param options - resolved config, extra keywords, filters, paging, the
 *   installed-slug set, cancellation, and a test-injectable fetch.
 * @returns the search result for the canonical tool value.
 */
export async function searchSkills(
  query: string,
  options: {
    cfg: ResolvedConfig
    queries?: unknown
    category: string | undefined
    sortBy: SortBy
    limit: number
    offset: number
    installed: Set<string> | undefined
    signal: AbortSignal | undefined
  },
): Promise<SearchResult> {
  const cfg = options.cfg
  const limit = clamp(options.limit, 1, 80)
  const offset = Math.max(0, Math.floor(options.offset || 0))
  const category = parseCategory(options.category)
  const keywords = collectQueries(query, options.queries)
  const browsing = keywords.length === 0
  const sortBy = sanitizeSortBy(options.sortBy, browsing ? 'downloads' : cfg.sortBy)
  const fetchImpl = fetchJson
  const pageOpts = {
    cfg,
    category,
    sortBy,
    installed: options.installed,
    signal: options.signal,
    fetchImpl,
  }

  const single = async (keyword: string, off: number) => {
    const { page, pageSize, skip } = pageFromOffset(off, limit)
    const parsed = await fetchPage(keyword, { ...pageOpts, page, pageSize })
    const items = parsed.items.slice(skip, skip + limit)
    return {
      query: keyword,
      queries: keyword ? [keyword] : [],
      ...(category !== undefined ? { category } : {}),
      sortBy,
      items,
      total: parsed.total,
      offset: off,
      hasMore: off + items.length < parsed.total,
    } satisfies SearchResult
  }

  if (offset > 0 || keywords.length <= 1) {
    const first = await single(keywords[0] || '', offset)
    if (first.items.length) return first
    const popular = await single('', 0)
    return { ...popular, query: keywords[0] || '', fallback: true }
  }

  const pageSize = clamp(Math.max(limit, 12), 1, 40)
  const pages = await Promise.all(keywords.map(keyword => fetchPage(keyword, { ...pageOpts, page: 1, pageSize })))
  const merged = mergeBySlug(pages.map(p => p.items))
  const items = merged.slice(0, limit)
  if (items.length) {
    /* v8 ignore next -- this branch requires keywords.length > 1, so the first keyword always exists. */
    const primary = keywords[0] ?? ''
    return {
      query: primary,
      queries: keywords,
      ...(category !== undefined ? { category } : {}),
      sortBy,
      items,
      total: Math.max(merged.length, ...pages.map(p => p.total)),
      offset: 0,
      hasMore: pages.some(p => p.total > items.length) || merged.length > items.length,
    }
  }
  const popular = await single('', 0)
  /* v8 ignore next -- this fallback only runs for merged searches, whose keyword count is at least two. */
  return { ...popular, query: keywords[0] || '', fallback: true }
}

/** One upstream page request, with already-normalized optional fields. */
interface PageRequest {
  cfg: ResolvedConfig
  category: string | undefined
  sortBy: SortBy
  page: number
  pageSize: number
  installed: Set<string> | undefined
  signal: AbortSignal | undefined
  fetchImpl: typeof fetchJson
}

async function fetchPage(
  keyword: string,
  options: PageRequest,
): Promise<{ items: SkillCard[]; total: number }> {
  const params = new URLSearchParams()
  if (keyword) params.set('keyword', keyword)
  if (options.category) params.set('category', options.category)
  params.set('sortBy', options.sortBy)
  params.set('order', 'desc')
  params.set('page', String(options.page))
  params.set('pageSize', String(options.pageSize))
  const url = `${options.cfg.apiBase.replace(/\/$/, '')}/api/skills?${params.toString()}`
  const body = await options.fetchImpl<SkillHubListResponse>(url, fetchOpts(options.cfg), options.signal)
  return parseSearchResponse(body, options.cfg.webBase, options.installed)
}

/**
 * Per-request HTTP options for the resolved config.
 * @param cfg - the resolved plugin config.
 * @returns the deadline and user-agent pair.
 */
export function fetchOpts(cfg: Pick<ResolvedConfig, 'timeoutMs' | 'userAgent'>): FetchOptions {
  return { timeoutMs: cfg.timeoutMs, userAgent: cfg.userAgent }
}

/**
 * Clamp a number into an inclusive range, flooring non-finite input to `min`.
 * @param n - the value to clamp.
 * @param min - the inclusive lower bound.
 * @param max - the inclusive upper bound.
 * @returns the clamped value.
 */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
