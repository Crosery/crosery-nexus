import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * Template-level regressions from the removals review that have no pure model to test (the model-level ones
 * live in accountsPageModel / settingsModel / rtkGlobal tests). Each check reads the SFC source.
 */
const read = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

/** body of `async function <name>(…) { … }` up to the next top-level function */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  const next = src.indexOf('\nasync function ', start + 1)
  const nextSync = src.indexOf('\nfunction ', start + 1)
  const end = [next, nextSync].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), src.length)
  return src.slice(start, end)
}

test('RR-4: a pasted OAuth callback keeps polling the session instead of declaring success right after the POST', () => {
  const sheet = read('src/features/accounts/AddAccountSheet.vue')
  const body = fnBody(sheet, 'submitCallback')
  assert.doesNotMatch(body, /confirmServerSide\(/, 'the callback POST only hands the code over; the session status decides')
  assert.match(body, /schedule\(mine\)/)
  const page = read('src/features/accounts/CpaAccountsPage.vue')
  assert.match(fnBody(page, 'verifyAdded'), /verifyOutcome\(/, 'renewal is decided by the tested model rule')
})

test('RR-8: the callback field accepts a raw code or a query fragment (no native URL validation)', () => {
  const sheet = read('src/features/accounts/AddAccountSheet.vue')
  const input = /<input id="acc-cb"[^>]*>/.exec(sheet)?.[0] ?? ''
  assert.match(input, /type="text"/)
  assert.match(input, /inputmode="url"/)
})

test('RR-10: /help and /me/connect link to /docs in a new tab', () => {
  for (const rel of ['src/features/help/HelpPage.vue', 'src/features/me/MeConnectPage.vue']) {
    const link = /<a [^>]*href="\/docs"[^>]*>/.exec(read(rel))?.[0] ?? ''
    assert.match(link, /target="_blank"/, rel)
    assert.match(link, /rel="noopener[^"]*"/, rel)
  }
})

test('RR-2: the account proxy picker reads the authoritative per-credential value, not the list field', () => {
  const detail = read('src/features/accounts/AccountDetail.vue')
  // script (`props.row.proxyUrl`) or template binding (`"… row.proxyUrl …"`); the explaining comment may name it
  assert.ok(!/props\.row\.proxyUrl|"[^"\n]*\brow\.proxyUrl/.test(detail), 'CPA lists report "" for every account')
  assert.match(detail, /readProxy\(/)
  // a read that settles while a custom address is being typed must not wipe it (the rule is proxyKeepsDraft)
  const settle = /watch\(read, \(value\) => \{([\s\S]*?)\n\}, \{ immediate: true \}\)/.exec(detail)?.[1] ?? ''
  assert.match(settle, /^\s*if \(proxyKeepsDraft\(choice\.value, draft\.value, sent\)\) return/, 'checked before the picker is reset')
  assert.match(detail, /sent = next\s*\n\s*emit\('proxy', next\)/, 'the saved address is remembered as sent')
  const actions = read('src/features/accounts/useAccountActions.ts')
  assert.match(fnBody(actions, 'setProxy'), /knowProxy\(row\.name, saved\)/, 'the PATCH response becomes the shown value')
})
