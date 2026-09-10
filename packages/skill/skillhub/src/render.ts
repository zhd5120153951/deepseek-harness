/**
 * Model-facing render text for the SkillHub tool results. These are the only
 * strings the model reads; keep each one a complete behavioral instruction,
 * because the renderer output is the tool's prompt-side contract.
 */

import type { InstallResult, InstalledSkill, SearchResult } from './types.ts'

/**
 * Render one `skillhub_search` result. The numbered lines are internal
 * bookkeeping for card offsets — the model must never repeat them — so the
 * text pins the reply shape (one short sentence) and the exact paging call.
 * @param result - the canonical search value.
 * @returns the model-facing text.
 */
export function renderSearch(result: SearchResult): string {
  if (!result.items.length) return 'No matching skills were found. Reply with one short sentence saying so and that the user can try another keyword. Do not write anything longer.'
  const lines = result.items.map((it, i) => `${i + 1}. ${it.name}${it.installed === true ? ' (installed)' : ''} · ${it.slug}`)
  const start = result.offset || 0
  const shown = start + result.items.length
  const more = result.hasMore
    ? `If the user asks for more, immediately call skillhub_search once again with the same query "${result.query}" and offset=${shown}.`
    : 'Everything has been listed.'
  const note = result.fallback ? 'This page shows popular skills because the original keywords had no results (or no more results).' : ''
  return [
    `Cards shown for ${result.items.length} skills (internal numbering, never repeat it to the user):`,
    lines.join('\n'),
    `${note}Reply with AT MOST one short sentence. Never list the skills in prose. Do not call skillhub_search again unprompted. ${more}`,
  ].join('\n')
}

/**
 * Render one `skillhub_install` result.
 * @param result - the canonical install value.
 * @returns the model-facing text.
 */
export function renderInstall(result: InstallResult): string {
  return `Installed ${result.name} at ${result.path}. New conversations discover it through the skill catalog. Do not print install commands.`
}

/**
 * Render one `skillhub_list` result.
 * @param result - the canonical list value.
 * @returns the model-facing text.
 */
export function renderList(result: { items: InstalledSkill[]; skillsDir: string }): string {
  if (!result.items.length) return `No skills are installed yet. Directory: ${result.skillsDir}`
  const lines = result.items.map((it, i) => `${i + 1}. ${it.name} (${it.slug})${it.version !== undefined ? ` v${it.version}` : ''}`)
  return `${result.items.length} skills installed (${result.skillsDir}):\n${lines.join('\n')}`
}

/**
 * Render one `skillhub_uninstall` result.
 * @param result - the canonical uninstall value.
 * @returns the model-facing text.
 */
export function renderUninstall(result: { slug: string; path: string }): string {
  return `Uninstalled ${result.slug} at ${result.path}. It disappears from the skill catalog for new conversations.`
}
