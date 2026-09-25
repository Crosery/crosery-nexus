import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const backupId = process.env.BACKUP_ID
if (!/^\d{8}T\d{6}Z$/.test(backupId || '')) throw new Error('BACKUP_ID is invalid')
const destination = process.env.RESTORE_DESTINATION || '/restore'
const baseUrl = new URL(process.env.NAS2_URL || 'http://127.0.0.1:5005/NAS2/')
const credentials = JSON.parse(fs.readFileSync('/secrets/nas2-webdav.json', 'utf8'))
const authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`
const files = ['base.tar.gz', 'pg_wal.tar.gz', 'backup_manifest', 'SHA256SUMS', 'COMPLETED_AT_UTC']

function url(filename) {
  return new URL(`crosery-cpe-backups/base/${backupId}/${encodeURIComponent(filename)}`, baseUrl)
}
for (const filename of files) {
  const response = await fetch(url(filename), {
    headers: { Authorization: authorization },
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok || !response.body) throw new Error(`NAS download failed for ${filename}: HTTP ${response.status}`)
  const temporary = path.join(destination, `.${filename}.downloading`)
  const final = path.join(destination, filename)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o600 }))
  fs.renameSync(temporary, final)
  const hash = createHash('sha256').update(fs.readFileSync(final)).digest('hex')
  console.log(JSON.stringify({ event: 'nas.restore_file_downloaded', filename, bytes: fs.statSync(final).size, sha256: hash }))
}

const expected = new Map()
for (const line of fs.readFileSync(path.join(destination, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const match = line.match(/^([a-f0-9]{64})\s+\.?\/?(.+)$/)
  if (!match) throw new Error('downloaded SHA256SUMS is invalid')
  expected.set(match[2], match[1])
}
for (const filename of ['base.tar.gz', 'pg_wal.tar.gz', 'backup_manifest']) {
  const actual = createHash('sha256').update(fs.readFileSync(path.join(destination, filename))).digest('hex')
  if (expected.get(filename) !== actual) throw new Error(`restored checksum mismatch: ${filename}`)
}
console.log(JSON.stringify({ event: 'nas.restore_download_verified', backupId }))
