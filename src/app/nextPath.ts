/**
 * `next` after login: only same-origin app paths — no `//host` or `/\host` (protocol-relative), no `/api`,
 * no login loop. The router still applies the role guard to it, so a key user's `next=/keys` lands on /me.
 * Dependency-free so `server/appShell.test.ts` can exercise it directly.
 */
export function safeNext(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.length > 2048) return null
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null
  // control characters and backslashes are never part of an app path (browsers normalise `\` to `/`)
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x5c) return null
  }
  if (/^\/(api|login)(\/|\?|#|$)/i.test(value)) return null
  return value
}
