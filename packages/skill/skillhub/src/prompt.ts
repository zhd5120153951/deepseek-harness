/**
 * The `tool:skillhub` system-prompt section: routing and reply-shape guidance
 * for the SkillHub tools. Registered with visibility matching so the text only
 * assembles for agents that can actually call the tools.
 */

import { CATEGORY_KEYS, categoryLabel } from './categories.ts'

/**
 * Build the section text from the resolved config values it interpolates.
 * @param maxResults - the deployment's default search batch size.
 * @returns the section text.
 */
export function skillHubPromptText(maxResults: number): string {
  return [
    'Finding, recommending, or browsing Agent Skills or SkillHub skills: you MUST call skillhub_search. Never web_search, skill-catalog, the skill loader, or shell commands for this. Never print skillhub install, curl, or shell one-liners.',
    'You decide the keyword. Extract a real topic from the user; do not paste their whole sentence as the query. No concrete topic, or a vague ask like "something fun" or "recommend skills": omit the query to browse popular skills. When the user asks for more, reuse the previous query and pass offset = the number of cards already shown. One call per user message.',
    `Each search batch shows up to ${maxResults} cards. Do not say "tap a card to view details" unless skillhub_search has already returned cards in this turn.`,
    'After cards appear, reply with AT MOST one short sentence. Do NOT list the skills and do not write long prose.',
    'Install only after the user picks a card: call skillhub_install with that slug, then reply with one short sentence. Install requests for a skill that was never shown go through skillhub_search first.',
    `Category filters: ${CATEGORY_KEYS.map(k => `${k}=${categoryLabel(k)}`).join(', ')}.`,
    'For installed skills, call skillhub_list to enumerate them and skillhub_uninstall to remove one.',
  ].join(' ')
}
