import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import express from 'express'
import { createPulseReader, PULSE_LAG_SEC, PULSE_WINDOW_SEC, registerPulseRoutes } from './pulseRoutes.js'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE usage_events (id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, success INTEGER NOT NULL, latency_ms INTEGER NOT NULL)')
  const insert = db.prepare('INSERT INTO usage_events (timestamp_ms, success, latency_ms) VALUES (?, ?, ?)')
  return { db, add: (ms: number, success: boolean, latency = 100) => insert.run(ms, success ? 1 : 0, latency) }
}

const NOW = Date.UTC(2026, 9, 2, 6, 30, 0, 500)
const END_SEC = Math.floor(NOW / 1000) - PULSE_LAG_SEC

test('pulse: one zero-filled sample per second for the window, oldest first, ending before the ingest lag', () => {
  const { db, add } = fixture()
  add(END_SEC * 1000 + 10, true)
  add(END_SEC * 1000 + 900, false)
  add((END_SEC - 5) * 1000, true)
  add((END_SEC + 1) * 1000, true) // inside the lag: not drawn yet
  const pulse = createPulseReader(db, () => NOW).read()
  assert.equal(pulse.samples.length, PULSE_WINDOW_SEC)
  assert.equal(pulse.samples.at(-1)?.t, END_SEC * 1000)
  assert.deepEqual(pulse.samples.at(-1), { t: END_SEC * 1000, rps: 2, err: 1 })
  assert.deepEqual(pulse.samples.at(-6), { t: (END_SEC - 5) * 1000, rps: 1, err: 0 })
  assert.equal(pulse.samples.filter((s) => s.rps > 0).length, 2)
  assert.ok(pulse.samples.every((s, i, all) => i === 0 || s.t - all[i - 1].t === 1000))
})

test('pulse: rpm, success rate and p95 over the last 5 minutes; empty window is null, never a fake 0%', () => {
  const empty = createPulseReader(fixture().db, () => NOW).read()
  assert.equal(empty.successRate, null)
  assert.equal(empty.p95Ms, null)
  assert.equal(empty.rpm, 0)

  const { db, add } = fixture()
  for (let i = 1; i <= 20; i += 1) add(END_SEC * 1000 - i * 1000, true, i * 100)
  add(END_SEC * 1000 - 30_000, false, 99_999)
  add(END_SEC * 1000 - 6 * 60_000, true, 1) // older than 5 minutes
  const pulse = createPulseReader(db, () => NOW).read()
  assert.equal(pulse.rpm, Math.round((21 / 5) * 10) / 10)
  assert.equal(pulse.successRate, 20 / 21)
  // nearest-rank p95 of 100…2000 (20 successes) = 19th value; failures never count toward latency
  assert.equal(pulse.p95Ms, 1900)
})

test('pulse: one computation per second is shared by every caller', () => {
  const { db, add } = fixture()
  let clock = NOW
  const reader = createPulseReader(db, () => clock)
  const first = reader.read()
  add(END_SEC * 1000, true)
  assert.equal(reader.read(), first, 'within the same second the cached payload is returned')
  clock += 1_000
  assert.notEqual(reader.read(), first)
})

test('pulse: latency 0 is "not reported" — p95 ranks only measured successes; all unreported → null', () => {
  const { db, add } = fixture()
  for (let i = 1; i <= 19; i += 1) add(END_SEC * 1000 - i * 1000, true, 0)
  add(END_SEC * 1000 - 25_000, true, 1_000)
  const pulse = createPulseReader(db, () => NOW).read()
  assert.equal(pulse.p95Ms, 1_000)
  assert.equal(pulse.successRate, 1, 'unreported latency still counts as a success')
  assert.equal(pulse.rpm, Math.round((20 / 5) * 10) / 10)

  const blind = fixture()
  for (let i = 1; i <= 5; i += 1) blind.add(END_SEC * 1000 - i * 1000, true, 0)
  assert.equal(createPulseReader(blind.db, () => NOW).read().p95Ms, null)
})

test('pulse route: a read failure answers 503 with fixed text, never the DB message', async () => {
  const { db } = fixture()
  const app = express()
  registerPulseRoutes(app, db)
  db.exec('DROP TABLE usage_events')
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const warn = console.warn
  console.warn = () => {}
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/pulse`)
    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { error: '实时脉搏暂不可用', code: 'pulse_unavailable' })
  } finally {
    console.warn = warn
    await new Promise((resolve) => server.close(resolve))
  }
})
