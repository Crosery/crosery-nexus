import crypto from 'node:crypto'

const revealTokens = new Map<string, { keyHash: string; keyValue: string; expiresAt: number }>()
const REVEAL_TTL_MS = 60_000

export function issueKeyRevealToken(keyHash: string, keyValue: string) {
  const token = crypto.randomBytes(24).toString('base64url')
  revealTokens.set(token, { keyHash, keyValue, expiresAt: Date.now() + REVEAL_TTL_MS })
  return token
}

export function consumeKeyRevealToken(token: string, keyHash: string) {
  const entry = revealTokens.get(token)
  revealTokens.delete(token)
  if (!entry || entry.keyHash !== keyHash || entry.expiresAt < Date.now()) return null
  return entry.keyValue
}
