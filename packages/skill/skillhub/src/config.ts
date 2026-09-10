/**
 * Small config helpers shared by the plugin entry and the API modules. The
 * plugin entry owns the full resolve step; this module only carries the
 * environment-derived default skills directory and the sort-key sanitizer.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SortBy } from './types.ts'

/** Sort keys the SkillHub search API accepts, in canonical order. */
const SORTS: readonly SortBy[] = ['score', 'downloads', 'stars', 'installs', 'updated_at']

/**
 * The DeepSeek Harness user config root.
 * @returns `$DSH_HOME` when set, else `~/.dsh`.
 */
export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * The default skills directory: the same user root `dsh-skill-filesystem`
 * discovers, so an install becomes visible without extra configuration.
 * @returns `$DSH_HOME/skills` (typically `~/.dsh/skills`).
 */
export function defaultSkillsDir(): string {
  return join(dshHome(), 'skills')
}

/**
 * Normalize an untrusted sort value to an accepted key.
 * @param raw - the raw model- or config-provided sort value.
 * @param fallback - the value used when `raw` names no accepted key.
 * @returns the accepted sort key.
 */
export function sanitizeSortBy(raw: unknown, fallback: SortBy = 'score'): SortBy {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return SORTS.some(sort => sort === value) ? value as SortBy : fallback
}
