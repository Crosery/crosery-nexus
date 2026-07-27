import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import { config } from './config.js'
import { addAudit, db } from './db.js'
import { apiCall, getClaudeAccountMonitor, getCPAKeys, getModelAccess, groupForModel, hashKey, listAuthFiles, listModels, maskKey, putModelAccess, replaceCPAKeys } from './cpa.js'
import { isAuthenticated, login, logout, requireAuth } from './auth.js'
import { runSyncCycle, startSync } from './sync.js'
import { validatePolicy } from './policy.js'
import { buildNamedAPIKey, normalizeKeySlug, validateKeySlug } from './keyNaming.js'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

app.get('/api/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }))
app.post('/api/login', (req, res) => {
  try {
    if (!login(String(req.body?.password || ''), res)) return res.status(401).json({ error: '密码不正确' })
    addAudit('login', 'console')
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '登录失败' })
  }
})
app.post('/api/logout', (_req, res) => { logout(res); res.json({ ok: true }) })
app.use('/api', requireAuth)

const parseJson = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function publicKeyRow(row: Record<string, unknown>) {
  const value = String(row.key_value || '')
  return {
    id: row.key_hash,
    name: row.name,
    note: row.note,
    maskedKey: maskKey(value),
    enabled: Boolean(row.enabled),
    groups: parseJson(String(row.groups_json || '[]'), [] as string[]),
    totalConcurrency: row.total_concurrency,
    groupConcurrency: parseJson(String(row.group_concurrency_json || '{}'), {} as Record<string, number>),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }
}

app.get('/api/bootstrap', async (_req, res) => {
  await runSyncCycle()
  const keys = (db.prepare('SELECT * FROM api_keys ORDER BY enabled DESC, created_at DESC').all() as Array<Record<string, unknown>>).map(publicKeyRow)
  const models = await listModels()
  res.json({ keys, groups: config.groups, models, retentionDays: config.usageRetentionDays })
})

app.post('/api/keys', async (req, res) => {
  try {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: '请输入显示名称' })
  const slug = validateKeySlug(String(req.body?.slug || normalizeKeySlug(name)))
  const value = buildNamedAPIKey(slug, crypto.randomBytes(16).toString('hex'))
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : config.groups.map((item) => item.id)
  const totalConcurrency = req.body?.totalConcurrency === 0 ? 0 : Number(req.body?.totalConcurrency || 4)
  const groupConcurrency = typeof req.body?.groupConcurrency === 'object' ? req.body.groupConcurrency : {}
  validatePolicy({ enabled: true, groups, totalConcurrency, groupConcurrency })
  const cpaKeys = await getCPAKeys()
  await replaceCPAKeys([...cpaKeys, value])
  const allModels = await listModels()
  const allowedModels = allModels.filter((model) => groups.includes(groupForModel(model)))
  const access = await getModelAccess()
  access[value] = allowedModels
  await putModelAccess(access)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?,?)`)
    .run(hashKey(value), value, name, String(req.body?.note || ''), JSON.stringify(groups), totalConcurrency, JSON.stringify(groupConcurrency), now, now)
  addAudit('create_key', name, JSON.stringify({ slug, groups, totalConcurrency }))
  res.status(201).json({ key: value, item: publicKeyRow(db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(value)) as Record<string, unknown>) })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '创建失败' }) }
})

app.patch('/api/keys/:id', async (req, res) => {
  try {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Key 不存在' })
  const name = String(req.body?.name ?? row.name).trim()
  const note = String(req.body?.note ?? row.note)
  const enabled = req.body?.enabled === undefined ? Boolean(row.enabled) : Boolean(req.body.enabled)
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : parseJson(String(row.groups_json), [] as string[])
  const totalConcurrency = Number(req.body?.totalConcurrency ?? row.total_concurrency)
  const groupConcurrency = typeof req.body?.groupConcurrency === 'object' ? req.body.groupConcurrency : parseJson(String(row.group_concurrency_json), {})
  validatePolicy({ enabled, groups, totalConcurrency, groupConcurrency })
  const value = String(row.key_value)
  const keys = await getCPAKeys()
  const hasKey = keys.includes(value)
  if (enabled && !hasKey) await replaceCPAKeys([...keys, value])
  if (!enabled && hasKey) await replaceCPAKeys(keys.filter((key) => key !== value))
  const models = await listModels()
  const access = await getModelAccess()
  if (enabled) access[value] = models.filter((model) => groups.includes(groupForModel(model)))
  else delete access[value]
  await putModelAccess(access)
  const now = new Date().toISOString()
  db.prepare('UPDATE api_keys SET name=?,note=?,enabled=?,groups_json=?,total_concurrency=?,group_concurrency_json=?,updated_at=? WHERE key_hash=?')
    .run(name, note, enabled ? 1 : 0, JSON.stringify(groups), totalConcurrency, JSON.stringify(groupConcurrency), now, req.params.id)
  addAudit('update_key', name, JSON.stringify({ enabled, groups, totalConcurrency }))
  res.json({ item: publicKeyRow(db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown>) })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '保存失败' }) }
})

app.delete('/api/keys/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Key 不存在' })
  const value = String(row.key_value)
  await replaceCPAKeys((await getCPAKeys()).filter((key) => key !== value))
  const access = await getModelAccess(); delete access[value]; await putModelAccess(access)
  db.prepare('DELETE FROM api_keys WHERE key_hash = ?').run(req.params.id)
  addAudit('delete_key', String(row.name))
  res.json({ ok: true })
})

app.get('/api/analytics', (req, res) => {
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 7)))
  const keyId = String(req.query.keyId || '')
  const where = keyId ? 'timestamp >= datetime(\'now\', ?) AND key_hash = ?' : 'timestamp >= datetime(\'now\', ?)'
  const params = keyId ? [`-${days} days`, keyId] : [`-${days} days`]
  const summary = db.prepare(`SELECT COUNT(*) requests, COALESCE(SUM(total_tokens),0) tokens, COALESCE(AVG(latency_ms),0) avgLatency, COALESCE(AVG(CASE WHEN success=0 THEN 1.0 ELSE 0 END),0) errorRate FROM usage_events WHERE ${where}`).get(...params)
  const trend = db.prepare(`SELECT substr(timestamp,1,13) bucket, COUNT(*) requests, SUM(total_tokens) tokens, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) errors FROM usage_events WHERE ${where} GROUP BY bucket ORDER BY bucket`).all(...params)
  const groups = db.prepare(`SELECT model_group name, COUNT(*) requests, SUM(total_tokens) tokens FROM usage_events WHERE ${where} GROUP BY model_group ORDER BY requests DESC`).all(...params)
  const models = db.prepare(`SELECT model name, COUNT(*) requests, SUM(total_tokens) tokens FROM usage_events WHERE ${where} GROUP BY model ORDER BY requests DESC LIMIT 8`).all(...params)
  const keyUsage = db.prepare(`SELECT a.key_hash id, a.name, COUNT(u.id) requests, COALESCE(SUM(u.total_tokens),0) tokens, COALESCE(AVG(CASE WHEN u.success=0 THEN 1.0 ELSE 0 END),0) errorRate FROM api_keys a LEFT JOIN usage_events u ON u.key_hash=a.key_hash AND u.timestamp >= datetime('now', ?) GROUP BY a.key_hash ORDER BY requests DESC`).all(`-${days} days`)
  res.json({ days, summary, trend, groups, models, keyUsage })
})

app.get('/api/monitor', async (_req, res) => {
  const auths = await listAuthFiles()
  const accounts = await Promise.all((auths.files || []).filter((file) => ['claude', 'codex'].includes(String(file.type))).map(async (file) => {
    const type = String(file.type)
    let quota: unknown = null
    try {
      if (type === 'claude') {
        const result = await getClaudeAccountMonitor(String(file.auth_index))
        const parseResult = (response: typeof result.usage) => {
          const body = response.body ?? response.body_text
          const parsedBody = typeof body === 'string' ? JSON.parse(body) : body
          const statusCode = Number(response.status_code ?? response.statusCode ?? 0)
          if (statusCode < 200 || statusCode >= 300) throw new Error(`上游返回 HTTP ${statusCode}`)
          return parsedBody
        }
        quota = { usage: parseResult(result.usage), profile: parseResult(result.profile) }
      } else {
        const result = await apiCall(String(file.auth_index), 'https://chatgpt.com/backend-api/wham/usage')
        const body = result.body ?? result.body_text
        const parsedBody = typeof body === 'string' ? JSON.parse(body) : body
        const statusCode = Number(result.status_code ?? result.statusCode ?? 0)
        if (statusCode < 200 || statusCode >= 300) throw new Error(`上游返回 HTTP ${statusCode}`)
        quota = parsedBody
      }
    } catch (error) {
      quota = { error: error instanceof Error ? error.message : '读取失败' }
    }
    return { ...file, quota }
  }))
  res.json({ accounts })
})

app.get('/api/audit', (_req, res) => res.json({ items: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all() }))

const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(root, '../dist')
app.use(express.static(dist, { maxAge: '1h' }))
app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')))

startSync()
app.listen(config.port, config.host, () => console.log(`Crosery API Console listening on http://${config.host}:${config.port}`))
