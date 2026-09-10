import { afterEach, describe, expect, it } from 'vitest'
import { CATEGORY_KEYS, categoryLabel, parseCategory } from '../src/categories.ts'
import { defaultSkillsDir, dshHome, sanitizeSortBy } from '../src/config.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'

describe('categories', () => {
  it('labels every first-level key', () => {
    expect(CATEGORY_KEYS).toContain('ai-agent')
    expect(categoryLabel('ai-agent')).toBe('AI Agent')
    expect(categoryLabel('office-efficiency')).toBe('办公效率')
  })

  it('falls through unknown keys and empty values', () => {
    expect(categoryLabel('not-a-key')).toBe('not-a-key')
    expect(categoryLabel(undefined)).toBe('')
    expect(categoryLabel('')).toBe('')
  })

  it('accepts only first-level keys as filters', () => {
    expect(parseCategory('office-efficiency')).toBe('office-efficiency')
    expect(parseCategory('nope')).toBeUndefined()
    expect(parseCategory(undefined)).toBeUndefined()
    expect(parseCategory('  ')).toBeUndefined()
  })
})

describe('config helpers', () => {
  const ORIGINAL_DSH_HOME = process.env.DSH_HOME

  afterEach(() => {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME
  })

  it('resolves the config root from $DSH_HOME or the home fallback', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(dshHome()).toBe('/tmp/dsh-home')
    delete process.env.DSH_HOME
    expect(dshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('puts the default skills directory under the config root', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(defaultSkillsDir()).toBe(join('/tmp/dsh-home', 'skills'))
  })

  it('sanitizes sort keys with a fallback', () => {
    expect(sanitizeSortBy('downloads')).toBe('downloads')
    expect(sanitizeSortBy(' nope ')).toBe('score')
    expect(sanitizeSortBy('nope', 'installs')).toBe('installs')
    expect(sanitizeSortBy(undefined, 'stars')).toBe('stars')
  })
})
