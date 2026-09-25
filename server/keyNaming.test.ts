import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNamedAPIKey, deriveKeySlug, extractKeySlug, normalizeKeySlug, validateKeySlug } from './keyNaming.js'

test('normalizes a readable key slug to the established kebab-case convention', () => {
  assert.equal(normalizeKeySlug(' Ibuki Prod '), 'ibuki-prod')
  assert.equal(normalizeKeySlug('FEIYU_api'), 'feiyu-api')
})

test('builds keys as sk-purpose-random', () => {
  assert.equal(
    buildNamedAPIKey('ibuki-prod', '00112233445566778899aabbccddeeff'),
    'sk-ibuki-prod-00112233445566778899aabbccddeeff',
  )
})

test('extracts semantic names but ignores legacy random-only keys', () => {
  assert.equal(extractKeySlug('sk-feiyu-00112233445566778899aabbccddeeff'), 'feiyu')
  assert.equal(extractKeySlug('sk-5a99baf411d4cf71949f58bbbde40e3204545d0c05bbdad3'), '')
})

test('derives a valid key slug from a display name', () => {
  assert.equal(deriveKeySlug('伊吹 Production API'), 'production-api')
  assert.equal(deriveKeySlug('Grok 用户'), 'grok')
  assert.equal(deriveKeySlug('中文名称'), 'api-key')
  assert.equal(deriveKeySlug(''), 'api-key')
})

test('rejects invalid or overly long key slugs', () => {
  assert.throws(() => validateKeySlug('中文名称'), /小写英文字母/)
  assert.throws(() => validateKeySlug('a'.repeat(33)), /32/)
})
