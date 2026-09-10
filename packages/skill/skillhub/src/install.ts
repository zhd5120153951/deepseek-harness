/**
 * Skill installation onto the local filesystem: package download, zip
 * extraction, staged atomic publish, and directory listing/removal. Installs
 * target directories the `dsh-skill-filesystem` provider discovers, so a
 * finished install becomes visible to the skill catalog without restarts.
 */

import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fetchOpts, parseSlug } from './api.ts'
import { fetchBytes } from './http.ts'
import { unzipToFiles } from './unzip.ts'
import type { InstalledSkill, InstallResult, ResolvedConfig } from './types.ts'

/**
 * Normalize one archive member path to a slash-separated relative path and
 * reject anything that could escape the install directory.
 * @param raw - the archive member path.
 * @returns the normalized relative path.
 * @throws when the path is empty, absolute, or traverses (`..`, empty or dot segments).
 */
export function safeRelPath(raw: string): string {
  const path = (raw || '').replace(/\\/g, '/')
  if (!path) throw new Error('empty archive path')
  if (path.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`unsafe archive path ${raw}`)
  }
  return path
}

/**
 * Resolve the install directory for one slug inside the skills directory.
 * @param skillsDir - the configured skills directory root.
 * @param slug - the validated skill slug.
 * @returns the absolute target directory.
 * @throws when the resolved target escapes the root.
 */
export function skillDir(skillsDir: string, slug: string): string {
  const root = resolve(skillsDir)
  const target = resolve(root, parseSlug(slug))
  const rel = relative(root, target)
  /* v8 ignore start -- parseSlug's grammar admits no separators or dot segments, so the */
  /* resolved target cannot escape the root; the check stays as join defense in depth. */
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error('rejected path traversal')
  /* v8 ignore stop */
  return target
}

/**
 * Normalize a version string: strips a leading `v` and bounds the length.
 * @param raw - the raw version value.
 * @returns the normalized version, empty when absent.
 * @throws when the value falls outside the version grammar.
 */
export function parseVersion(raw: unknown): string {
  const v = (typeof raw === 'string' ? raw : '').trim().replace(/^v/i, '')
  if (!v) return ''
  if (!/^[0-9a-z][0-9a-z._+-]{0,31}$/i.test(v)) throw new Error('invalid version')
  return v
}

/**
 * Download and install one skill into `cfg.skillsDir`. The package must
 * contain `SKILL.md` at its root; files are written to a staging directory
 * first and renamed into place, so a failed install never leaves a partial
 * skill directory behind.
 * @param slug - the skill slug from search.
 * @param cfg - the resolved plugin config.
 * @param signal - caller cancellation forwarded to the download.
 * @param version - optional exact version; latest when omitted.
 * @returns the install result for the canonical tool value.
 */
export async function installSkill(slug: string, cfg: ResolvedConfig, signal?: AbortSignal, version?: string): Promise<InstallResult> {
  const id = parseSlug(slug)
  const requested = parseVersion(version)
  const files = await downloadSkillFiles(id, cfg, signal, requested)
  if (!files['SKILL.md']) throw new Error(`skill ${id} has no SKILL.md`)
  const target = skillDir(cfg.skillsDir, id)
  await mkdir(cfg.skillsDir, { recursive: true })
  const staging = await mkdtemp(join(cfg.skillsDir, `.tmp-${id}-`))
  try {
    for (const [path, body] of Object.entries(files)) {
      const rel = safeRelPath(path)
      const dest = join(staging, rel)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, body)
    }
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (err) {
    /* v8 ignore next 1 -- best-effort staging cleanup: a forced rm of the just-created temp dir has no realistic failure mode. */
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  const meta = parseFrontmatter(files['SKILL.md'].toString('utf8'))
  return {
    slug: id,
    name: meta.name || id,
    version: meta.version || requested,
    path: target,
    files: Object.keys(files).length,
  }
}

async function downloadSkillFiles(
  slug: string,
  cfg: ResolvedConfig,
  signal?: AbortSignal,
  version?: string,
): Promise<Record<string, Buffer>> {
  const id = parseSlug(slug)
  const ver = parseVersion(version)
  const zipUrl = `${cfg.apiBase.replace(/\/+$/, '')}/api/v1/download?slug=${encodeURIComponent(id)}${ver ? `&version=${encodeURIComponent(ver)}` : ''}&source=dsh`
  const { body, contentType } = await fetchBytes(zipUrl, fetchOpts(cfg), signal)
  if (!/zip|octet-stream/i.test(contentType) && body.subarray(0, 2).toString() !== 'PK') {
    throw new Error(`SkillHub download is not a zip archive: ${id}`)
  }
  return normalizeZipFiles(unzipToFiles(body))
}

/**
 * Flatten an extracted zip tree: strips a single common top-level directory
 * (publishers often wrap the skill in one) and drops directory entries.
 * @param files - the raw extracted archive members.
 * @returns the normalized `path -> bytes` map.
 */
export function normalizeZipFiles(files: Record<string, Buffer>): Record<string, Buffer> {
  const keys = Object.keys(files)
  const prefix = commonTopDir(keys)
  const out: Record<string, Buffer> = {}
  for (const [path, body] of Object.entries(files)) {
    const rel = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    if (!rel || rel.endsWith('/')) continue
    out[safeRelPath(rel)] = body
  }
  return out
}

/**
 * List the skills installed under one skills directory. Entries without a
 * readable `SKILL.md` — including non-directories and broken layouts — are
 * skipped, and a missing root lists as empty.
 * @param skillsDir - the configured skills directory root.
 * @returns the installed skills in slug order.
 */
export async function listInstalled(skillsDir: string): Promise<InstalledSkill[]> {
  const root = resolve(skillsDir)
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const out: InstalledSkill[] = []
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    try {
      const st = await stat(dir)
      if (!st.isDirectory()) continue
      const skillMd = join(dir, 'SKILL.md')
      const text = await readFile(skillMd, 'utf8')
      const meta = parseFrontmatter(text)
      out.push({
        slug: name,
        name: meta.name || name,
        description: meta.description || '',
        ...(meta.version !== undefined ? { version: meta.version } : {}),
        path: dir,
      })
    } catch {
      continue
    }
  }
  return out
}

/**
 * The slugs currently installed under one skills directory.
 * @param skillsDir - the configured skills directory root.
 * @returns the installed slug set.
 */
export async function installedSlugs(skillsDir: string): Promise<Set<string>> {
  return new Set((await listInstalled(skillsDir)).map(it => it.slug))
}

/**
 * Remove one installed skill directory. Removal requires a `SKILL.md` inside
 * the target, so the operation can only ever delete a directory that reads as
 * a skill install under the configured root.
 * @param slug - the installed skill slug.
 * @param skillsDir - the configured skills directory root.
 * @returns the removed slug and path for the canonical tool value.
 * @throws when the slug is invalid or the target has no `SKILL.md`.
 */
export async function uninstallSkill(slug: string, skillsDir: string): Promise<{ slug: string; path: string }> {
  const id = parseSlug(slug)
  const target = skillDir(skillsDir, id)
  let hasSkill = false
  try {
    await readFile(join(target, 'SKILL.md'))
    hasSkill = true
  } catch {
    hasSkill = false
  }
  if (!hasSkill) throw new Error(`not installed or missing SKILL.md: ${id}`)
  await rm(target, { recursive: true, force: true })
  return { slug: id, path: target }
}

/**
 * Parse the install-relevant fields from a `SKILL.md` YAML frontmatter: only
 * `name`, `description`, and `version`, with quoted scalars and `|`/`>` block
 * scalars. Full frontmatter parsing, including invocation policy, belongs to
 * the skill discovery provider.
 * @param text - the full `SKILL.md` text.
 * @returns the recognized fields, absent when the frontmatter omits them.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string; version?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  /* v8 ignore start -- a non-null frontmatter match always captures group 1; the ?? only satisfies noUncheckedIndexedAccess. */
  const lines = (match[1] ?? '').split(/\r?\n/)
  /* v8 ignore stop */
  const out: { name?: string; description?: string; version?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    /* v8 ignore start -- the loop condition bounds the index; the check only narrows noUncheckedIndexedAccess. */
    const line = lines[i]
    if (line === undefined) continue
    /* v8 ignore stop */
    const m = line.match(/^(name|description|version)\s*:\s*(.*)$/)
    if (m === null || m[1] === undefined || m[2] === undefined) continue
    const key = m[1] as 'name' | 'description' | 'version'
    const raw = m[2].trim()
    const block = raw.match(/^([>|])[+-]?\d*$/)
    let value: string
    if (block) {
      const body: string[] = []
      while (i + 1 < lines.length) {
        /* v8 ignore start -- the loop condition bounds the index; the check only narrows noUncheckedIndexedAccess. */
        const next = lines[i + 1]
        if (next === undefined) break
        /* v8 ignore stop */
        if (next.trim() !== '' && !/^\s/.test(next)) break
        body.push(next)
        i += 1
      }
      value = decodeYamlBlock(block[1] as '|' | '>', body)
    } else {
      value = unquoteYamlScalar(raw)
    }
    if (value) out[key] = value
  }
  return out
}

function unquoteYamlScalar(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

/** YAML `|` keeps newlines; `>` folds them. Indent is stripped; trailing blank lines dropped. */
function decodeYamlBlock(style: '|' | '>', body: string[]): string {
  while (body.length) {
    const last = body[body.length - 1]
    if (last === undefined || last.trim() !== '') break
    body.pop()
  }
  const nonempty = body.filter(line => line.trim() !== '')
  const minIndent = nonempty.length
    ? Math.min(...nonempty.map(line => line.length - line.trimStart().length))
    : 0
  const stripped = body.map(line => line.slice(Math.min(minIndent, line.length)))
  if (style === '>') {
    const paras: string[] = []
    let cur: string[] = []
    for (const line of stripped) {
      if (line.trim() === '') {
        if (cur.length) {
          paras.push(cur.join(' '))
          cur = []
        }
        continue
      }
      cur.push(line.trimEnd())
    }
    if (cur.length) paras.push(cur.join(' '))
    return paras.join('\n').trim()
  }
  return stripped.join('\n').trim()
}

/**
 * The single common top-level directory of archive paths, when every member
 * shares one and it is not dotted.
 * @param paths - the archive member paths.
 * @returns the `dir/` prefix, or the empty string when there is none.
 */
function commonTopDir(paths: string[]): string {
  if (!paths.length) return ''
  const first = paths[0]?.replace(/\\/g, '/').split('/')[0]
  if (!first || first.includes('.')) return ''
  return paths.every(p => p.replace(/\\/g, '/').startsWith(`${first}/`)) ? `${first}/` : ''
}
