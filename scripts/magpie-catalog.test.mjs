import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { buildCatalog, compareCatalogs, parseSubs, parseI18n, defaultRiskNote, catalogPath, SIGNIN, COPY_KEYS } from './magpie-catalog.mjs'

const AGENTS = Object.keys(SIGNIN)
const REVISION = 'a'.repeat(40)
const RISK_NOTE = 'Qoder may act on it. Use an account you can afford to lose.'
const DEFAULT_RISK = 'Google may suspend it. Use one you can afford to lose.'

function appFixture({ extraField = '' } = {}) {
  const subs = AGENTS.map(agent => {
    if (agent === 'workbuddy-ai') return `{ agent: "${agent}", get name() { return t("WorkBuddy AI (international)"); }, icon: "wb", plans: "Free · Pro", own: true }`
    if (agent === 'zcode') return `{ agent: "zcode", name: "ZCode (GLM Coding Plan)", icon: "zcode", plans: "Lite · Pro", own: true,
      sites: [["zai", "Z.ai", "z.ai"], ["bigmodel", "BigModel (智谱)", "bigmodel.cn"]] }`
    if (agent === 'qoder') return `{ agent: "qoder", name: "Qoder", icon: "qoder", plans: "Pro", own: true, risk: true, riskNote: "${RISK_NOTE}"${extraField} }`
    if (agent === 'antigravity') return `{ agent: "antigravity", name: "Antigravity", icon: "ag", plans: "Pro", risk: true, importable: true }`
    if (agent === 'cursor') return `{ agent: "cursor", name: "Cursor", icon: "cursor", plans: "Pro", single: true }`
    return `{ agent: "${agent}", name: "${agent[0].toUpperCase()}${agent.slice(1)}", icon: "${agent}", plans: "Pro" }`
  })
  const copy = Object.values(COPY_KEYS).map(key => `  t(${JSON.stringify(key)});`).join('\n')
  return `const SUBS = [\n${subs.join(',\n')}\n];
const shortName = (name) => name.replace(/\\s*[(（][^()（）]*[)）]\\s*$/, "") || name;
function renderSigning(sub) {
  t(sub.riskNote || "${DEFAULT_RISK}");
${copy}
}\n`
}

function i18nFixture() {
  const zh = {
    'WorkBuddy AI (international)': 'WorkBuddy 国际版', 'BigModel (智谱)': '智谱 BigModel',
    [RISK_NOTE]: 'Qoder 可能采取措施。', [DEFAULT_RISK]: 'Google 可能封禁。',
    ...Object.fromEntries(Object.values(COPY_KEYS).map(key => [key, `zh:${key}`])),
  }
  return `const I18N = {\n  zh: {\n${Object.entries(zh).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n  },\n  ja: { "Cancel": "x" },\n};\n`
}

function goFixture(overrides = {}) {
  const files = {
    'internal/provider/signin.go': 'redirect = "http://localhost:" + port + "/auth/callback"\nswitch r.URL.Path {\ncase "/callback", "/auth/callback", "/oauth2callback", "/oauth-callback":\ncase "/cancel":\n}',
    'internal/provider/google.go': 'callback: "/oauth2callback", loopback: "127.0.0.1",\ncallback: "/oauth-callback", loopback: "localhost",',
    'internal/provider/kiro_signin.go': 'case "/oauth/callback", "/signin/callback":',
    'internal/provider/dimagent_signin.go': 's.st.PasteCallback, s.state = true, state',
    'internal/provider/copilot_signin.go': 's.st.URL, s.st.Code = dc.URI, dc.UserCode',
    'internal/provider/factory_signin.go': 's.st.URL, s.st.Code = firstNonEmpty(dc.Complete, dc.URI), dc.UserCode',
    'internal/provider/install.go': 'func cliFor(agent string) (agentCLI, bool) {\n\tswitch agent {\n\tcase "devin":\n\tcase "cursor":\n\tcase "grok":\n\t}\n}\n',
    ...overrides,
  }
  return {
    list: () => Object.keys(files).map(file => file.split('/').pop()),
    read: file => { if (!(file in files)) throw new Error(`no ${file}`); return files[file] },
  }
}

const build = (options = {}) => buildCatalog({
  revision: REVISION, loginAgents: options.loginAgents || [...AGENTS].sort(),
  app: options.app || appFixture(), i18n: i18nFixture(), readGo: options.readGo || goFixture(),
})

test('parses SUBS literals and t() getters without evaluating app.js', () => {
  const subs = parseSubs(appFixture())
  assert.equal(subs.length, AGENTS.length)
  assert.deepEqual(subs.find(s => s.agent === 'workbuddy-ai').name, { text: 'WorkBuddy AI (international)', translated: true })
  assert.deepEqual(subs.find(s => s.agent === 'zcode').sites[1], ['bigmodel', 'BigModel (智谱)', 'bigmodel.cn'])
  assert.equal(defaultRiskNote(appFixture()), DEFAULT_RISK)
  assert.equal(parseI18n(i18nFixture()).get('BigModel (智谱)'), '智谱 BigModel')
  assert.throws(() => parseSubs(appFixture({ extraField: ', pasteKey: true' })), /pasteKey is new/)
  assert.throws(() => parseSubs('const SUBS = [{ agent: "x", name: label(), plans: "p" }];'), /not a literal/)
  assert.throws(() => parseSubs('const SUBS = [{ agent: "x", get name() { return "x"; }, plans: "p" }];'), /getter/)
  assert.throws(() => parseSubs('const OTHER = [];'), /no single SUBS/)
})

test('builds the catalog: names, zh copy, sites, risk, completion modes and gates', () => {
  const catalog = build()
  assert.equal(catalog.revision, REVISION)
  assert.deepEqual(catalog.items.map(item => item.agent), AGENTS)
  const byAgent = Object.fromEntries(catalog.items.map(item => [item.agent, item]))
  assert.deepEqual(byAgent['workbuddy-ai'].name, { en: 'WorkBuddy AI (international)', zh: 'WorkBuddy 国际版' })
  assert.deepEqual(byAgent['workbuddy-ai'].short, { en: 'WorkBuddy AI', zh: 'WorkBuddy 国际版' })
  assert.deepEqual(byAgent.zcode.short.en, 'ZCode')
  assert.deepEqual(byAgent.zcode.sites.map(site => [site.id, site.label.zh, site.host]), [['zai', 'Z.ai', 'z.ai'], ['bigmodel', '智谱 BigModel', 'bigmodel.cn']])
  assert.deepEqual(byAgent.qoder.riskNote, { en: RISK_NOTE, zh: 'Qoder 可能采取措施。' })
  assert.deepEqual(byAgent.antigravity.riskNote, { en: DEFAULT_RISK, zh: 'Google 可能封禁。' })
  assert.equal(byAgent.claude.risk, false)
  assert.equal(byAgent.claude.riskNote, null)
  assert.equal(byAgent.cursor.single, true)
  assert.deepEqual(catalog.items.filter(item => item.gate === 'host-exec').map(item => item.agent).sort(), ['cursor', 'devin', 'grok'])
  assert.deepEqual(catalog.items.filter(item => item.deviceCode).map(item => item.agent).sort(), ['copilot', 'factory'])
  assert.deepEqual(byAgent.kiro.relayPaths, ['/oauth/callback', '/signin/callback'])
  assert.equal(byAgent.dimagent.completion, 'paste')
  assert.deepEqual(catalog.relayForbiddenPaths, ['/cancel'])
  assert.deepEqual(catalog.copy.riskTitle, { en: '{name} accounts can be suspended', zh: 'zh:{name} accounts can be suspended' })
  assert.equal(JSON.stringify(build()), JSON.stringify(catalog), 'deterministic')
})

test('fails closed when the pin drifts from the reviewed sign-in policy', () => {
  assert.throws(() => build({ loginAgents: [...AGENTS, 'qoder-cn'].sort() }), /login agents differ/)
  assert.throws(() => build({ readGo: goFixture({ 'internal/provider/signin_claude.go': 's.st.PasteCallback = true' }) }), /pasteCallback moved/)
  assert.throws(() => build({ readGo: goFixture({ 'internal/provider/google.go': 'callback: "/oauth-callback"' }) }), /oauth2callback for gemini/)
  assert.throws(() => build({ readGo: goFixture({ 'internal/provider/install.go': 'func cliFor(agent string) {\n\tcase "devin":\n\tcase "cursor":\n\tcase "grok":\n\tcase "kiro":\n}\n' }) }), /Host CLI agents changed/)
  assert.throws(() => build({ readGo: goFixture({ 'internal/provider/signin.go': 'case "/callback", "/auth/callback":' }) }), /\/cancel/)
  assert.throws(() => build({ readGo: goFixture({ 'internal/provider/qoder_signin.go': 's.st.Code = c.UserCode' }) }), /Device-code flows changed/)
  assert.throws(() => build({ app: appFixture().replace('t("Sign in anyway");', '') }), /no longer says "Sign in anyway"/)
  assert.throws(() => build({ app: appFixture().replace('const shortName', 'const shortNameX') }), /shortName/)
})

test('compareCatalogs reports agents, risk, sign-in and copy changes for review', () => {
  const before = build()
  const after = structuredClone(before)
  after.items = after.items.filter(item => item.agent !== 'zed')
  after.items.push({ ...after.items[0], agent: 'qoder-cn' })
  after.items.find(item => item.agent === 'qoder').riskNote.zh = '改了'
  after.items.find(item => item.agent === 'codex').completion = 'paste'
  after.copy.cancel = { en: 'Cancel', zh: '算了' }
  const diff = compareCatalogs(before, after)
  assert.deepEqual(diff.addedAgents, ['qoder-cn'])
  assert.deepEqual(diff.removedAgents, ['zed'])
  assert.deepEqual(diff.riskChanged, ['qoder'])
  assert.deepEqual(diff.signinChanged, ['codex'])
  assert.deepEqual(diff.changedAgents, ['codex', 'qoder'])
  assert.deepEqual(diff.copyChanged, ['cancel'])
})

test('the committed catalog matches the committed contract and covers every sign-in agent', async () => {
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const contract = JSON.parse(await fs.readFile(new URL('../deploy/magpie/upstream/api.json', import.meta.url), 'utf8'))
  assert.equal(catalog.revision, contract.revision)
  assert.deepEqual(catalog.items.map(item => item.agent).sort(), [...contract.loginAgents].sort())
  for (const item of catalog.items) {
    assert.ok(catalog.modes[item.completion], `${item.agent} has a known mode`)
    assert.equal(item.risk, item.riskNote !== null, `${item.agent} risk note`)
    if (item.riskNote) assert.ok(item.riskNote.zh && item.riskNote.zh !== item.riskNote.en, `${item.agent} zh risk copy`)
    assert.equal(item.completion === 'relay', item.relayPaths.length > 0, `${item.agent} relay paths`)
    assert.ok(!item.relayPaths.includes('/cancel'))
  }
  assert.deepEqual(catalog.items.filter(item => item.gate).map(item => item.agent).sort(), ['cursor', 'devin', 'grok'])
  assert.equal(catalog.items.find(item => item.agent === 'claude').risk, false)
})
