// Proves the plugin loads through the real Loader composition and that its
// config is real configurability: the skills directory written in cordis.yml
// decides where `skillhub_install` publishes and where `skillhub_list` reads,
// without any hand-built ctx wiring.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as SkillHub from '@deepseek-ai/dsh-skillhub'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml under the given root carrying the given skillhub config block.
 * @param root - the temp root holding the test cordis.yml.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(root: string, configLines: readonly string[]): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skillhub'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skillhub', SkillHub],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('skillhub real Loader composition through cordis.yml', () => {
  it('registers the marketplace tools and reads the configured skills directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-skillhub-loader-'))
    const skillsDir = join(root, 'skills')
    await mkdir(join(skillsDir, 'weather-report'), { recursive: true })
    await writeFile(join(skillsDir, 'weather-report', 'SKILL.md'), '---\nname: weather-report\ndescription: Weather reports\nversion: 1.0.0\n---\nbody')

    const ctx = await boot(root, [
      `    skillsDir: ${JSON.stringify(skillsDir).replace(/\\\\/g, '/')}`,
      "    apiBase: 'https://api.skillhub.test'",
    ])
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['skillhub_install', 'skillhub_list', 'skillhub_search', 'skillhub_uninstall'])

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'list' as never,
      name: 'skillhub_list',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    // The config round-trips YAML paths verbatim; only the separators differ on Windows.
    expect(result.value).toMatchObject({ items: [{ slug: 'weather-report', name: 'weather-report' }] })
    expect((result.value as { skillsDir: string }).skillsDir.replaceAll('\\', '/')).toBe(skillsDir.replaceAll('\\', '/'))
    expect(resultText(result)).toContain('1. weather-report (weather-report) v1.0.0')
  }, 30_000)

  it('fails the load loudly when an endpoint is not an http(s) URL', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-skillhub-loader-'))
    await expect(boot(root, ["    apiBase: 'not-a-url'"])).rejects.toThrow('apiBase must be an absolute http(s) URL')
  }, 30_000)
})
