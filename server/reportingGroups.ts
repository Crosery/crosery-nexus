import type { DatabaseSync } from 'node:sqlite'

import type { ConsoleGroup } from './groups.js'

const SETTING_KEY = 'reporting.groups.lastKnown.v1'
const MAX_GROUPS = 128
const MAX_MODELS_PER_GROUP = 2_048

type StoredGroups = {
  version: 1
  generatedAt: string
  groups: ConsoleGroup[]
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maxLength ? text : null
}

export function parseStoredReportingGroups(value: unknown): StoredGroups | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.version !== 1 || typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt))) return null
  if (!Array.isArray(input.groups) || input.groups.length > MAX_GROUPS) return null
  const groups: ConsoleGroup[] = []
  for (const item of input.groups) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const group = item as Record<string, unknown>
    const id = boundedText(group.id, 128)
    const name = boundedText(group.name, 256)
    const color = boundedText(group.color, 64)
    if (!id || !name || !color || (group.kind !== 'compat' && group.kind !== 'oauth')) return null
    if (!Array.isArray(group.models) || group.models.length > MAX_MODELS_PER_GROUP) return null
    const models: string[] = []
    for (const model of group.models) {
      const parsed = boundedText(model, 256)
      if (!parsed) return null
      models.push(parsed)
    }
    groups.push({ id, name, color, kind: group.kind, models: [...new Set(models)].sort() })
  }
  return { version: 1, generatedAt: new Date(input.generatedAt).toISOString(), groups }
}

export class ReportingGroupStore {
  constructor(private readonly database: DatabaseSync, private readonly now: () => number = Date.now) {}

  read(): StoredGroups | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as { value?: string } | undefined
    if (!row?.value) return null
    try { return parseStoredReportingGroups(JSON.parse(row.value)) } catch { return null }
  }

  write(groups: ConsoleGroup[]): StoredGroups {
    const stored = parseStoredReportingGroups({ version: 1, generatedAt: new Date(this.now()).toISOString(), groups })
    if (!stored) throw new Error('reporting groups are invalid')
    this.database.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SETTING_KEY, JSON.stringify(stored))
    return stored
  }
}
