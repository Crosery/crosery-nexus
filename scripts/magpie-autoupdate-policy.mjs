// Auto-update policy for the console's Magpie kernel: which upstream changes the console can take unattended,
// the quiet window, and the config the console writes. Pure functions only; the pipeline is magpie-autoupdate.mjs.

/**
 * Upstream routes the console depends on. A removed or changed one stops an auto-update (fail closed).
 * - inference: the admission adapter's routes (server/magpieEngine.ts admissionRoutes); POSTs are forwarded to the kernel.
 * - management: the GUI handlers the kernel overlay mirrors under /internal/* (deploy/magpie/kernel), so their
 *   behaviour reaches the console through provider.* / library.* / settings.*.
 */
export const CONSOLE_ROUTES = [
  'inference GET /v1/models', 'inference GET /v1beta/models',
  'inference POST /v1/chat/completions', 'inference POST /v1/responses',
  'inference POST /v1/messages', 'inference POST /v1/messages/count_tokens',
  'inference POST /v1beta/models/{call...}',
  'management POST /api/signin', 'management GET /api/signin/{id}',
  'management POST /api/signin/{id}/callback', 'management POST /api/signin/{id}/cancel',
  'management POST /api/login/{action}', 'management GET /api/login/usage', 'management POST /api/usage/codex-reset',
  'management GET /api/library/rtk', 'management POST /api/library/rtk',
  'management GET /api/settings', 'management POST /api/settings', 'management POST /api/settings/redact-rules',
]

/** Types the kernel overlay passes through to the console verbatim (also reached from CONSOLE_ROUTES). */
export const CONSOLE_SCHEMAS = [
  'provider.SignInState', 'provider.Login', 'provider.Exclusion', 'provider.SubscriptionQuota', 'provider.ResetOutcome',
  'library.RTKView', 'redact.Rule',
]

export const DEFAULT_WINDOW = Object.freeze({ start: '03:00', end: '06:00' })
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

const routeId = route => `${route.surface} ${route.method} ${route.path}`

function walkSchema(schema, schemas, seen) {
  if (!schema || typeof schema !== 'object') return
  if (schema.kind === 'ref' && typeof schema.ref === 'string') {
    if (seen.has(schema.ref)) return
    seen.add(schema.ref)
    walkSchema(schemas?.[schema.ref], schemas, seen)
    return
  }
  if (schema.items) walkSchema(schema.items, schemas, seen)
  for (const field of Array.isArray(schema.fields) ? schema.fields : []) walkSchema(field.type, schemas, seen)
}

/** Every schema name a set of routes reaches (request shapes and response types, transitively). */
export function schemaClosure(contract, routeIds = CONSOLE_ROUTES, roots = CONSOLE_SCHEMAS) {
  const wanted = new Set(routeIds)
  const seen = new Set()
  const add = name => { if (!seen.has(name)) { seen.add(name); walkSchema(contract.schemas?.[name], contract.schemas, seen) } }
  for (const route of contract.routes || []) {
    if (!wanted.has(routeId(route))) continue
    walkSchema(route.request, contract.schemas, seen)
    for (const name of route.responseTypes || []) add(name)
  }
  for (const name of roots) if (contract.schemas?.[name]) add(name)
  return seen
}

const list = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
const preview = (items, limit = 3) => `${items.slice(0, limit).join('、')}${items.length > limit ? ` 等 ${items.length} 项` : ''}`

/**
 * Breaking-change classifier. `diff` is compareContracts(baseline, candidate) plus settingsDrift; `catalogDrift` is
 * compareCatalogs(committed, candidate) or `{ error }` when the candidate's catalog cannot be generated.
 * Additive routes are fine; anything the console reads that moved, and any login-agent / catalog / settings drift, stops.
 */
export function classifyCandidate({ baseline, candidate, diff, catalogDrift }) {
  const reasons = []
  if (baseline?.version !== 1 || candidate?.version !== 1) {
    return { eligible: false, reasons: [{ code: 'contract-version', text: '契约格式不认识', items: [] }] }
  }
  const used = new Set(CONSOLE_ROUTES)
  const candidateIds = new Set((candidate.routes || []).map(routeId))
  const removed = [...new Set([...list(diff?.removedRoutes).filter(id => used.has(id)), ...CONSOLE_ROUTES.filter(id => !candidateIds.has(id))])].sort()
  if (removed.length) reasons.push({ code: 'route-removed', text: `控制台在用的接口被移除：${preview(removed)}`, items: removed })
  const changed = list(diff?.changedRoutes).filter(id => used.has(id))
  if (changed.length) reasons.push({ code: 'route-changed', text: `控制台在用的接口变了：${preview(changed)}`, items: changed })
  const schemas = new Set([...schemaClosure(baseline), ...schemaClosure(candidate)])
  const schemaChanged = list(diff?.changedSchemas).filter(name => schemas.has(name))
  if (schemaChanged.length) reasons.push({ code: 'schema-changed', text: `控制台在用的数据结构变了：${preview(schemaChanged)}`, items: schemaChanged })
  const added = list(diff?.addedLoginAgents)
  const gone = list(diff?.removedLoginAgents)
  if (added.length || gone.length) {
    const parts = [added.length ? `新增 ${added.join('、')}` : '', gone.length ? `移除 ${gone.join('、')}` : ''].filter(Boolean)
    reasons.push({ code: 'login-agents', text: `登录方式变了：${parts.join(' · ')}`, items: [...added.map(id => `+${id}`), ...gone.map(id => `-${id}`)] })
  }
  if (catalogDrift?.error) {
    reasons.push({ code: 'catalog-drift', text: `账号目录生成不了：${String(catalogDrift.error).slice(0, 120)}`, items: [] })
  } else if (catalogDrift) {
    const groups = [
      ['新增', catalogDrift.addedAgents], ['移除', catalogDrift.removedAgents], ['登录方式变化', catalogDrift.signinChanged],
      ['风险提示变化', catalogDrift.riskChanged], ['条目变化', catalogDrift.changedAgents], ['文案变化', catalogDrift.copyChanged],
    ].map(([word, items]) => [word, list(items)]).filter(([, items]) => items.length)
    if (groups.length) {
      reasons.push({
        code: 'catalog-drift',
        text: `账号目录有变化：${groups.map(([word, items]) => `${word} ${preview(items, 2)}`).join(' · ')}`,
        items: groups.flatMap(([word, items]) => items.map(item => `${word} ${item}`)),
      })
    }
  }
  const settingsAdded = list(diff?.addedSettings)
  const settingsRemoved = list(diff?.removedSettings)
  const settingsChanged = [...new Set([...list(diff?.changedSettings), ...list(catalogDrift?.settingsCopyChanged)])]
  if (settingsAdded.length || settingsRemoved.length || settingsChanged.length) {
    const parts = [
      settingsAdded.length ? `新增 ${settingsAdded.length} 项` : '', settingsRemoved.length ? `移除 ${preview(settingsRemoved, 2)}` : '',
      settingsChanged.length ? `变化 ${preview(settingsChanged, 2)}` : '',
    ].filter(Boolean)
    reasons.push({ code: 'settings-drift', text: `网关设置有变化：${parts.join(' · ')}`, items: [...settingsAdded.map(k => `+${k}`), ...settingsRemoved.map(k => `-${k}`), ...settingsChanged.map(k => `~${k}`)] })
  }
  const known = new Set((baseline.diagnostics || []).map(item => JSON.stringify(item)))
  const fresh = (candidate.diagnostics || []).filter(item => !known.has(JSON.stringify(item)))
  if (fresh.length) reasons.push({ code: 'diagnostics', text: `新契约有 ${fresh.length} 处形状证明不了`, items: fresh.map(item => JSON.stringify(item).slice(0, 200)) })
  return { eligible: reasons.length === 0, reasons }
}

/* ── quiet window ───────────────────────────────────────────────────── */

export function parseWindow(value) {
  const start = HHMM.exec(String(value?.start ?? ''))
  const end = HHMM.exec(String(value?.end ?? ''))
  if (!start || !end || value.start === value.end) return null
  return { start: value.start, end: value.end }
}

const minutesOf = text => { const [, h, m] = HHMM.exec(text); return Number(h) * 60 + Number(m) }

/** Local wall-clock window; `end` before `start` wraps past midnight. */
export function windowState(now, window = DEFAULT_WINDOW) {
  const at = new Date(now)
  const minute = at.getHours() * 60 + at.getMinutes()
  const start = minutesOf(window.start)
  const end = minutesOf(window.end)
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end
  const next = new Date(at)
  next.setSeconds(0, 0)
  next.setHours(Math.floor(start / 60), start % 60)
  if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1)
  return { inside, nextStart: next.getTime(), label: `${window.start}–${window.end}` }
}

/* ── config (written by the console, read by the scheduled job) ─────── */

/** Missing file or field = ON: the owner chose「安全自动更新」as the default. */
export function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    version: 1,
    magpie: { enabled: value.magpie?.enabled !== false, window: parseWindow(value.magpie?.window) ?? { ...DEFAULT_WINDOW } },
    rtk: { enabled: value.rtk?.enabled !== false },
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

/** Numeric dotted-version compare; `v` prefix and pre-release tails ignored. */
export function compareVersions(left, right) {
  const parts = value => String(value).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff) return diff
  }
  return 0
}
