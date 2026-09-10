/**
 * First-level SkillHub category keys and their localized labels. The labels
 * are platform data the API returns verbatim, not deployment UI copy.
 */

/** Category key to localized label, in the platform's canonical order. */
export const CATEGORIES: Record<string, string> = {
  'office-efficiency': '办公效率',
  'content-creation': '内容创作',
  'dev-programming': '开发编程',
  'data-analysis': '数据分析',
  'design-media': '设计多媒体',
  'ai-agent': 'AI Agent',
  'knowledge-management': '知识管理',
  'business-ops': '商业运营',
  education: '教育学习',
  professional: '行业专业',
  'it-ops-security': 'IT 运维与安全',
  'life-service': '生活服务',
}

/** The accepted `category` keys, in `CATEGORIES` order. */
export const CATEGORY_KEYS: string[] = Object.keys(CATEGORIES)

/**
 * Localized label for a category key.
 * @param key - the category key; other values fall through unchanged.
 * @returns the platform label, or `key` itself when unknown; empty when absent.
 */
export function categoryLabel(key: string | undefined): string {
  if (!key) return ''
  return CATEGORIES[key] || key
}

/**
 * Accept a category filter only when it names a first-level platform category.
 * @param raw - the raw model-provided category value.
 * @returns the key, or `undefined` when absent or unknown.
 */
export function parseCategory(raw: unknown): string | undefined {
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!key) return undefined
  return CATEGORY_KEYS.includes(key) ? key : undefined
}
