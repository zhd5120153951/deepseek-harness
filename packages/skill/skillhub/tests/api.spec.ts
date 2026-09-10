import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clamp,
  collectQueries,
  fetchOpts,
  mapSecurityReports,
  mapSkill,
  mergeBySlug,
  pageFromOffset,
  parseSearchResponse,
  parseSlug,
  searchSkills,
} from '../src/api.ts'
import type { ResolvedConfig, SkillHubListResponse, SkillHubSkillRaw } from '../src/types.ts'

const CFG: ResolvedConfig = {
  apiBase: 'https://api.skillhub.test',
  webBase: 'https://skillhub.test',
  skillsDir: '/tmp/skills',
  timeoutMs: 5000,
  userAgent: 'test-agent',
  maxResults: 12,
  sortBy: 'score',
}

const SKILL_A: SkillHubSkillRaw = {
  slug: 'pdf-image-text-extractor',
  name: 'PDF Extractor',
  description_zh: '提取 PDF 文字',
  category: 'office-efficiency',
  version: '1.2.0',
  downloads: 1200,
  stars: 40,
  installs: 300,
  iconUrl: 'https://cdn.skillhub.test/a.png',
  ownerName: 'user_a',
  publisher: { name: 'verified-publisher', verified: true },
  namespace: { canonicalName: '@user_a/pdf-image-text-extractor', handle: 'user_a' },
  securityReports: {
    keen: { status: 'benign', statusText: '安全，无风险', reportUrl: 'https://reports.example/a' },
    sanbu: { status: 'queued', statusText: '排队中', reportUrl: 'https://reports.example/queued' },
  },
}

const SKILL_B: SkillHubSkillRaw = {
  slug: 'pdf-ocr-md',
  name: 'PDF OCR',
  description: 'OCR PDFs to markdown',
  category: 'dev-programming',
  downloads: 50,
  stars: 5,
  installs: 9,
}

const FIXTURE: SkillHubListResponse = {
  code: 0,
  data: { skills: [SKILL_A, SKILL_B], total: 2633 },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const SEARCH_OPTS = {
  cfg: CFG,
  category: undefined,
  sortBy: 'score',
  limit: 12,
  offset: 0,
  installed: undefined,
  signal: undefined,
} as const

/** Stub global fetch with a handler receiving the requested URL. */
function stubFetch(handler: (url: string) => Response | Promise<Response>): { seen: string[] } {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    seen.push(String(url))
    return handler(String(url))
  }))
  return { seen }
}

describe('parseSlug', () => {
  it('accepts bare slugs and canonical names', () => {
    expect(parseSlug('@user_290ac21c/find-skill-skillhub')).toBe('find-skill-skillhub')
    expect(parseSlug('pdf-ocr-md')).toBe('pdf-ocr-md')
    expect(parseSlug('PDF-OCR')).toBe('pdf-ocr')
  })

  it('rejects empty, pathy, and null-byte values', () => {
    expect(() => parseSlug('')).toThrow('invalid skill slug')
    expect(() => parseSlug('../etc')).toThrow('invalid skill slug')
    expect(() => parseSlug('a\\b')).toThrow('invalid skill slug')
    expect(() => parseSlug('abc\0')).toThrow('invalid skill slug')
    expect(() => parseSlug('has space')).toThrow('invalid skill slug')
    expect(() => parseSlug('/')).toThrow('invalid skill slug')
  })
})

describe('mapSkill', () => {
  it('projects the search payload into a card', () => {
    const card = mapSkill(SKILL_A, 'https://skillhub.test/')
    expect(card).toEqual({
      id: '@user_a/pdf-image-text-extractor',
      slug: 'pdf-image-text-extractor',
      name: 'PDF Extractor',
      description: '提取 PDF 文字',
      category: 'office-efficiency',
      categoryLabel: '办公效率',
      version: '1.2.0',
      downloads: 1200,
      stars: 40,
      installs: 300,
      pageUrl: 'https://skillhub.test/skills/pdf-image-text-extractor',
      owner: 'user_a',
      installed: false,
      iconUrl: 'https://cdn.skillhub.test/a.png',
      verified: true,
      publisherName: 'verified-publisher',
      security: {
        keen: { status: 'benign', statusText: '安全，无风险', reportUrl: 'https://reports.example/a' },
      },
    })
  })

  it('falls back to the namespace public slug and drops slug-less entries', () => {
    expect(mapSkill({ name: 'x', namespace: { publicSlug: 'fallback-slug' } }, 'https://skillhub.test')?.slug).toBe('fallback-slug')
    expect(mapSkill({ name: 'x' }, 'https://skillhub.test')).toBeNull()
  })

  it('marks verification without always naming the publisher', () => {
    const card = mapSkill({ slug: 'vp', publisher: { verified: true } }, 'https://skillhub.test')
    expect(card?.verified).toBe(true)
    expect(card?.publisherName).toBeUndefined()
  })

  it('uses the plain slug id and omits absent optional fields', () => {
    const card = mapSkill({ slug: 'plain', description: 'd' }, 'https://skillhub.test')
    expect(card?.id).toBe('@skill/plain')
    expect(card?.owner).toBeUndefined()
    expect(card?.verified).toBeUndefined()
    expect(card?.security).toBeUndefined()
    expect(card?.iconUrl).toBeUndefined()
  })
})

describe('mapSecurityReports', () => {
  it('drops non-visible statuses and keeps visible ones', () => {
    const mapped = mapSecurityReports({
      keen: { status: 'benign', statusText: '安全', reportUrl: 'https://reports.example/a' },
      sanbu: { status: 'queued', statusText: '排队中', reportUrl: 'https://reports.example/queued' },
    })
    expect(mapped?.keen?.status).toBe('benign')
    expect(mapped?.sanbu).toBeUndefined()
  })

  it('keeps report URLs only when https and free of traversal', () => {
    const mapped = mapSecurityReports({
      keen: { status: 'malicious', statusText: 'bad', reportUrl: 'https://lab.example/../x' },
      sanbu: { status: 'scanning', statusText: 'scan', reportUrl: 'http://lab.example/r' },
    })
    expect(mapped?.keen?.reportUrl).toBeUndefined()
    expect(mapped?.sanbu?.reportUrl).toBeUndefined()
  })

  it('drops blank scanner payloads and fills absent text', () => {
    expect(mapSecurityReports({ keen: {} })).toBeUndefined()
    const mapped = mapSecurityReports({ keen: { status: 'benign' } })
    expect(mapped?.keen).toEqual({ status: 'benign', statusText: '' })
  })

  it('returns undefined for absent, non-object, and empty reports', () => {
    expect(mapSecurityReports(undefined)).toBeUndefined()
    expect(mapSecurityReports('x')).toBeUndefined()
    expect(mapSecurityReports({})).toBeUndefined()
    expect(mapSecurityReports({ keen: 7, sanbu: null })).toBeUndefined()
  })
})

describe('parseSearchResponse', () => {
  it('maps the list payload and total', () => {
    const parsed = parseSearchResponse(FIXTURE, 'https://skillhub.test', new Set(['pdf-ocr-md']))
    expect(parsed.total).toBe(2633)
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0]?.installed).toBe(false)
    expect(parsed.items[1]?.installed).toBe(true)
    expect(parsed.items[1]?.downloads).toBe(50)
  })

  it('falls back to the item count when the envelope omits a total', () => {
    const parsed = parseSearchResponse({ code: 0, data: { skills: [SKILL_A] } }, 'https://skillhub.test')
    expect(parsed.total).toBe(1)
  })

  it('tolerates an envelope without a skills array', () => {
    const parsed = parseSearchResponse({ code: 0, data: { total: 3 } }, 'https://skillhub.test')
    expect(parsed).toEqual({ items: [], total: 3 })
  })

  it('skips slug-less entries inside the list', () => {
    const parsed = parseSearchResponse({ code: 0, data: { skills: [{ name: 'x' }], total: 1 } }, 'https://skillhub.test')
    expect(parsed.items).toEqual([])
  })

  it('rejects a non-zero envelope code', () => {
    expect(() => parseSearchResponse({ code: 1, message: 'fail' }, 'https://skillhub.test')).toThrow('fail')
    expect(() => parseSearchResponse({ code: 1 }, 'https://skillhub.test')).toThrow('SkillHub API error')
  })
})

describe('collectQueries', () => {
  it('keeps the main keyword and deduplicates case-insensitively', () => {
    expect(collectQueries('PDF', ['pdf', '文档', 'x'])).toEqual(['PDF', '文档'])
    expect(collectQueries('周报', '周报, weekly | 日报')).toEqual(['周报', 'weekly', '日报'])
  })

  it('drops short tokens and caps at four', () => {
    expect(collectQueries('a')).toEqual([])
    expect(collectQueries('主词', ['aa', 'bb', 'cc', 'dd', 'ee'])).toEqual(['主词', 'aa', 'bb', 'cc'])
  })

  it('ignores non-string entries in the extra keywords', () => {
    expect(collectQueries('pdf', [42, null])).toEqual(['pdf'])
  })
})

describe('mergeBySlug', () => {
  it('deduplicates by slug and prefers higher downloads', () => {
    const a = { ...mapSkill(SKILL_A, 'https://skillhub.test')!, name: 'A' }
    const aBetter = { ...mapSkill(SKILL_A, 'https://skillhub.test')!, name: 'B', downloads: 1300 }
    const c = { ...mapSkill(SKILL_B, 'https://skillhub.test')!, downloads: 5, stars: 9 }
    const merged = mergeBySlug([[a, c], [aBetter]])
    expect(merged.map(it => it.slug)).toEqual(['pdf-image-text-extractor', 'pdf-ocr-md'])
    expect(merged[0]?.name).toBe('B')
  })
  it('keeps the first projection when the download count ties', () => {
    const a = { ...mapSkill(SKILL_A, 'https://skillhub.test')!, name: 'A' }
    const aSame = { ...mapSkill(SKILL_A, 'https://skillhub.test')!, name: 'Same' }
    const merged = mergeBySlug([[a], [aSame]])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.name).toBe('A')
  })

  it('breaks download ties by stars', () => {
    const low = { ...mapSkill(SKILL_A, 'https://skillhub.test')!, slug: 'low', id: '@o/low', downloads: 10, stars: 1 }
    const high = { ...mapSkill(SKILL_A, 'https://skillhub.test')!, slug: 'high', id: '@o/high', downloads: 10, stars: 9 }
    const merged = mergeBySlug([[low, high]])
    expect(merged.map(it => it.slug)).toEqual(['high', 'low'])
  })
})

describe('pageFromOffset', () => {
  it('converts an offset into page, page size, and skip', () => {
    expect(pageFromOffset(0, 12)).toEqual({ page: 1, pageSize: 12, skip: 0 })
    expect(pageFromOffset(12, 12)).toEqual({ page: 2, pageSize: 12, skip: 0 })
    expect(pageFromOffset(5, 12)).toEqual({ page: 1, pageSize: 12, skip: 5 })
    expect(pageFromOffset(3, 0)).toEqual({ page: 1, pageSize: 12, skip: 3 })
  })
})

describe('searchSkills', () => {
  it('searches one keyword and reports hasMore', async () => {
    const { seen } = stubFetch(() => Response.json(FIXTURE))
    const result = await searchSkills('pdf', SEARCH_OPTS)
    expect(seen[0]).toContain('https://api.skillhub.test/api/skills?keyword=pdf')
    expect(seen[0]).toContain('sortBy=score')
    expect(seen[0]).toContain('page=1')
    expect(seen[0]).toContain('pageSize=12')
    expect(seen[0]).toContain('order=desc')
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(2633)
    expect(result.hasMore).toBe(true)
    expect(result.query).toBe('pdf')
    expect(result.queries).toEqual(['pdf'])
  })

  it('paginates by slicing the page with the offset remainder', async () => {
    stubFetch(() => Response.json(FIXTURE))
    const result = await searchSkills('pdf', { ...SEARCH_OPTS, limit: 2, offset: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.slug).toBe('pdf-ocr-md')
    expect(result.offset).toBe(1)
  })

  it('merges extra keywords into one deduplicated card group', async () => {
    const extra: SkillHubListResponse = {
      code: 0,
      data: {
        skills: [{
          ...SKILL_A,
          slug: 'weekly-report',
          name: 'Weekly Report',
          downloads: 900,
          namespace: { canonicalName: '@u/weekly-report', handle: 'u' },
        }],
        total: 1,
      },
    }
    const { seen } = stubFetch(url => Response.json(url.includes('keyword=%E5%91%A8%E6%8A%A5') ? extra : FIXTURE))
    const result = await searchSkills('pdf', { ...SEARCH_OPTS, queries: ['周报'] })
    expect(seen).toHaveLength(2)
    expect(result.query).toBe('pdf')
    expect(result.queries).toEqual(['pdf', '周报'])
    expect(result.items.map(it => it.slug).sort()).toEqual(['pdf-image-text-extractor', 'pdf-ocr-md', 'weekly-report'])
  })

  it('falls back to popular skills when the keyword has no hits', async () => {
    const empty: SkillHubListResponse = { code: 0, data: { skills: [], total: 0 } }
    stubFetch(url => Response.json(url.includes('keyword=') ? empty : FIXTURE))
    const result = await searchSkills('no-such-skill', SEARCH_OPTS)
    expect(result.fallback).toBe(true)
    expect(result.query).toBe('no-such-skill')
    expect(result.items).toHaveLength(2)
  })

  it('carries the category filter through the multi-keyword merge', async () => {
    stubFetch(() => Response.json(FIXTURE))
    const result = await searchSkills('pdf', { ...SEARCH_OPTS, queries: ['ocr'], category: 'ai-agent' })
    expect(result.category).toBe('ai-agent')
    expect(result.queries).toEqual(['pdf', 'ocr'])
  })

  it('caps the merged group when the limit truncates it', async () => {
    const small: SkillHubListResponse = { code: 0, data: { skills: [SKILL_A, SKILL_B], total: 1 } }
    stubFetch(() => Response.json(small))
    const result = await searchSkills('pdf', { ...SEARCH_OPTS, queries: ['ocr'], limit: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.hasMore).toBe(true)
  })

  it('falls back to popular skills when every keyword of a merged search has no hits', async () => {
    const empty: SkillHubListResponse = { code: 0, data: { skills: [], total: 0 } }
    stubFetch(url => Response.json(url.includes('keyword=') ? empty : FIXTURE))
    const result = await searchSkills('aa', { ...SEARCH_OPTS, queries: ['bb'] })
    expect(result.fallback).toBe(true)
    expect(result.query).toBe('aa')
    expect(result.items).toHaveLength(2)
  })

  it('reports an empty fallback query when browsing yields nothing either', async () => {
    const empty: SkillHubListResponse = { code: 0, data: { skills: [], total: 0 } }
    stubFetch(() => Response.json(empty))
    const result = await searchSkills('', SEARCH_OPTS)
    expect(result.fallback).toBe(true)
    expect(result.query).toBe('')
    expect(result.items).toEqual([])
  })

  it('propagates the category filter and the browsing sort', async () => {
    const { seen } = stubFetch(() => Response.json(FIXTURE))
    await searchSkills('', { ...SEARCH_OPTS, category: 'ai-agent', sortBy: 'downloads' })
    expect(seen[0]).toContain('category=ai-agent')
    expect(seen[0]).toContain('sortBy=downloads')
  })

  it('rejects a category outside the first-level keys', async () => {
    const { seen } = stubFetch(() => Response.json(FIXTURE))
    await searchSkills('pdf', { ...SEARCH_OPTS, category: 'not-a-category' })
    expect(seen[0]).not.toContain('category=')
  })
})

describe('fetchOpts and clamp', () => {
  it('projects the deadline and user agent', () => {
    expect(fetchOpts(CFG)).toEqual({ timeoutMs: 5000, userAgent: 'test-agent' })
  })

  it('clamps into the inclusive range', () => {
    expect(clamp(5, 1, 3)).toBe(3)
    expect(clamp(0, 1, 3)).toBe(1)
    expect(clamp(2, 1, 3)).toBe(2)
  })
})
