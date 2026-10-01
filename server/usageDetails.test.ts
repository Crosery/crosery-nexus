import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { categorizeUsageError, resolveCacheReadTokens, resolveCacheWriteTokens } from './usageDetails.js'

test('categorizes the production Codex EOF burst as an upstream transport failure', () => {
  assert.equal(categorizeUsageError(500, 'Post "https://chatgpt.com/backend-api/codex/responses": EOF'), 'upstream_eof')
  assert.equal(categorizeUsageError(500, 'stream error: stream ID 1; PROTOCOL_ERROR; received from peer'), 'upstream_eof')
})

test('prefers explicit Claude cache read/write segments and derives writes from the same read value', () => {
  const record = {
    provider: 'claude',
    model: 'claude-opus-5',
    tokens: {
      input_tokens: 2,
      cached_tokens: 999,
      cache_read_tokens: 73_630,
      cache_creation_tokens: 77_076,
      output_tokens: 670,
      total_tokens: 151_378,
    },
  }
  assert.equal(resolveCacheReadTokens(record), 73_630)
  assert.equal(resolveCacheWriteTokens(record), 77_076)
  assert.equal(resolveCacheReadTokens({ provider: 'claude', model: 'claude-opus-5', tokens: { cached_tokens: 999, cache_read_tokens: 0, cache_read_tokens_present: true } }), 0)
  assert.equal(resolveCacheWriteTokens({ ...record, tokens: { ...record.tokens, cache_creation_tokens: undefined } }), 77_076)
})

test('compatible Claude-named models never invent a cache write segment', () => {
  const record = {
    provider: 'openai-compatible-minimax',
    model: 'claude-opus-5',
    tokens: { input_tokens: 100, cached_tokens: 50, output_tokens: 2, total_tokens: 1000 },
  }
  assert.equal(resolveCacheReadTokens(record), 50)
  assert.equal(resolveCacheWriteTokens(record), 0)
})

test('separates caller input, quota, auth and wrong-endpoint failures', () => {
  assert.equal(categorizeUsageError(400, '{"code":"context_too_large"}'), 'context_too_large')
  assert.equal(categorizeUsageError(402, 'Insufficient balance'), 'quota_exhausted')
  assert.equal(categorizeUsageError(401, 'OAuth access token has been revoked.'), 'auth_failed')
  assert.equal(categorizeUsageError(400, 'model is not available on this endpoint'), 'wrong_endpoint')
})
