import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { catalogPath } from './magpie-catalog.mjs'
import {
  buildSettings, compareSettings, settingsDrift, settingsInventory, SETTINGS_CLASS, SETTINGS_COPY, SETTINGS_EVIDENCE,
  SETTINGS_GROUPS, SETTINGS_ITEMS,
} from './magpie-settings.mjs'

const goType = tag => SETTINGS_ITEMS.find(item => item.key === tag)?.goType ?? 'string'
const field = tag => `\t${tag[0].toUpperCase()}${tag.slice(1)} ${goType(tag)} \`json:"${tag},omitempty"\``

function settingsGo({ extra = '', types = {}, normal = '' } = {}) {
  const fields = Object.keys(SETTINGS_CLASS).map(tag => types[tag] ? field(tag).replace(goType(tag), types[tag]) : field(tag))
  return `package settings\n\ntype Settings struct {\n${fields.join('\n')}\n${extra}}\n\nfunc (s Settings) normal() Settings {\n\tif s.Theme == "" {\n\t\ts.Theme = "system"\n\t}\n${normal}\treturn s\n}\n`
}
const RULES = 'type Rule struct {\n\tKind string `json:"kind"`\n\tPrefix string `json:"prefix,omitempty"`\n\tRegex string `json:"regex,omitempty"`\n}\n\nconst (\n\tMaxRules = 32\n\tmaxKind = 24\n\tmaxPrefix = 64\n\tminPrefix = 3\n\tmaxRegex = 300\n\tminCustomLen = 4\n)\n'
const english = () => [...SETTINGS_ITEMS.flatMap(item => ['name', 'sub', 'subOff', 'placeholder'].map(k => item[k]).filter(Boolean)), ...Object.values(SETTINGS_COPY)]
const app = (drop = '') => english().filter(en => en !== drop).map(en => `t(${JSON.stringify(en)});`).join('\n')
const INDEX = SETTINGS_GROUPS.map(group => `<span class="label" data-t>${group.title}</span>`).join('\n')
const zh = new Map([...english(), ...SETTINGS_GROUPS.map(group => group.title)].map(en => [en, `中:${en}`]))
const evidence = () => Object.fromEntries(Object.entries(SETTINGS_EVIDENCE).map(([file, needles]) => [file, needles.join('\n')]))
const build = (overrides = {}) => buildSettings({ settingsGo: settingsGo(), rulesGo: RULES, app: app(), index: INDEX, zh, evidence: evidence(), ...overrides })

test('buildSettings classifies every tag and carries the gateway rows with Magpie copy and limits', () => {
  const section = build()
  assert.equal(Object.keys(section.keys).length, Object.keys(SETTINGS_CLASS).length)
  assert.deepEqual(section.items.map(item => item.key), ['vision', 'imageGen', 'redact', 'redactPersonal', 'redactWords', 'redactRules', 'noStats'])
  assert.deepEqual(section.groups.map(group => group.title.zh), ['中:Images', '中:Privacy'])
  assert.equal(section.items.find(item => item.key === 'redactWords').placeholder.zh, '中:names, codenames, hosts')
  assert.equal(section.items.find(item => item.key === 'noStats').class, 'forced-off')
  assert.deepEqual(section.limits.rules, { maxRules: 32, minPrefix: 3, maxPrefix: 64, maxRegex: 300, maxKind: 24, minMatch: 4 })
})

test('drift fails closed: a new or removed tag, a type change, reworded copy, a moved consumer, a new default', () => {
  assert.throws(() => build({ settingsGo: settingsGo({ extra: '\tWebSearch bool `json:"webSearch,omitempty"`\n' }) }), /new: webSearch/)
  assert.throws(() => build({ settingsGo: settingsGo().replace(/^\tLang .*$/m, '') }), /gone: lang/)
  assert.throws(() => build({ settingsGo: settingsGo({ types: { redact: 'string' } }) }), /redact is string, not bool/)
  assert.throws(() => build({ app: app('Mask secrets') }), /no longer says "Mask secrets"/)
  assert.throws(() => build({ zh: new Map([...zh].filter(([en]) => en !== 'Masked words')) }), /no zh text for "Masked words"/)
  assert.throws(() => build({ evidence: { ...evidence(), 'internal/gateway/draw.go': '' } }), /draw.go no longer reads/)
  assert.throws(() => build({ settingsGo: settingsGo({ normal: '\ts.Redact = true\n' }) }), /normal now sets redact/)
  assert.throws(() => build({ rulesGo: RULES.replace('regex,omitempty', 'pattern,omitempty') }), /redact.Rule changed/)
  assert.throws(() => build({ index: '' }), /no Images group/)
})

test('the upstream check reports added, removed and changed settings without throwing', async () => {
  const baseline = build()
  const candidate = settingsInventory({
    settingsGo: settingsGo({ extra: '\tWebSearch bool `json:"webSearch,omitempty"`\n', types: { vision: '*string' } }).replace(/^\tWindow .*$/m, ''),
    app: app('Masked words'),
  })
  assert.deepEqual(compareSettings(baseline, candidate), { addedSettings: ['webSearch'], removedSettings: ['window'], changedSettings: ['redactWords', 'vision'] })
  assert.deepEqual(compareSettings(baseline, settingsInventory({ settingsGo: settingsGo(), app: app() })), { addedSettings: [], removedSettings: [], changedSettings: [] })
  const forcedOff = settingsInventory({ settingsGo: settingsGo({ normal: '\ts.Redact = false\n' }), app: app(), rulesGo: RULES, evidence: evidence() })
  assert.deepEqual(compareSettings(baseline, forcedOff), { addedSettings: [], removedSettings: [], changedSettings: ['redact'] })
  const reshaped = settingsInventory({ settingsGo: settingsGo(), app: app(), rulesGo: RULES.replace('regex,omitempty', 'pattern,omitempty'), evidence: evidence() })
  assert.deepEqual(compareSettings(baseline, reshaped).changedSettings, ['redactRules'])

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-settings-'))
  try {
    await fs.mkdir(path.join(dir, 'internal/settings'), { recursive: true })
    await fs.mkdir(path.join(dir, 'internal/gui/assets'), { recursive: true })
    await fs.writeFile(path.join(dir, 'internal/settings/settings.go'), settingsGo({ extra: '\tLowBalance bool `json:"lowBalance,omitempty"`\n' }))
    await fs.writeFile(path.join(dir, 'internal/gui/assets/app.js'), app())
    await fs.mkdir(path.join(dir, 'internal/redact'), { recursive: true })
    await fs.writeFile(path.join(dir, 'internal/redact/rules.go'), RULES)
    for (const [file, text] of Object.entries(evidence())) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
      await fs.writeFile(path.join(dir, file), text)
    }
    const rulesHash = createHash('sha256').update(RULES).digest('hex')
    await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify({ source: { 'internal/redact/rules.go': rulesHash }, settings: baseline }))
    assert.deepEqual(await settingsDrift(dir, path.join(dir, 'catalog.json')), { addedSettings: ['lowBalance'], removedSettings: [], changedSettings: [] })
    // semantics the build fails closed on are reported too, never an empty diff
    await fs.writeFile(path.join(dir, 'internal/redact/rules.go'), RULES.replace('maxRegex = 300', 'maxRegex = 3000'))
    await fs.writeFile(path.join(dir, 'internal/gateway/vision.go'), '')
    assert.deepEqual((await settingsDrift(dir, path.join(dir, 'catalog.json'))).changedSettings, ['redactRules', 'vision'])
    await fs.rm(path.join(dir, 'internal/gateway/redact.go'))
    assert.deepEqual((await settingsDrift(dir, path.join(dir, 'catalog.json'))).changedSettings, ['redact', 'redactPersonal', 'redactRules', 'redactWords', 'vision'])
    await fs.rm(path.join(dir, 'internal/settings'), { recursive: true })
    assert.deepEqual((await settingsDrift(dir, path.join(dir, 'catalog.json'))).changedSettings, ['(settings source moved)'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the committed catalog classifies every pinned setting and has zh copy for each gateway row', async () => {
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  assert.deepEqual(Object.keys(catalog.settings.keys).sort(), Object.keys(SETTINGS_CLASS).sort())
  for (const item of catalog.settings.items) {
    assert.ok(item.name.zh && item.name.zh !== item.name.en, `${item.key} zh name`)
    assert.ok(item.sub.zh && item.sub.zh !== item.sub.en, `${item.key} zh sub`)
  }
  assert.equal(catalog.settings.items.find(item => item.key === 'redact').name.zh, '脱敏密钥')
  assert.equal(catalog.settings.items.find(item => item.key === 'imageGen').name.zh, '生图模型')
})
