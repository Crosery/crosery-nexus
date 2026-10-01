import assert from 'node:assert/strict'
import test from 'node:test'

const originalFetch = globalThis.fetch
const cpaBaseUrl = 'https://cpa.example.test'

async function loadCPA() {
  process.env.CPA_BASE_URL = cpaBaseUrl
  process.env.CPA_MANAGEMENT_KEY = 'management-key'
  return import(`./cpa.ts?test=${Date.now()}-${Math.random()}`)
}

/**
 * CPA 没有清冷却端点：disable_cooling 置 true 会当场清空该凭据的全部既有冷却，
 * 置回 false 恢复正常失败保护，且已清掉的冷却不会回灌（2026-09-28 对 codex/
 * antigravity/claude 三种凭据实测）。顺序不可反：先 false 后 true 会把该凭据的
 * 失败冷却永久关掉。上游额度重置成功后必须靠这个动作让凭据立刻回到池选，
 * 否则要干等 429 里旧 resets_at 排的冷却（2026-09-27「重置了但用不了」事故）。
 */
test('clearAuthFileCooldown toggles disable_cooling true then false on the same credential', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body || '{}')) })
    return new Response('{"status":"ok"}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const { clearAuthFileCooldown } = await loadCPA()
    await clearAuthFileCooldown('codex-x.json')
    assert.deepEqual(calls, [
      { path: '/v0/management/auth-files/fields', body: { name: 'codex-x.json', disable_cooling: true } },
      { path: '/v0/management/auth-files/fields', body: { name: 'codex-x.json', disable_cooling: false } },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the restore patch is not attempted when the clear itself fails', async () => {
  let patches = 0
  globalThis.fetch = async () => { patches += 1; return new Response('boom', { status: 503 }) }
  try {
    const { clearAuthFileCooldown } = await loadCPA()
    await assert.rejects(() => clearAuthFileCooldown('codex-x.json'))
    assert.equal(patches, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
