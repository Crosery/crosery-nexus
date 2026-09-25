import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

const source = process.env.BACKUP_SOURCE || '/backup'
const backupId = path.basename(source)
if (!/^\d{8}T\d{6}Z$/.test(backupId)) throw new Error('backup source name must be a UTC backup id')
const baseUrl = new URL(process.env.NAS2_URL || 'http://127.0.0.1:5005/NAS2/')
if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('NAS2_URL must use HTTP(S)')
const credentials = JSON.parse(fs.readFileSync('/secrets/nas2-webdav.json', 'utf8'))
const authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`
const files = ['base.tar.gz', 'pg_wal.tar.gz', 'backup_manifest', 'SHA256SUMS', 'COMPLETED_AT_UTC']

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

function fileHash(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filename)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function remoteHash(relative) {
  const response = await request(relative, { method: 'GET' }, [200])
  const hash = createHash('sha256')
  for await (const chunk of Readable.fromWeb(response.body)) hash.update(chunk)
  return hash.digest('hex')
}

async function upload(filename) {
  const local = path.join(source, filename)
  const stat = fs.statSync(local)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid backup file: ${filename}`)
  const destination = `crosery-cpe-backups/base/${backupId}/${filename}`
  const temporary = `crosery-cpe-backups/base/${backupId}/.${filename}.uploading`
  const response = await request(temporary, {
    method: 'PUT',
    duplex: 'half',
    body: fs.createReadStream(local),
    headers: { 'Content-Length': String(stat.size), 'Content-Type': 'application/octet-stream' },
  }, [200, 201, 204])
  await response.body?.cancel()
  const localSha256 = await fileHash(local)
  const stagedSha256 = await remoteHash(temporary)
  if (localSha256 !== stagedSha256) throw new Error(`staged NAS checksum mismatch: ${filename}`)
  const moved = await request(temporary, {
    method: 'MOVE',
    headers: { Destination: remoteUrl(destination).href, Overwrite: 'F' },
  }, [201, 204])
  await moved.body?.cancel()
  const finalSha256 = await remoteHash(destination)
  if (localSha256 !== finalSha256) throw new Error(`published NAS checksum mismatch: ${filename}`)
  console.log(JSON.stringify({ event: 'nas.file_verified', filename, bytes: stat.size, sha256: localSha256 }))
}

await ensureCollection('crosery-cpe-backups')
await ensureCollection('crosery-cpe-backups/base')
await ensureCollection(`crosery-cpe-backups/base/${backupId}`)
for (const filename of files) await upload(filename)

const markerBody = Buffer.from(`${backupId}\n`)
const markerTemporary = 'crosery-cpe-backups/.LAST_VERIFIED_BASE_BACKUP.uploading'
const markerFinal = 'crosery-cpe-backups/LAST_VERIFIED_BASE_BACKUP'
let response = await request(markerTemporary, {
  method: 'PUT',
  body: markerBody,
  headers: { 'Content-Length': String(markerBody.length), 'Content-Type': 'text/plain' },
}, [200, 201, 204])
await response.body?.cancel()
response = await request(markerTemporary, {
  method: 'MOVE',
  headers: { Destination: remoteUrl(markerFinal).href, Overwrite: 'T' },
}, [201, 204])
await response.body?.cancel()
const marker = await request(markerFinal, { method: 'GET' }, [200])
if ((await marker.text()) !== markerBody.toString()) throw new Error('NAS backup marker verification failed')
console.log(JSON.stringify({ event: 'nas.backup_verified', backupId }))
