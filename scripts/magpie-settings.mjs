// Magpie's Settings at the pinned revision, for the console's 网关功能 (#gateway-features): every json
// tag of settings.Settings classified for the headless kernel, and the gateway-effective rows with
// Magpie's own copy. Text only (no TypeScript), so the scheduled upstream check can import it.
// scripts/magpie-catalog.mjs embeds buildSettings() as catalog.json "settings"; scripts/magpie-upstream.mjs
// reports settingsDrift() for a candidate revision.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const SETTINGS_GO = 'internal/settings/settings.go'
export const RULES_GO = 'internal/redact/rules.go'
export const INDEX_HTML = 'internal/gui/assets/index.html'
export const SETTINGS_EVIDENCE = {
  'internal/gateway/redact.go': ['st := settings.Load()', 'Secrets: st.Redact, Personal: st.RedactPersonal, Words: st.RedactWords, Rules: st.RedactRules'],
  'internal/gateway/vision.go': ['settings.Load().Vision'],
  'internal/gateway/draw.go': ['settings.Load().ImageGen'],
}
/** The settings each evidence file makes gateway-effective (a missing needle is drift for these keys). */
const EVIDENCE_KEYS = {
  'internal/gateway/redact.go': ['redact', 'redactPersonal', 'redactWords', 'redactRules'],
  'internal/gateway/vision.go': ['vision'],
  'internal/gateway/draw.go': ['imageGen'],
}

export const SETTINGS_CLASSES = {
  gateway: 'Read by the gateway on every request; the console edits it through the kernel.',
  'forced-off': 'The kernel never runs it and the launcher forces it off.',
  'not-in-kernel': 'Runs only in the desktop app or `magpie serve`, never in the headless kernel.',
  'console-owned': 'The console owns this through its own model and channel settings.',
  'proxy-workflow': 'Gateway-effective, but owned by the console proxy pool, not this page.',
  desktop: 'Desktop window, tray or display preference.',
}

/** Every json tag of settings.Settings at the pin. A tag missing here (an upstream addition) fails generation. */
export const SETTINGS_CLASS = {
  theme: 'desktop', lang: 'desktop', tray: 'desktop', sessionTerminal: 'desktop', currency: 'desktop',
  dock: 'desktop', dockWindow: 'desktop', trayUsage: 'desktop', trayUsageEvery: 'desktop', quotaLeft: 'desktop',
  textSize: 'desktop', agentOrder: 'desktop', agentsHidden: 'desktop', agentsShown: 'desktop', window: 'desktop',
  proxy: 'proxy-workflow',
  redact: 'gateway', redactPersonal: 'gateway', redactWords: 'gateway', redactRules: 'gateway', vision: 'gateway', imageGen: 'gateway',
  noStats: 'forced-off',
  lan: 'not-in-kernel', lanKey: 'not-in-kernel', codexWarmup: 'not-in-kernel', claudeWarmup: 'not-in-kernel',
  codexWarmAt: 'not-in-kernel', claudeWarmAt: 'not-in-kernel', workbuddyCheckin: 'not-in-kernel',
  visible: 'console-owned', modelNames: 'console-owned', modelEfforts: 'console-owned', modelImages: 'console-owned',
}

/** Magpie's group order (index.html): 图像, then 隐私. */
export const SETTINGS_GROUPS = [{ id: 'images', title: 'Images' }, { id: 'privacy', title: 'Privacy' }]

/** The rows the console shows, Magpie's order and English keys (zh comes from i18n.js). */
export const SETTINGS_ITEMS = [
  { key: 'vision', group: 'images', control: 'model', goType: 'string', default: '', name: 'Image recognition',
    sub: "When the model in use can't see images, this one describes them to it, once for each image",
    subOff: "A model that can't see images is sent none: a request with one in its latest message is turned away" },
  { key: 'imageGen', group: 'images', control: 'model', goType: 'string', default: '', name: 'Image generation',
    sub: 'The model Magpie Image draws with. Give an agent the tool from Library → MCP servers → Discover → Magpie Image; images are saved in its project',
    subOff: "Agents given Magpie Image can't generate images: the tool says it is off" },
  { key: 'redact', group: 'privacy', control: 'switch', goType: 'bool', default: false, name: 'Mask secrets',
    sub: 'API keys, private keys, tokens and passwords go to vendors as placeholders, and come back as they were' },
  { key: 'redactPersonal', group: 'privacy', control: 'switch', goType: 'bool', default: false, name: 'Mask personal data',
    sub: 'Emails, phone numbers, ID and bank card numbers too' },
  { key: 'redactWords', group: 'privacy', control: 'words', goType: '[]string', default: [], name: 'Masked words',
    sub: 'Your own words to keep from vendors, separated by commas', placeholder: 'names, codenames, hosts' },
  { key: 'redactRules', group: 'privacy', control: 'rules', goType: '[]redact.Rule', default: [], name: 'Masking rules',
    sub: "Secrets magpie doesn't know, such as a gateway's own keys: what they start with, or a regular expression. Masked while Mask secrets is on" },
  { key: 'noStats', group: 'privacy', control: 'forced-off', goType: 'bool', default: false, name: 'Count me as a user',
    sub: "Once a day, a random id for this computer with magpie's version and system — nothing you use magpie for" },
]

export const SETTINGS_COPY = {
  automatic: 'Automatic', off: 'Off', on: 'On', prefix: 'Prefix', regex: 'Regex', add: 'Add', remove: 'Remove',
  startsWith: 'Starts with {p}', matches: 'Matches {re}', noModelSees: 'no model that sees', noModelDraws: 'no model that draws',
  imagesTurnedAway: 'images turned away', noImagesGenerated: 'no images generated',
}

/** Console-side caps the kernel overlay enforces (Magpie validates none for words). */
export const CONSOLE_WORD_LIMITS = { maxWords: 100, minBytes: 2, maxBytes: 64 }

function structBody(goText, name) {
  const start = goText.indexOf(`type ${name} struct {`)
  if (start < 0) throw new Error(`Pinned source has no ${name} struct; review scripts/magpie-settings.mjs`)
  return goText.slice(start, goText.indexOf('\n}\n', start))
}

/** settings.Settings json tag → Go type, in struct order. */
export function settingsTags(goText) {
  const out = {}
  for (const match of structBody(goText, 'Settings').matchAll(/^\t([A-Z]\w*)\s+(\S+)\s+`json:"([^",]+)[^"]*"`/gm)) {
    if (out[match[3]]) throw new Error(`Settings repeats the tag ${match[3]}`)
    out[match[3]] = match[2]
  }
  if (!Object.keys(out).length) throw new Error('Settings has no json tags; review scripts/magpie-settings.mjs')
  return out
}

/** redact.Rule's fields and the limits CheckRules enforces. */
export function ruleLimits(rulesGo) {
  const fields = [...structBody(rulesGo, 'Rule').matchAll(/`json:"([^"]+)"`/g)].map(match => match[1])
  if (JSON.stringify(fields) !== JSON.stringify(['kind', 'prefix,omitempty', 'regex,omitempty'])) {
    throw new Error(`redact.Rule changed (${fields.join(' ')}); review the masking-rule editor`)
  }
  const constant = name => {
    const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(rulesGo)
    if (!match) throw new Error(`redact has no ${name}; review the masking-rule limits`)
    return Number(match[1])
  }
  return { maxRules: constant('MaxRules'), minPrefix: constant('minPrefix'), maxPrefix: constant('maxPrefix'),
    maxRegex: constant('maxRegex'), maxKind: constant('maxKind'), minMatch: constant('minCustomLen') }
}

/** The console's rows that settings.normal() now gives a default (or forces). */
function normalSets(settingsGo) {
  const start = settingsGo.indexOf('func (s Settings) normal()')
  if (start < 0) return []
  const body = settingsGo.slice(start, settingsGo.indexOf('\n}\n', start))
  return SETTINGS_ITEMS.map(item => item.key).filter(key => new RegExp(`\\bs\\.${key[0].toUpperCase()}${key.slice(1)}\\b`).test(body))
}

const sha256 = text => createHash('sha256').update(text).digest('hex')
const englishOf = item => ['name', 'sub', 'subOff', 'placeholder'].filter(field => item[field]).map(field => item[field])

/** Fail-closed section for catalog.json. zh: Map of i18n.js's zh table. */
export function buildSettings({ settingsGo, rulesGo, app, index, zh, evidence }) {
  const tags = settingsTags(settingsGo)
  const added = Object.keys(tags).filter(tag => !SETTINGS_CLASS[tag])
  const removed = Object.keys(SETTINGS_CLASS).filter(tag => !tags[tag])
  if (added.length || removed.length) {
    throw new Error(`Magpie's settings changed (new: ${added.join(',') || '-'}; gone: ${removed.join(',') || '-'}); classify them in SETTINGS_CLASS`)
  }
  for (const [file, needles] of Object.entries(SETTINGS_EVIDENCE)) {
    for (const needle of needles) {
      if (!evidence[file]?.includes(needle)) throw new Error(`${file} no longer reads ${needle}; the setting may not be gateway-effective`)
    }
  }
  const defaulted = normalSets(settingsGo)
  const translate = (en, where) => {
    if (!app.includes(JSON.stringify(en))) throw new Error(`Magpie no longer says "${en}" (${where}); review SETTINGS_ITEMS`)
    const value = zh.get(en)
    if (value === undefined) throw new Error(`Magpie has no zh text for "${en}" (${where})`)
    return { en, zh: value }
  }
  const items = SETTINGS_ITEMS.map(item => {
    if (tags[item.key] !== item.goType) throw new Error(`Setting ${item.key} is ${tags[item.key]}, not ${item.goType}; review its control`)
    if (defaulted.includes(item.key)) throw new Error(`settings.normal now sets ${item.key}; review its default`)
    const out = { key: item.key, group: item.group, control: item.control, class: SETTINGS_CLASS[item.key], default: item.default }
    for (const fieldName of ['name', 'sub', 'subOff', 'placeholder']) if (item[fieldName]) out[fieldName] = translate(item[fieldName], `${item.key}.${fieldName}`)
    return out
  })
  const groups = SETTINGS_GROUPS.map(group => {
    if (!index.includes(`data-t>${group.title}</span>`)) throw new Error(`Magpie's Settings has no ${group.title} group; review SETTINGS_GROUPS`)
    const value = zh.get(group.title)
    if (value === undefined) throw new Error(`Magpie has no zh text for the ${group.title} group`)
    return { id: group.id, title: { en: group.title, zh: value } }
  })
  return {
    keys: Object.fromEntries(Object.entries(tags).map(([tag, goType]) => [tag, { class: SETTINGS_CLASS[tag], goType }])),
    classes: SETTINGS_CLASSES,
    groups,
    items,
    copy: Object.fromEntries(Object.entries(SETTINGS_COPY).map(([id, en]) => [id, translate(en, `copy.${id}`)])),
    limits: { rules: ruleLimits(rulesGo), words: CONSOLE_WORD_LIMITS },
  }
}

/**
 * Lenient view of a candidate revision for the upstream check: never throws on drift, only reports it. Besides
 * tags, types and copy it reports the semantics buildSettings fails closed on — a gateway consumer that no longer
 * reads a setting, a default settings.normal() now sets, and any change to redact's rules.go (CheckRules, limits)
 * — so a candidate that turns a setting off or changes validation is never "no settings changes".
 */
export function settingsInventory({ settingsGo, app, rulesGo, evidence, rulesHash }) {
  const tags = settingsTags(settingsGo)
  const reworded = SETTINGS_ITEMS.filter(item => englishOf(item).some(en => !app.includes(JSON.stringify(en)))).map(item => item.key)
  const semantic = new Set(normalSets(settingsGo))
  if (evidence) {
    for (const [file, needles] of Object.entries(SETTINGS_EVIDENCE)) {
      if (needles.some(needle => !evidence[file]?.includes(needle))) EVIDENCE_KEYS[file].forEach(key => semantic.add(key))
    }
  }
  if (rulesGo !== undefined) {
    let shape = true
    try { ruleLimits(rulesGo) } catch { shape = false }
    if (!shape || (rulesHash && sha256(rulesGo) !== rulesHash)) semantic.add('redactRules')
  }
  return { tags, reworded: [...new Set([...reworded, ...semantic])] }
}

/** What a candidate changes against the committed catalog's settings section. */
export function compareSettings(baseline, inventory) {
  const before = baseline?.keys || {}
  const after = inventory.tags
  return {
    addedSettings: Object.keys(after).filter(tag => !before[tag]).sort(),
    removedSettings: Object.keys(before).filter(tag => !after[tag]).sort(),
    changedSettings: [...new Set([
      ...Object.keys(after).filter(tag => before[tag] && before[tag].goType !== after[tag]),
      ...inventory.reworded,
    ])].sort(),
  }
}

/** The settings drift of a checked-out candidate against deploy/magpie/catalog.json. */
export async function settingsDrift(checkout, catalogFile) {
  const committed = JSON.parse(await fs.readFile(catalogFile, 'utf8'))
  const read = relative => fs.readFile(path.join(checkout, relative), 'utf8')
  try {
    // a consumer file that is gone reads as empty: its settings are reported, not the whole check
    const evidence = Object.fromEntries(await Promise.all(Object.keys(SETTINGS_EVIDENCE).map(async file => [file, await read(file).catch(() => '')])))
    return compareSettings(committed.settings, settingsInventory({
      settingsGo: await read(SETTINGS_GO), app: await read('internal/gui/assets/app.js'),
      rulesGo: await read(RULES_GO).catch(() => ''), evidence, rulesHash: committed.source?.[RULES_GO],
    }))
  } catch {
    return { addedSettings: [], removedSettings: [], changedSettings: ['(settings source moved)'] }
  }
}
