import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

const source = process.env.WAL_SOURCE || '/wal'
const baseUrl = new URL(process.env.NAS2_URL || 'http://127.0.0.1:5005/NAS2/')
const credentials = JSON.parse(fs.readFileSync('/secrets/nas2-webdav.json', 'utf8'))
const authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`
const archiveName = /^([0-9A-F]{24}|[0-9A-F]{8}\.history|[0-9A-F]{24}\.[0-9A-F]{8}\.backup)$/

function remoteUrl(relative) {
  return new URL(relative.split('/').map(encodeURIComponent).join('/'), baseUrl)
}
async function request(relative, options, expected) {
  const response = await fetch(remoteUrl(relative), {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60_000),
    headers: { Authorization: authorization, ...(options.headers || {}) },
  })
  if (!expected.includes(response.status)) {
    await response.body?.cancel()
    throw new Error(`${options.method} ${relative} returned HTTP ${response.status}`)
  }
  return response
}
async function ensureCollection(relative) {
  const response = await request(relative, { method: 'MKCOL' }, [201, 405])
  await response.body?.cancel()
}
function localHash(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filename)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
async function remoteHash(relative, allowMissing = false) {
  const response = await request(relative, { method: 'GET' }, allowMissing ? [200, 404] : [200])
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  const hash = createHash('sha256')
  for await (const chunk of Readable.fromWeb(response.body)) hash.update(chunk)
  return hash.digest('hex')
}

async function remoteText(relative, allowMissing = false) {
  const response = await request(relative, { method: 'GET' }, allowMissing ? [200, 404] : [200])
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  return response.text()
}

const names = fs.readdirSync(source).filter((name) => archiveName.test(name)).sort()
if (names.length === 0) throw new Error('no PostgreSQL WAL archives found')
await ensureCollection('crosery-cpe-backups')
await ensureCollection('crosery-cpe-backups/wal')
const previousMarker = await remoteText('crosery-cpe-backups/LAST_VERIFIED_WAL_COPY', true)
const previousLatest = previousMarker?.trim().split(/\s+/u).at(-1) || null
if (previousLatest !== null && !/^[0-9A-F]{24}$/.test(previousLatest)) {
  throw new Error('existing NAS WAL marker is invalid')
}
let copied = 0
let skipped = 0
for (const name of names) {
  const local = path.join(source, name)
  const stat = fs.statSync(local)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid WAL archive: ${name}`)
  const destination = `crosery-cpe-backups/wal/${name}`
  if (/^[0-9A-F]{24}$/.test(name) && previousLatest !== null && name <= previousLatest) {
    skipped += 1
    continue
  }
  const expectedSha256 = await localHash(local)
  const existingSha256 = await remoteHash(destination, true)
  if (existingSha256 !== null) {
    if (existingSha256 !== expectedSha256) throw new Error(`existing NAS WAL mismatch: ${name}`)
    skipped += 1
    continue
  }
  const temporary = `crosery-cpe-backups/wal/.${name}.uploading`
  let response = await request(temporary, {
    method: 'PUT',
    duplex: 'half',
    body: fs.createReadStream(local),
    headers: { 'Content-Length': String(stat.size), 'Content-Type': 'application/octet-stream' },
  }, [200, 201, 204])
  await response.body?.cancel()
  if (await remoteHash(temporary) !== expectedSha256) throw new Error(`staged NAS WAL mismatch: ${name}`)
  response = await request(temporary, {
    method: 'MOVE',
    headers: { Destination: remoteUrl(destination).href, Overwrite: 'F' },
  }, [201, 204])
  await response.body?.cancel()
  if (await remoteHash(destination) !== expectedSha256) throw new Error(`published NAS WAL mismatch: ${name}`)
  copied += 1
  if (copied % 20 === 0) console.log(JSON.stringify({ event: 'nas.wal_progress', copied, total: names.length }))
}

const latest = [...names].reverse().find((name) => /^[0-9A-F]{24}$/.test(name))
if (!latest) throw new Error('no WAL segment was verified')
const markerBody = Buffer.from(`${new Date().toISOString()}\t${latest}\n`)
const temporary = 'crosery-cpe-backups/.LAST_VERIFIED_WAL_COPY.uploading'
const final = 'crosery-cpe-backups/LAST_VERIFIED_WAL_COPY'
let response = await request(temporary, {
  method: 'PUT', body: markerBody,
  headers: { 'Content-Length': String(markerBody.length), 'Content-Type': 'text/plain' },
}, [200, 201, 204])
await response.body?.cancel()
response = await request(temporary, {
  method: 'MOVE', headers: { Destination: remoteUrl(final).href, Overwrite: 'T' },
}, [201, 204])
await response.body?.cancel()
const marker = await request(final, { method: 'GET' }, [200])
if ((await marker.text()) !== markerBody.toString()) throw new Error('NAS WAL marker verification failed')
console.log(JSON.stringify({ event: 'nas.wal_verified', copied, skipped, total: names.length, latest }))
