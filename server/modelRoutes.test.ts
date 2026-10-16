import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routes-'))
const { db } = await import('./db.js')
const { publishModelChannels } = await import('./modelRoutes.js')

const rows = () => db.prepare('SELECT rowid, model, rank, channel FROM relay_model_channels ORDER BY model, rank').all() as Array<{ rowid: number; model: string; rank: number; channel: string }>

test('model channels: whole-table publish in source order; an unchanged table is not rewritten', () => {
  publishModelChannels([{ model: 'gpt-6-sol', channels: ['codex', 'mox-aigw'] }, { model: 'deepseek-v4.1-flash', channels: ['commandcode', 'opencode-go'] }])
  const first = rows()
  assert.deepEqual(first.map((row) => [row.model, row.rank, row.channel]), [
    ['deepseek-v4.1-flash', 0, 'commandcode'], ['deepseek-v4.1-flash', 1, 'opencode-go'], ['gpt-6-sol', 0, 'codex'], ['gpt-6-sol', 1, 'mox-aigw'],
  ])
  publishModelChannels([{ model: 'deepseek-v4.1-flash', channels: ['commandcode', 'opencode-go'] }, { model: 'gpt-6-sol', channels: ['codex', 'mox-aigw'] }])
  assert.deepEqual(rows().map((row) => row.rowid), first.map((row) => row.rowid), 'same content → no write')
  publishModelChannels([{ model: 'gpt-6-sol', channels: ['mox-aigw'] }])
  assert.deepEqual(rows().map((row) => [row.model, row.rank, row.channel]), [['gpt-6-sol', 0, 'mox-aigw']])
})
