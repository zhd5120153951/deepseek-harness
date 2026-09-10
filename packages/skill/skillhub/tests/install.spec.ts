import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installSkill,
  installedSlugs,
  listInstalled,
  normalizeZipFiles,
  parseFrontmatter,
  parseVersion,
  safeRelPath,
  skillDir,
  uninstallSkill,
} from '../src/install.ts'
import { unzipToFiles } from '../src/unzip.ts'
import { makeDescriptorZip, makeStoredZip } from './helpers/zip.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skillhub-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** Serve one zip body from the stubbed global fetch. */
function stubZipFetch(zip: Buffer, contentType = 'application/zip'): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip), { headers: { 'content-type': contentType } })))
}

describe('safeRelPath', () => {
  it('normalizes separators and rejects escapes', () => {
    expect(safeRelPath('a/b.md')).toBe('a/b.md')
    expect(safeRelPath('a\\b.md')).toBe('a/b.md')
    expect(() => safeRelPath('')).toThrow('empty archive path')
    expect(() => safeRelPath('/abs')).toThrow('unsafe archive path')
    expect(() => safeRelPath('../up')).toThrow('unsafe archive path')
    expect(() => safeRelPath('a/../../up')).toThrow('unsafe archive path')
    expect(() => safeRelPath('a//b')).toThrow('unsafe archive path')
    expect(() => safeRelPath('./a')).toThrow('unsafe archive path')
    expect(() => safeRelPath('a/./b')).toThrow('unsafe archive path')
  })
})

describe('skillDir', () => {
  it('resolves inside the skills root and rejects traversal slugs', () => {
    expect(skillDir('/tmp/skills', 'pdf-ocr-md')).toMatch(/pdf-ocr-md$/)
    expect(() => skillDir('/tmp/skills', '..')).toThrow('invalid skill slug')
  })
})

describe('parseVersion', () => {
  it('strips a leading v and validates the grammar', () => {
    expect(parseVersion('v1.2.0')).toBe('1.2.0')
    expect(parseVersion(' 1.0 ')).toBe('1.0')
    expect(parseVersion(undefined)).toBe('')
    expect(parseVersion('')).toBe('')
    expect(() => parseVersion('1..2//x')).toThrow('invalid version')
  })
})

describe('normalizeZipFiles', () => {
  it('strips one common top-level directory and drops directory entries', () => {
    const files = unzipToFiles(makeStoredZip({ 'wrap/SKILL.md': 'body', 'wrap/refs/a.md': 'a', 'wrap/refs/': '' }))
    const normalized = normalizeZipFiles(files)
    expect(Object.keys(normalized).sort()).toEqual(['SKILL.md', 'refs/a.md'])
  })

  it('ignores a key equal to the common prefix itself', () => {
    const files = normalizeZipFiles({ 'wrap/': Buffer.from('x'), 'wrap/a.md': Buffer.from('a') })
    expect(files).toEqual({ 'a.md': Buffer.from('a') })
  })

  it('keeps paths when the archive has no common top directory', () => {
    const files = unzipToFiles(makeStoredZip({ 'SKILL.md': 'body', 'refs/a.md': 'a' }))
    expect(Object.keys(normalizeZipFiles(files)).sort()).toEqual(['SKILL.md', 'refs/a.md'])
  })

  it('rejects mixed top-level directories instead of stripping one', () => {
    const normalized = normalizeZipFiles({ 'docs/a.md': Buffer.from('a'), 'x.txt': Buffer.from('b') })
    expect(Object.keys(normalized).sort()).toEqual(['docs/a.md', 'x.txt'])
  })

  it('ignores dotted top directories and the empty map', () => {
    const dotted = normalizeZipFiles({ '.git/config': Buffer.from('x'), 'SKILL.md': Buffer.from('b') })
    expect(Object.keys(dotted).sort()).toEqual(['.git/config', 'SKILL.md'])
    expect(normalizeZipFiles({})).toEqual({})
  })
})

describe('parseFrontmatter', () => {
  it('reads the install-relevant scalar fields', () => {
    const meta = parseFrontmatter('---\nname: weather-report\ndescription: "Daily weather"\nversion: 1.0.2\n---\n\nbody')
    expect(meta).toEqual({ name: 'weather-report', description: 'Daily weather', version: '1.0.2' })
  })

  it('reads block scalars: literal keeps newlines, folded joins lines', () => {
    const literal = parseFrontmatter('---\ndescription: |\n  first\n  second\n---\nbody')
    expect(literal.description).toBe('first\nsecond')
    const folded = parseFrontmatter('---\ndescription: >\n  first\n  second\n---\nbody')
    expect(folded.description).toBe('first second')
  })

  it('stops a block at a non-indented field and drops trailing blank lines', () => {
    const stopped = parseFrontmatter('---\ndescription: |\n  first\nversion: 2\n---\nbody')
    expect(stopped).toEqual({ description: 'first', version: '2' })
    const trimmed = parseFrontmatter('---\ndescription: |\n  first\n\n---\nbody')
    expect(trimmed.description).toBe('first')
  })

  it('folds blank lines into paragraph breaks and ignores blank-only blocks', () => {
    const paragraphs = parseFrontmatter('---\ndescription: >\n  first\n\n  second\n---\nbody')
    expect(paragraphs.description).toBe('first\nsecond')
    const blank = parseFrontmatter('---\ndescription: >\n\n\n---\nbody')
    expect(blank.description).toBeUndefined()
  })

  it('skips empty quoted values but keeps siblings', () => {
    const meta = parseFrontmatter('---\nname: ""\nversion: 1\n---\nbody')
    expect(meta).toEqual({ version: '1' })
  })

  it('unquotes single-quoted scalars', () => {
    const meta = parseFrontmatter("---\ndescription: 'Daily weather'\n---\nbody")
    expect(meta.description).toBe('Daily weather')
  })

  it('treats a blank line inside a folded block as a paragraph break even when it opens the block', () => {
    const meta = parseFrontmatter('---\ndescription: >\n\n  second\n---\nbody')
    expect(meta.description).toBe('second')
  })

  it('ignores other fields, CRLF delimiters, and texts without frontmatter', () => {
    expect(parseFrontmatter('---\r\nname: a\r\ndisable-model-invocation: true\r\n---\r\nbody')).toEqual({ name: 'a' })
    expect(parseFrontmatter('no frontmatter here')).toEqual({})
    expect(parseFrontmatter('---\nunknown: x\n---\nbody')).toEqual({})
  })
})

describe('installSkill', () => {
  it('downloads, stages, and publishes the skill directory', async () => {
    const skillsDir = await tempDir('install')
    const zip = makeDescriptorZip({
      'SKILL.md': '---\nname: weather-report\ndescription: Weather\nversion: 1.0.0\n---\nbody',
      'refs/template.md': 'tpl',
    })
    stubZipFetch(zip)
    const result = await installSkill('weather-report', { ...SKILLS_DIR_CFG(skillsDir) })
    expect(result).toMatchObject({ slug: 'weather-report', name: 'weather-report', version: '1.0.0', files: 2 })
    expect(result.path.startsWith(skillsDir)).toBe(true)
    expect(await readFile(join(result.path, 'SKILL.md'), 'utf8')).toContain('name: weather-report')
    expect(await stat(join(result.path, '.tmp-weather-report-')).then(() => true, () => false)).toBe(false)
  })

  it('reports the requested version when the frontmatter omits one', async () => {
    const skillsDir = await tempDir('install-version')
    const zip = makeDescriptorZip({ 'SKILL.md': '---\ndescription: Bare\n---\nbody' })
    stubZipFetch(zip)
    const result = await installSkill('bare', { ...SKILLS_DIR_CFG(skillsDir) }, undefined, 'v2.1')
    expect(result.name).toBe('bare')
    expect(result.version).toBe('2.1')
  })

  it('rejects a package without SKILL.md', async () => {
    const skillsDir = await tempDir('install-noskill')
    const zip = makeDescriptorZip({ 'README.md': 'no skill here' })
    stubZipFetch(zip)
    await expect(installSkill('noskill', { ...SKILLS_DIR_CFG(skillsDir) }))
      .rejects.toThrow('skill noskill has no SKILL.md')
  })

  it('rejects a download that is not a zip archive', async () => {
    const skillsDir = await tempDir('install-notzip')
    stubZipFetch(Buffer.from('<html>'), 'text/html')
    await expect(installSkill('x', { ...SKILLS_DIR_CFG(skillsDir) }))
      .rejects.toThrow('not a zip archive')
  })

  it('accepts a zip body even under a foreign content type', async () => {
    const skillsDir = await tempDir('install-magic')
    const zip = makeDescriptorZip({ 'SKILL.md': '---\nname: magic\n---\nbody' })
    stubZipFetch(zip, 'application/binary')
    const result = await installSkill('magic', { ...SKILLS_DIR_CFG(skillsDir) })
    expect(result.slug).toBe('magic')
  })

  it('cleans up staging and rethrows when writing fails', async () => {
    const skillsDir = await tempDir('install-fail')
    const zip = makeDescriptorZip({ 'SKILL.md': 'body', 'a': 'file', 'a/b': 'nested' })
    stubZipFetch(zip)
    await expect(installSkill('conflict', { ...SKILLS_DIR_CFG(skillsDir) }))
      .rejects.toThrow()
    const leftovers = (await mkdirOrEmpty(skillsDir)).filter(name => name.startsWith('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('propagates an invalid version request', async () => {
    const skillsDir = await tempDir('install-badver')
    stubZipFetch(Buffer.alloc(0))
    await expect(installSkill('x', { ...SKILLS_DIR_CFG(skillsDir) }, undefined, 'not//a/version'))
      .rejects.toThrow('invalid version')
  })
})

describe('listInstalled', () => {
  it('lists skill directories with their frontmatter, skipping non-skills', async () => {
    const skillsDir = await tempDir('list')
    await writeSkill(skillsDir, 'b-skill', 'B skill', 'B body', '2.0.0')
    await writeSkill(skillsDir, 'a-skill', 'A skill', 'A body')
    await mkdir(join(skillsDir, 'c-skill'))
    await writeFile(join(skillsDir, 'c-skill', 'SKILL.md'), '---\nversion: 3.0.0\n---\nbody')
    await writeFile(join(skillsDir, 'plain-file'), 'not a directory')
    await mkdir(join(skillsDir, 'no-skill-md'))
    await mkdir(join(skillsDir, '.hidden-skill'))
    await mkdir(join(skillsDir, '.tmp-staging'))
    const items = await listInstalled(skillsDir)
    expect(items.map(it => it.slug)).toEqual(['a-skill', 'b-skill', 'c-skill'])
    expect(items.find(it => it.slug === 'b-skill')).toMatchObject({ name: 'B skill', version: '2.0.0', description: 'B skill' })
    expect(items.find(it => it.slug === 'a-skill')?.version).toBeUndefined()
    expect(items.find(it => it.slug === 'c-skill')).toMatchObject({ name: 'c-skill', description: '', version: '3.0.0' })
  })

  it('lists a missing root as empty', async () => {
    expect(await listInstalled(join(await tempDir('list-missing'), 'nope'))).toEqual([])
  })

  it('feeds installedSlugs', async () => {
    const skillsDir = await tempDir('list-slugs')
    await writeSkill(skillsDir, 'one', 'One', 'One body')
    expect(await installedSlugs(skillsDir)).toEqual(new Set(['one']))
  })
})

describe('uninstallSkill', () => {
  it('removes an installed skill directory', async () => {
    const skillsDir = await tempDir('uninstall')
    await writeSkill(skillsDir, 'gone', 'Gone', 'Gone body')
    const result = await uninstallSkill('gone', skillsDir)
    expect(result.slug).toBe('gone')
    expect(result.path.startsWith(skillsDir)).toBe(true)
    expect(await listInstalled(skillsDir)).toEqual([])
  })

  it('refuses slugs that are not installed skills', async () => {
    const skillsDir = await tempDir('uninstall-missing')
    await expect(uninstallSkill('nope', skillsDir)).rejects.toThrow('not installed or missing SKILL.md')
  })
})

async function writeSkill(root: string, slug: string, name: string, body: string, version?: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = join(root, slug)
  await mkdir(dir, { recursive: true })
  const front = version === undefined
    ? `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`
    : `---\nname: ${name}\ndescription: ${name}\nversion: ${version}\n---\n\n${body}\n`
  await writeFile(join(dir, 'SKILL.md'), front)
}

async function mkdirOrEmpty(root: string): Promise<string[]> {
  try {
    return await import('node:fs/promises').then(fs => fs.readdir(root))
  } catch {
    return []
  }
}

function SKILLS_DIR_CFG(skillsDir: string) {
  return {
    apiBase: 'https://api.skillhub.test',
    webBase: 'https://skillhub.test',
    skillsDir,
    timeoutMs: 5000,
    userAgent: 'test-agent',
    maxResults: 12,
    sortBy: 'score',
  } as const
}
