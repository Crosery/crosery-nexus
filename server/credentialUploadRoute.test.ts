import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

/**
 * The relay console imports CPA auth files in bulk (xAI batches of ~200 in one ZIP). Under the CPA engine the
 * upload route is back and reaches CPA's management API; files already on the gateway are skipped, not re-sent.
 */

const REPO = new URL('../', import.meta.url).pathname

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

const body = (request: IncomingMessage) => new Promise<Buffer>((resolve) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => resolve(Buffer.concat(chunks)))
})

test('CPA engine: a ZIP of auth files is uploaded to CPA, existing names are skipped', { timeout: 120_000 }, async () => {
  const uploads: string[] = []
  const cpa = createServer(async (request, response) => {
    const raw = await body(request)
    response.setHeader('content-type', 'application/json')
    const url = String(request.url)
    if (request.headers.authorization !== 'Bearer upload-test-key') {
      response.statusCode = 401
      return response.end('{}')
    }
    if (url.startsWith('/v0/management/auth-files') && request.method === 'GET') {
      return response.end(JSON.stringify({ files: [{ name: 'xai-existing.json', type: 'xai' }, ...uploads.map((name) => ({ name, type: 'xai' }))] }))
    }
    if (url === '/v0/management/auth-files' && request.method === 'POST') {
      const name = /filename="([^"]+)"/.exec(raw.toString('latin1'))?.[1] ?? ''
      uploads.push(name)
      return response.end(JSON.stringify({ status: 'ok' }))
    }
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'not stubbed' }))
  })
  await new Promise<void>((resolve) => cpa.listen(0, '127.0.0.1', resolve))
  const cpaPort = (cpa.address() as { port: number }).port

  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-upload-route-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin', CONSOLE_PASSWORD: 'correct-horse-battery', SESSION_SECRET: 'upload-route-secret',
      COOKIE_SECURE: 'false', GATEWAY_ENGINE: 'cpa',
      CPA_BASE_URL: `http://127.0.0.1:${cpaPort}`, CPA_MANAGEMENT_KEY: 'upload-test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout?.on('data', (chunk) => { logs += String(chunk) })
  child.stderr?.on('data', (chunk) => { logs += String(chunk) })
  const base = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; i < 125; i += 1) {
      try { if ((await fetch(`${base}/api/session`)).status < 500) break } catch { /* booting */ }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
    })
    assert.equal(login.status, 200, logs.slice(-400))
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]

    const zip = new AdmZip()
    for (const name of ['xai-one.json', 'xai-two.json', 'xai-existing.json']) {
      zip.addFile(name, Buffer.from(JSON.stringify({ type: 'xai', email: `${name}@example.test`, access_token: 'fixture-access', refresh_token: 'fixture-refresh' })))
    }
    const form = new FormData()
    form.set('file', new Blob([Uint8Array.from(zip.toBuffer())]), 'batch.zip')
    const upload = await fetch(`${base}/api/credentials/upload`, { method: 'POST', headers: { cookie }, body: form })
    const result = await upload.json() as { total: number; uploaded: number; skipped: number; failed: number }
    assert.equal(upload.status, 200, JSON.stringify(result))
    assert.deepEqual({ total: result.total, uploaded: result.uploaded, skipped: result.skipped, failed: result.failed }, { total: 3, uploaded: 2, skipped: 1, failed: 0 })
    assert.deepEqual(uploads.sort(), ['xai-one.json', 'xai-two.json'])
    assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh/, 'the response never echoes credential contents')

    const anonymous = await fetch(`${base}/api/credentials/upload`, { method: 'POST', body: form })
    assert.equal(anonymous.status, 401)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (child.exitCode === null) child.kill('SIGKILL')
    cpa.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
