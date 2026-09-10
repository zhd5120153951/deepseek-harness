import { describe, expect, it } from 'vitest'
import { renderInstall, renderList, renderSearch, renderUninstall } from '../src/render.ts'
import type { InstallResult, InstalledSkill, SkillCard, SearchResult } from '../src/types.ts'

function card(slug: string, overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    id: `@owner/${slug}`,
    slug,
    name: slug,
    description: 'desc',
    category: 'ai-agent',
    categoryLabel: 'AI Agent',
    version: '1.0.0',
    downloads: 1,
    stars: 1,
    installs: 1,
    pageUrl: `https://skillhub.test/skills/${slug}`,
    ...overrides,
  }
}

describe('renderSearch', () => {
  it('lists cards with the paging call and reply shape', () => {
    const result: SearchResult = {
      query: 'pdf',
      queries: ['pdf'],
      sortBy: 'score',
      items: [card('pdf-ocr-md', { installed: true }), card('other')],
      total: 5,
      offset: 0,
      hasMore: true,
    }
    const text = renderSearch(result)
    expect(text).toContain('Cards shown for 2 skills')
    expect(text).toContain('1. pdf-ocr-md (installed) · pdf-ocr-md')
    expect(text).toContain('2. other · other')
    expect(text).toContain('query "pdf" and offset=2')
    expect(text).toContain('AT MOST one short sentence')
  })

  it('says the list is complete when nothing remains', () => {
    const result: SearchResult = {
      query: 'pdf',
      sortBy: 'score',
      items: [card('only')],
      total: 1,
      offset: 0,
      hasMore: false,
    }
    expect(renderSearch(result)).toContain('Everything has been listed.')
  })

  it('notes a popular fallback', () => {
    const result: SearchResult = {
      query: 'zzz',
      sortBy: 'downloads',
      items: [card('popular')],
      total: 1,
      offset: 0,
      hasMore: false,
      fallback: true,
    }
    expect(renderSearch(result)).toContain('popular skills')
  })

  it('keeps an empty result to one short reply', () => {
    const result: SearchResult = { query: 'zzz', sortBy: 'score', items: [], total: 0, offset: 0, hasMore: false }
    expect(renderSearch(result)).toContain('No matching skills were found')
  })
})

describe('renderInstall and renderUninstall', () => {
  it('announces the install path and discovery', () => {
    const result: InstallResult = { slug: 'weather', name: 'Weather', version: '1.0.0', path: '/tmp/skills/weather', files: 2 }
    expect(renderInstall(result)).toContain('Installed Weather at /tmp/skills/weather')
    expect(renderInstall(result)).toContain('discover it through the skill catalog')
  })

  it('announces the removal', () => {
    expect(renderUninstall({ slug: 'weather', path: '/tmp/skills/weather' })).toContain('Uninstalled weather')
  })
})

describe('renderList', () => {
  it('lists installed skills with versions', () => {
    const items: InstalledSkill[] = [
      { slug: 'a', name: 'A', description: 'a', path: '/tmp/skills/a' },
      { slug: 'b', name: 'B', description: 'b', version: '2.0.0', path: '/tmp/skills/b' },
    ]
    const text = renderList({ items, skillsDir: '/tmp/skills' })
    expect(text).toContain('2 skills installed (/tmp/skills)')
    expect(text).toContain('1. A (a)')
    expect(text).toContain('2. B (b) v2.0.0')
  })

  it('points at the directory when nothing is installed', () => {
    expect(renderList({ items: [], skillsDir: '/tmp/skills' })).toBe('No skills are installed yet. Directory: /tmp/skills')
  })
})
