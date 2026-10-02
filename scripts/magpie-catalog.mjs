import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildSettings, compareSettings, INDEX_HTML, RULES_GO, SETTINGS_EVIDENCE, SETTINGS_GO } from './magpie-settings.mjs'

// Magpie's subscription catalog at the pinned revision, for /accounts: the SUBS tiles of
// internal/gui/assets/app.js with their zh copy from i18n.js, joined with the console's
// per-agent sign-in policy below. Parsed with the TypeScript compiler, never evaluated.
// Usage: node scripts/magpie-catalog.mjs generate|verify|diff --source <clean pinned checkout> [diff: --contract <candidate api.json> --fail-on-drift]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const catalogPath = path.join(root, 'deploy/magpie/catalog.json')
const contractPath = path.join(root, 'deploy/magpie/upstream/api.json')
const APP = 'internal/gui/assets/app.js'
const I18N = 'internal/gui/assets/i18n.js'

/**
 * How each pinned agent signs in, and what a user whose browser is NOT on the kernel host must do:
 * - poll: Magpie polls the vendor (device code or vendor-hosted page); open the link anywhere.
 * - relay: the vendor redirects the browser to a loopback listener on the host; the user pastes
 *   the final localhost URL and the console replays it to that listener (only `relayPaths`).
 * - paste: Magpie's own pasteCallback (POST /internal/signin/callback).
 * - cli: Magpie runs the vendor's CLI on the host; host-exec gated.
 * - local: the browser must be on the host (the vendor page posts to it, or the port is not in redirect_uri).
 * gate 'host-exec': runs a host CLI or `curl … | bash` installer; off unless the kernel enables it.
 * Every entry is checked against the pinned Go source below; a new or changed agent fails generation.
 */
export const SIGNIN = {
  claude: { method: 'loopback', completion: 'relay', relayPaths: ['/callback'] },
  codex: { method: 'loopback', completion: 'relay', relayPaths: ['/auth/callback'] },
  antigravity: { method: 'loopback', completion: 'relay', relayPaths: ['/oauth-callback'] },
  gemini: { method: 'loopback', completion: 'relay', relayPaths: ['/oauth2callback'] },
  kiro: { method: 'loopback', completion: 'relay', relayPaths: ['/oauth/callback', '/signin/callback'] },
  devin: { method: 'loopback', completion: 'relay', relayPaths: ['/callback'], gate: 'host-exec' },
  dimagent: { method: 'loopback', completion: 'paste' },
  copilot: { method: 'device-code', completion: 'poll' },
  factory: { method: 'device-code', completion: 'poll' },
  zcode: { method: 'vendor-poll', completion: 'poll' },
  workbuddy: { method: 'vendor-poll', completion: 'poll' },
  'workbuddy-ai': { method: 'vendor-poll', completion: 'poll' },
  qoder: { method: 'vendor-poll', completion: 'poll' },
  'mimo-app': { method: 'vendor-poll', completion: 'poll' },
  cursor: { method: 'host-cli', completion: 'cli', gate: 'host-exec' },
  grok: { method: 'host-cli', completion: 'cli', gate: 'host-exec' },
  'commandcode-plan': { method: 'loopback-post', completion: 'local' },
  zed: { method: 'loopback', completion: 'local' },
}

/** Where the pinned source proves each relay path (the listener answers these, and only these). */
const RELAY_EVIDENCE = {
  claude: 'internal/provider/signin.go', codex: 'internal/provider/signin.go', devin: 'internal/provider/signin.go',
  gemini: 'internal/provider/google.go', antigravity: 'internal/provider/google.go', kiro: 'internal/provider/kiro_signin.go',
}

/** The vendor behind each subscription; SUBS has no such field. */
export const VENDORS = {
  claude: 'Anthropic', codex: 'OpenAI', cursor: 'Cursor', grok: 'xAI', copilot: 'GitHub', zcode: 'Z.ai · 智谱',
  workbuddy: 'Tencent', 'workbuddy-ai': 'Tencent', 'commandcode-plan': 'Command Code', qoder: 'Qoder', devin: 'Cognition',
  dimagent: 'DimAgent', zed: 'Zed', factory: 'Factory', 'mimo-app': 'Xiaomi', kiro: 'Kiro', gemini: 'Google', antigravity: 'Google',
}

/** Magpie's own words for the add-account and sign-in steps the console reuses (English key → zh). */
export const COPY_KEYS = {
  section: 'Subscriptions',
  sectionHint: 'sign in, no key',
  tileTitle: '{name} subscription',
  riskTitle: '{name} accounts can be suspended',
  riskConfirm: 'Sign in anyway',
  sitePrompt: 'Where is your {name} account?',
  siteHint: "Sign in where your GLM Coding Plan was bought, a team's plan too: z.ai, or bigmodel.cn for 智谱.",
  installing: 'Installing {cli}…',
  waitingTitle: 'Finish signing in to {name} in your browser',
  callbackHint: 'If the browser cannot return to magpie, paste its final callback URL here.',
  callbackLabel: 'Callback URL',
  callbackSubmit: 'Finish sign-in',
  failedTitle: "Sign-in didn't finish",
  retry: 'Try again',
  cancel: 'Cancel',
  signedIn: 'Signed in as {user}',
  added: '{user} added — switch to it any time',
  openAgain: 'Open again',
  copyLink: 'Copy link',
}

const SUB_FIELDS = new Set(['agent', 'name', 'icon', 'plans', 'importable', 'single', 'own', 'risk', 'riskNote', 'sites'])
const SHORT_NAME_RE = String.raw`/\s*[(（][^()（）]*[)）]\s*$/`
const shortName = name => name.replace(/\s*[(（][^()（）]*[)）]\s*$/, '') || name
const sha256 = text => createHash('sha256').update(text).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`

function parse(name, text) {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function propertyName(node) {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text
  throw new Error('SUBS has a computed property; review the catalog extractor')
}

function literal(node, where) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => literal(element, where))
  throw new Error(`SUBS ${where} is not a literal; review the catalog extractor`)
}

/** `get name() { return t("…") }`: the literal, marked as translated through i18n. */
function getterLiteral(node, where) {
  const statements = node.body?.statements || []
  const call = statements.length === 1 && ts.isReturnStatement(statements[0]) ? statements[0].expression : null
  if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 't' &&
      call.arguments.length === 1 && ts.isStringLiteral(call.arguments[0])) {
    return { text: call.arguments[0].text, translated: true }
  }
  throw new Error(`SUBS ${where} getter is not t("…"); review the catalog extractor`)
}

export function parseSubs(appText) {
  const file = parse('app.js', appText)
  const found = []
  walk(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'SUBS') found.push(node)
  })
  if (found.length !== 1 || !found[0].initializer || !ts.isArrayLiteralExpression(found[0].initializer)) {
    throw new Error('Pinned app.js has no single SUBS array; review the catalog extractor')
  }
  return found[0].initializer.elements.map((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error('SUBS entry is not an object literal')
    const sub = {}
    for (const property of element.properties) {
      const key = propertyName(property)
      const where = `#${index}.${key}`
      if (!SUB_FIELDS.has(key)) throw new Error(`SUBS field ${key} is new; review the catalog extractor`)
      if (ts.isPropertyAssignment(property)) sub[key] = literal(property.initializer, where)
      else if (ts.isGetAccessorDeclaration(property)) sub[key] = getterLiteral(property, where)
      else throw new Error(`SUBS ${where} is not a plain property`)
    }
    if (typeof sub.agent !== 'string' || !sub.name || typeof sub.plans !== 'string') throw new Error(`SUBS #${index} lacks agent, name or plans`)
    return sub
  })
}

/** Every string literal in app.js: the copy keys must be among them (passed to t() directly or via a helper). */
export function stringLiterals(appText) {
  const out = new Set()
  walk(parse('app.js', appText), node => { if (ts.isStringLiteral(node)) out.add(node.text) })
  return out
}

/** The text renderSigning falls back to for a risky sub without riskNote: `sub.riskNote || "…"`. */
export function defaultRiskNote(appText) {
  const found = new Set()
  walk(parse('app.js', appText), node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'riskNote' && ts.isStringLiteral(node.right)) {
      found.add(node.right.text)
    }
  })
  if (found.size !== 1) throw new Error('Pinned app.js has no single default risk note; review the catalog extractor')
  return [...found][0]
}

export function parseI18n(i18nText, language = 'zh') {
  const file = parse('i18n.js', i18nText)
  let table = null
  walk(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'I18N' &&
        node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const lang = node.initializer.properties.find(p => ts.isPropertyAssignment(p) && propertyName(p) === language)
      if (lang && ts.isObjectLiteralExpression(lang.initializer)) table = lang.initializer
    }
  })
  if (!table) throw new Error(`Pinned i18n.js has no I18N.${language} table`)
  const out = new Map()
  for (const property of table.properties) {
    if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) out.set(propertyName(property), property.initializer.text)
  }
  return out
}

function casesOf(goText, func) {
  const start = goText.indexOf(`func ${func}(`)
  if (start < 0) throw new Error(`Pinned source has no ${func}; review the catalog extractor`)
  const body = goText.slice(start, goText.indexOf('\n}\n', start))
  return [...body.matchAll(/case ((?:"[^"]+",? ?)+):/g)].flatMap(match => [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]))
}

/**
 * Checks SIGNIN against the pinned Go source, so a pin bump that adds a native paste, a device
 * code, a host CLI or moves a callback path fails here instead of shipping a wrong sign-in sheet.
 */
export function checkSigninEvidence(agents, readGo) {
  const policyAgents = Object.keys(SIGNIN).sort()
  const missing = agents.filter(agent => !SIGNIN[agent])
  const extra = policyAgents.filter(agent => !agents.includes(agent))
  if (missing.length || extra.length) throw new Error(`Sign-in policy does not cover the pinned agents (missing: ${missing.join(',') || '-'}; extra: ${extra.join(',') || '-'}); review SIGNIN`)
  const providerFiles = readGo.list('internal/provider').filter(name => name.endsWith('.go') && !name.endsWith('_test.go'))
  const setting = pattern => providerFiles.filter(name => pattern.test(readGo.read(`internal/provider/${name}`))).sort()
  const pasteFiles = setting(/\bst\.PasteCallback\b[^\n]*=\s*true\b/)
  if (JSON.stringify(pasteFiles) !== JSON.stringify(['dimagent_signin.go'])) throw new Error(`Native pasteCallback moved (${pasteFiles.join(',')}); review SIGNIN`)
  const codeFiles = setting(/\bst\.URL, s\.st\.Code\s*=|\bst\.Code\s*=/)
  if (JSON.stringify(codeFiles) !== JSON.stringify(['copilot_signin.go', 'factory_signin.go'])) throw new Error(`Device-code flows changed (${codeFiles.join(',')}); review SIGNIN`)
  const hostExec = casesOf(readGo.read('internal/provider/install.go'), 'cliFor').sort()
  const gated = policyAgents.filter(agent => SIGNIN[agent].gate === 'host-exec')
  if (JSON.stringify(hostExec) !== JSON.stringify(gated)) throw new Error(`Host CLI agents changed (${hostExec.join(',')}); review SIGNIN`)
  const signin = readGo.read('internal/provider/signin.go')
  if (!signin.includes('case "/cancel":')) throw new Error('The loopback listener no longer cancels on /cancel; review the relay rules')
  for (const [agent, file] of Object.entries(RELAY_EVIDENCE)) {
    const text = readGo.read(file)
    for (const p of SIGNIN[agent].relayPaths) {
      if (!text.includes(`"${p}"`)) throw new Error(`Relay path ${p} for ${agent} is not in ${file}; review SIGNIN`)
    }
  }
  const relay = policyAgents.filter(agent => SIGNIN[agent].completion === 'relay').sort()
  if (JSON.stringify(relay) !== JSON.stringify(Object.keys(RELAY_EVIDENCE).sort())) throw new Error('Relay agents lack source evidence')
  return { deviceCode: ['copilot', 'factory'] }
}

export function buildCatalog({ revision, loginAgents, app, i18n, readGo }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid revision')
  if (!app.includes(`const shortName = (name) => name.replace(${SHORT_NAME_RE}, "") || name;`)) {
    throw new Error('Magpie changed shortName; review the catalog extractor')
  }
  const subs = parseSubs(app)
  const zh = parseI18n(i18n)
  const literals = stringLiterals(app)
  const agents = subs.map(sub => sub.agent)
  if (new Set(agents).size !== agents.length) throw new Error('SUBS repeats an agent')
  const sorted = [...agents].sort()
  if (JSON.stringify(sorted) !== JSON.stringify([...loginAgents].sort())) {
    throw new Error('SUBS and the contract\'s login agents differ; regenerate the contract and review the catalog')
  }
  const { deviceCode } = checkSigninEvidence(sorted, readGo)
  const translate = (key, where) => {
    const value = zh.get(key)
    if (value === undefined) throw new Error(`Magpie has no zh text for ${where}`)
    return value
  }
  const copy = Object.fromEntries(Object.entries(COPY_KEYS).map(([id, key]) => {
    if (!literals.has(key)) throw new Error(`Magpie no longer says "${key}"; review COPY_KEYS`)
    return [id, { en: key, zh: translate(key, id) }]
  }))
  const fallbackRisk = defaultRiskNote(app)
  const items = subs.map(sub => {
    const nameEn = typeof sub.name === 'string' ? sub.name : sub.name.text
    const nameZh = typeof sub.name === 'string' ? sub.name : (zh.get(sub.name.text) ?? sub.name.text)
    const policy = SIGNIN[sub.agent]
    const note = sub.risk === true ? (sub.riskNote || fallbackRisk) : null
    return {
      agent: sub.agent,
      name: { en: nameEn, zh: nameZh },
      short: { en: shortName(nameEn), zh: shortName(nameZh) },
      icon: typeof sub.icon === 'string' ? sub.icon : null,
      vendor: VENDORS[sub.agent] || shortName(nameEn),
      plans: sub.plans,
      own: sub.own === true,
      single: sub.single === true,
      risk: sub.risk === true,
      riskNote: note ? { en: note, zh: translate(note, `${sub.agent} risk note`) } : null,
      sites: (sub.sites || []).map(site => {
        if (!Array.isArray(site) || site.length !== 3 || !site.every(part => typeof part === 'string')) throw new Error(`${sub.agent} site is not [id, label, host]`)
        const [id, label, host] = site
        return { id, label: { en: label, zh: zh.get(label) ?? label }, host }
      }),
      method: policy.method,
      completion: policy.completion,
      deviceCode: deviceCode.includes(sub.agent),
      relayPaths: policy.relayPaths || [],
      gate: policy.gate || null,
    }
  })
  return {
    version: 1,
    revision,
    generatedBy: 'scripts/magpie-catalog.mjs',
    license: 'Upstream Magpie text, Copyright (c) 2026 yetone, MIT; see deploy/magpie/upstream/LICENSE.',
    source: { [APP]: sha256(app), [I18N]: sha256(i18n) },
    modes: {
      poll: 'Magpie polls the vendor; the link (and code) work from any browser.',
      relay: 'The vendor returns to a loopback listener on the host; paste the final localhost URL, the console replays it there.',
      paste: "Magpie's own pasteCallback finishes the sign-in from the pasted URL.",
      cli: "Magpie runs the vendor's CLI on the host (gated).",
      local: 'Only a browser on the host can finish it.',
    },
    relayForbiddenPaths: ['/cancel'],
    copy,
    items,
  }
}

/** Non-empty fields of a compareCatalogs result, as `field: items`. */
export function catalogDriftItems(drift) {
  return Object.entries(drift || {}).filter(([, value]) => Array.isArray(value) && value.length).map(([key, value]) => `${key}: ${value.join(', ')}`)
}

/** What changed between two catalogs, for review of a pin bump. */
export function compareCatalogs(before, after) {
  const index = catalog => new Map(catalog.items.map(item => [item.agent, item]))
  const a = index(before)
  const b = index(after)
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
  return {
    addedAgents: [...b.keys()].filter(agent => !a.has(agent)).sort(),
    removedAgents: [...a.keys()].filter(agent => !b.has(agent)).sort(),
    riskChanged: [...b.keys()].filter(agent => a.has(agent) &&
      !same([a.get(agent).risk, a.get(agent).riskNote], [b.get(agent).risk, b.get(agent).riskNote])).sort(),
    signinChanged: [...b.keys()].filter(agent => a.has(agent) &&
      !same(['method', 'completion', 'deviceCode', 'relayPaths', 'gate'].map(k => a.get(agent)[k]),
        ['method', 'completion', 'deviceCode', 'relayPaths', 'gate'].map(k => b.get(agent)[k]))).sort(),
    changedAgents: [...b.keys()].filter(agent => a.has(agent) && !same(a.get(agent), b.get(agent))).sort(),
    copyChanged: Object.keys({ ...before.copy, ...after.copy }).filter(key => !same(before.copy[key], after.copy[key])).sort(),
    ...(after.settings ? compareSettings(before.settings, { tags: Object.fromEntries(Object.entries(after.settings.keys).map(([tag, key]) => [tag, key.goType])), reworded: [] }) : {}),
    settingsCopyChanged: after.settings ? (after.settings.items || []).filter(item =>
      !same(item, (before.settings?.items || []).find(old => old.key === item.key))).map(item => item.key).sort() : [],
  }
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

/** `contractFile`: a candidate's api.json (auto-update rehearsal) instead of the pinned deploy/magpie/upstream/api.json. */
export async function extractCatalog(source, { contractFile = contractPath } = {}) {
  const revision = git(['rev-parse', 'HEAD'], source).trim()
  if (!/^[a-f0-9]{40}$/.test(revision) || git(['status', '--porcelain'], source).trim()) {
    throw new Error('Catalog extraction requires a clean, committed source checkout')
  }
  const contract = JSON.parse(await fs.readFile(contractFile, 'utf8'))
  if (contract.revision !== revision) throw new Error('The source is not the contract\'s revision; regenerate the contract first')
  const read = async relative => fs.readFile(path.join(source, relative), 'utf8')
  const goFiles = new Map()
  for (const name of await fs.readdir(path.join(source, 'internal/provider'))) {
    if (name.endsWith('.go') && !name.endsWith('_test.go')) goFiles.set(`internal/provider/${name}`, await read(`internal/provider/${name}`))
  }
  const readGo = {
    list: directory => [...goFiles.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file)),
    read: file => { if (!goFiles.has(file)) throw new Error(`Pinned source has no ${file}`); return goFiles.get(file) },
  }
  const app = await read(APP)
  const i18n = await read(I18N)
  const catalog = buildCatalog({ revision, loginAgents: contract.loginAgents, app, i18n, readGo })
  // Settings (网关功能): every settings.Settings tag classified, the gateway rows with Magpie's copy
  const settingsGo = await read(SETTINGS_GO)
  const rulesGo = await read(RULES_GO)
  const index = await read(INDEX_HTML)
  const evidence = Object.fromEntries(await Promise.all(Object.keys(SETTINGS_EVIDENCE).map(async file => [file, await read(file)])))
  for (const [file, text] of [[SETTINGS_GO, settingsGo], [RULES_GO, rulesGo], [INDEX_HTML, index]]) catalog.source[file] = sha256(text)
  catalog.settings = buildSettings({ settingsGo, rulesGo, app, index, zh: parseI18n(i18n), evidence })
  return catalog
}

async function main() {
  const action = process.argv[2]
  const at = process.argv.indexOf('--source')
  const source = at < 0 ? process.env.MAGPIE_SOURCE : process.argv[at + 1]
  if (!['generate', 'verify', 'diff'].includes(action)) throw new Error('Use generate, verify or diff --source <checkout>')
  if (!source) throw new Error('Pass --source with a clean upstream checkout')
  const contractAt = process.argv.indexOf('--contract')
  if (contractAt >= 0 && action !== 'diff') throw new Error('--contract only applies to diff')
  const catalog = await extractCatalog(path.resolve(source), contractAt < 0 ? {} : { contractFile: path.resolve(process.argv[contractAt + 1]) })
  if (action === 'generate') {
    const temporary = `${catalogPath}.${process.pid}.tmp`
    await fs.writeFile(temporary, json(catalog), { flag: 'wx', mode: 0o644 })
    await fs.rename(temporary, catalogPath)
  } else if (action === 'verify') {
    if (await fs.readFile(catalogPath, 'utf8') !== json(catalog)) throw new Error('deploy/magpie/catalog.json is stale for this source; run generate and review')
  } else {
    const drift = compareCatalogs(JSON.parse(await fs.readFile(catalogPath, 'utf8')), catalog)
    console.log(json(drift))
    // --fail-on-drift: a candidate build (build-magpie-kernel.mjs --candidate) must not change what the console shows
    if (process.argv.includes('--fail-on-drift') && catalogDriftItems(drift).length) process.exitCode = 1
    return
  }
  const count = mode => catalog.items.filter(item => item.completion === mode).map(item => item.agent)
  console.log(JSON.stringify({ action, revision: catalog.revision, items: catalog.items.length,
    modes: Object.fromEntries(Object.keys(catalog.modes).map(mode => [mode, count(mode)])),
    risk: catalog.items.filter(item => item.risk).map(item => item.agent),
    gated: catalog.items.filter(item => item.gate).map(item => item.agent),
    settings: { keys: Object.keys(catalog.settings.keys).length, gateway: catalog.settings.items.map(item => item.key) } }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
