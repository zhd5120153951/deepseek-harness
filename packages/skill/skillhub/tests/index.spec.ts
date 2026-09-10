import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DEFAULT_MAX_RESULTS, Config, apply, name, resolveConfig } from '../src/index.ts'
import type { SkillHubListResponse } from '../src/types.ts'
import { makeDescriptorZip } from './helpers/zip.ts'
import * as SkillHub from '@deepseek-ai/dsh-skillhub'

const FIXTURE: SkillHubListResponse = {
  code: 0,
  data: {
    skills: [{
      slug: 'pdf-ocr-md',
      name: 'PDF OCR',
      description: 'OCR PDFs',
      category: 'dev-programming',
      downloads: 12,
      version: '1.0.0',
    }],
    total: 1,
  },
}

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skillhub-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

/** Boot the prompt and tool services, then mount the real plugin over the temp skills directory. */
async function setup(skillsDir: string, config: SkillHub.Config = {}): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const bootConfig = Object.assign({ apiBase: 'https://api.skillhub.test', skillsDir }, config)
  const fiber = await ctx.plugin(SkillHub, bootConfig)
  return { ctx, fiber }
}

/** Stub global fetch to serve the fixture envelope and record request URLs. */
function stubFixtureFetch(): { seen: string[] } {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    seen.push(String(url))
    return Response.json(FIXTURE)
  }))
  return { seen }
}

async function execute(ctx: Context, tool: string, args: unknown): Promise<{ isError: boolean; value: unknown; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`${tool}-call`),
    name: tool,
    arguments: args,
  })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  return { isError: result.isError, value: result.value, text }
}

function toolDefinition(ctx: Context, tool: string): ToolDefinition {
  const definition = ctx.tools.get(tool)
  if (definition === undefined) throw new Error(`expected ${tool} to be registered`)
  return definition
}

describe('resolveConfig', () => {
  const ORIGINAL_DSH_HOME = process.env.DSH_HOME

  afterEach(() => {
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME
  })

  it('fills every default, including the skill-filesystem user root', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(resolveConfig({})).toEqual({
      apiBase: 'https://api.skillhub.cn',
      webBase: 'https://skillhub.cn',
      skillsDir: join('/tmp/dsh-home', 'skills'),
      timeoutMs: 20_000,
      maxResults: 12,
      sortBy: 'score',
      userAgent: 'Mozilla/5.0 (compatible; skillhub/0.1)',
    })
  })

  it('strips every trailing endpoint slash and keeps an explicit skills directory', () => {
    const resolved = resolveConfig({ apiBase: 'http://api.local:8080/', webBase: 'https://skillhub.test//' })
    expect(resolved.apiBase).toBe('http://api.local:8080')
    expect(resolved.webBase).toBe('https://skillhub.test')
    expect(resolveConfig({ skillsDir: ' /tmp/skills ' }).skillsDir).toBe('/tmp/skills')
  })

  it('keeps a non-empty trimmed user agent', () => {
    expect(resolveConfig({ userAgent: '  custom-agent  ' }).userAgent).toBe('custom-agent')
  })

  it('rejects endpoints that are not absolute http(s) URLs', () => {
    expect(() => resolveConfig({ apiBase: 'not-a-url' })).toThrow('apiBase must be an absolute http(s) URL')
    expect(() => resolveConfig({ apiBase: 'ftp://api.example' })).toThrow('apiBase must be an absolute http(s) URL')
    expect(() => resolveConfig({ webBase: 'nope' })).toThrow('webBase must be an absolute http(s) URL')
  })
})

describe('Config schema', () => {
  it('applies the documented defaults', () => {
    const config = Config({}) as Record<string, unknown>
    expect(config.apiBase).toBe('https://api.skillhub.cn')
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS)
    expect(config.sortBy).toBe('score')
  })

  it('rejects out-of-range bounds loudly', () => {
    expect(() => Config({ maxResults: 0 })).toThrow()
    expect(() => Config({ maxResults: 81 })).toThrow()
    expect(() => Config({ timeoutMs: 2000 })).toThrow()
    expect(() => Config({ timeoutMs: 200_000 })).toThrow()
    expect(() => Config({ sortBy: 'bogus' as never })).toThrow()
  })
})

describe('skillhub plugin', () => {
  it('registers the four tools with the documented names and budgets', async () => {
    const { ctx } = await setup(await tempDir('register'))
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'skillhub_install', 'skillhub_list', 'skillhub_search', 'skillhub_uninstall',
    ])
    expect(toolDefinition(ctx, 'skillhub_search').timeoutMs).toBe(25_000)
    expect(toolDefinition(ctx, 'skillhub_install').timeoutMs).toBe(35_000)
  })

  it('guides the model through the tool:skillhub prompt section', async () => {
    const { ctx } = await setup(await tempDir('prompt'))
    const rendered = renderPrompt(await ctx.systemPrompt.assemble({}))
    expect(rendered).toContain('you MUST call skillhub_search')
    expect(rendered).toContain('skillhub_install with that slug')
    expect(rendered).toContain('Category filters: ')
  })

  it('searches over the configured API and reports the page', async () => {
    const { ctx } = await setup(await tempDir('search'))
    const { seen } = stubFixtureFetch()
    const result = await execute(ctx, 'skillhub_search', { query: 'pdf' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ query: 'pdf', total: 1, hasMore: false })
    expect(result.text).toContain('Cards shown for 1 skills')
    expect(result.text).toContain('Everything has been listed.')
    expect(seen[0]).toContain('https://api.skillhub.test/api/skills?keyword=pdf')
  })

  it('normalizes limit, offset, and sort arguments', async () => {
    const { ctx } = await setup(await tempDir('search-args'))
    const { seen } = stubFixtureFetch()
    const over = await execute(ctx, 'skillhub_search', { query: 'pdf', limit: 1000, offset: -5 })
    expect(over.isError).toBe(false)
    const under = await execute(ctx, 'skillhub_search', { query: 'pdf', limit: 0, sortBy: 'bogus' })
    expect(under.isError).toBe(false)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('pageSize=80')
    expect(seen[1]).toContain('pageSize=12')
    expect(seen[1]).toContain('sortBy=score')
  })

  it('marks already-installed slugs in the search result', async () => {
    const skillsDir = await tempDir('search-installed')
    await mkdir(join(skillsDir, 'pdf-ocr-md'), { recursive: true })
    await writeFile(join(skillsDir, 'pdf-ocr-md', 'SKILL.md'), '---\nname: pdf-ocr-md\ndescription: Installed\n---\nbody')
    const { ctx } = await setup(skillsDir)
    stubFixtureFetch()
    const result = await execute(ctx, 'skillhub_search', { query: 'pdf' })
    expect(result.value).toMatchObject({ items: [{ slug: 'pdf-ocr-md', installed: true }] })
  })

  it('surfaces upstream failures as tool errors', async () => {
    const { ctx } = await setup(await tempDir('search-error'))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const result = await execute(ctx, 'skillhub_search', {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('offline')
  })

  it('installs into the configured skills directory through the tool', async () => {
    const { ctx } = await setup(await tempDir('install'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new Uint8Array(makeDescriptorZip({ 'SKILL.md': '---\nname: installed-skill\ndescription: Installed\nversion: 1.0.0\n---\nbody' })),
      { headers: { 'content-type': 'application/zip' } },
    )))
    const result = await execute(ctx, 'skillhub_install', { slug: 'installed-skill' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ slug: 'installed-skill', name: 'installed-skill', version: '1.0.0', files: 1 })
    expect(result.text).toContain('Installed installed-skill at ')
  })

  it('lists and uninstalls installed skills through the tools', async () => {
    const skillsDir = await tempDir('manage')
    await mkdir(join(skillsDir, 'kept'), { recursive: true })
    await writeFile(join(skillsDir, 'kept', 'SKILL.md'), '---\nname: kept\ndescription: Kept\n---\nbody')
    const { ctx } = await setup(skillsDir)
    const listed = await execute(ctx, 'skillhub_list', {})
    expect(listed.value).toMatchObject({ skillsDir, items: [{ slug: 'kept', name: 'kept' }] })
    expect(listed.text).toContain('1. kept (kept)')
    const removed = await execute(ctx, 'skillhub_uninstall', { slug: 'kept' })
    expect(removed.value).toMatchObject({ slug: 'kept' })
    expect(removed.text).toContain('Uninstalled kept')
    const empty = await execute(ctx, 'skillhub_list', {})
    expect(empty.text).toContain('No skills are installed yet')
  })

  it('reports uninstall refusals as tool errors', async () => {
    const { ctx } = await setup(await tempDir('uninstall-error'))
    const result = await execute(ctx, 'skillhub_uninstall', { slug: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not installed or missing SKILL.md')
  })

  it('renders presenters for call and result views', async () => {
    const { ctx } = await setup(await tempDir('present'))
    const search = toolDefinition(ctx, 'skillhub_search')
    expect(search.presentCall?.({ query: 'pdf' })).toMatchObject({ card: 'generic', title: 'SkillHub search: pdf', kind: 'search' })
    expect(search.presentCall?.({ category: 'ai-agent' })).toMatchObject({ title: 'SkillHub search: ai-agent' })
    expect(search.presentCall?.({})).toMatchObject({ title: 'SkillHub search: browse' })
    expect(search.presentResult?.({}, { content: [], isError: true })).toMatchObject({ title: 'SkillHub search failed' })
    expect(search.presentResult?.({}, { content: [], isError: false })).toMatchObject({ title: 'SkillHub search' })
    const install = toolDefinition(ctx, 'skillhub_install')
    expect(install.presentCall?.({ slug: 'x' })).toMatchObject({ title: 'Install skill: x' })
    expect(install.presentResult?.({ slug: 'x' }, { content: [], isError: false })).toMatchObject({ title: 'Skill installed' })
    expect(install.presentResult?.({ slug: 'x' }, { content: [], isError: true })).toMatchObject({ title: 'Install failed' })
    const list = toolDefinition(ctx, 'skillhub_list')
    expect(list.presentCall?.({})).toMatchObject({ title: 'Installed skills' })
    expect(list.presentResult?.({}, { content: [], isError: false })).toMatchObject({ title: 'Installed skills' })
    expect(list.presentResult?.({}, { content: [], isError: true })).toMatchObject({ title: 'List failed' })
    const uninstall = toolDefinition(ctx, 'skillhub_uninstall')
    expect(uninstall.presentCall?.({ slug: 'x' })).toMatchObject({ title: 'Uninstall skill: x' })
    expect(uninstall.presentResult?.({ slug: 'x' }, { content: [], isError: true })).toMatchObject({ title: 'Uninstall failed' })
    expect(uninstall.presentResult?.({ slug: 'x' }, { content: [], isError: false })).toMatchObject({ title: 'Skill uninstalled' })
  })

  it('marks the read-only tools as concurrency safe', async () => {
    const { ctx } = await setup(await tempDir('concurrency'))
    const signal = new AbortController().signal
    expect(ctx.tools.executionMode({ signal, callId: ToolCallId('search-safe'), name: 'skillhub_search', arguments: { query: 'pdf' } }))
      .toEqual({ kind: 'parallel' })
    expect(ctx.tools.executionMode({ signal, callId: ToolCallId('list-safe'), name: 'skillhub_list', arguments: {} }))
      .toEqual({ kind: 'parallel' })
    expect(ctx.tools.executionMode({ signal, callId: ToolCallId('install-serial'), name: 'skillhub_install', arguments: { slug: 'x' } }))
      .toEqual({ kind: 'exclusive' })
  })

  it('unregisters the tools and prompt guidance when the fiber disposes', async () => {
    const { ctx, fiber } = await setup(await tempDir('dispose'))
    expect(ctx.tools.schemas()).toHaveLength(4)
    expect(renderPrompt(await ctx.systemPrompt.assemble({}))).toContain('skillhub_search')
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    expect(renderPrompt(await ctx.systemPrompt.assemble({}))).not.toContain('skillhub_search')
  })
})

describe('apply entry', () => {
  it('is the function-plugin shape the Loader keeps', () => {
    expect(name).toBe('skillhub')
    expect(typeof apply).toBe('function')
    expect(typeof Config).toBe('function')
  })
})
