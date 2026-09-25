const KEY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RANDOM_SUFFIX_PATTERN = /^[0-9a-f]{24,}$/i

export function normalizeKeySlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

export function validateKeySlug(value: string) {
  const slug = normalizeKeySlug(value)
  if (!slug) throw new Error('请输入 Key 标识，只能使用小写英文字母、数字和短横线')
  if (slug.length > 32) throw new Error('Key 标识不能超过 32 个字符')
  if (!KEY_SLUG_PATTERN.test(slug)) throw new Error('Key 标识只能使用小写英文字母、数字和短横线')
  return slug
}

export function deriveKeySlug(name: string) {
  return normalizeKeySlug(name) || 'api-key'
}

export function buildNamedAPIKey(slugValue: string, randomSuffix: string) {
  return `sk-${validateKeySlug(slugValue)}-${randomSuffix}`
}

export function extractKeySlug(key: string) {
  if (!key.startsWith('sk-')) return ''
  const body = key.slice(3)
  const separator = body.lastIndexOf('-')
  if (separator <= 0) return ''
  const suffix = body.slice(separator + 1)
  const slug = body.slice(0, separator)
  if (!RANDOM_SUFFIX_PATTERN.test(suffix)) return ''
  return KEY_SLUG_PATTERN.test(slug) ? slug : ''
}
