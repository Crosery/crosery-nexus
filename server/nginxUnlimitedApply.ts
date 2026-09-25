import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  parseNginxUnlimitedPolicyRequest,
  renderNginxUnlimitedInclude,
  type NginxUnlimitedPolicyRequest,
} from './nginxUnlimitedPolicy.js'
import type { NginxUnlimitedApplyStatus } from './nginxUnlimitedSync.js'

export type NginxUnlimitedApplyOptions = {
  policyPath: string
  statusPath: string
  includePath: string
  backupRoot: string
  now?: () => Date
  requiredPolicyUid?: number
  outputUid?: number
  outputGid?: number
  runNginxTest?: () => Promise<void>
  reloadNginx?: () => Promise<void>
}

type PreviousInclude = { existed: boolean; content: Buffer; mode: number; uid: number; gid: number }

function assertAbsolutePaths(options: NginxUnlimitedApplyOptions) {
  for (const [name, value] of Object.entries({
    policyPath: options.policyPath,
    statusPath: options.statusPath,
    includePath: options.includePath,
    backupRoot: options.backupRoot,
  })) {
    if (!path.isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`)
  }
}

function assertSecurePolicyFile(policyPath: string, requiredUid: number) {
  const metadata = fs.lstatSync(policyPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('nginx 不限速策略必须是普通文件')
  if (metadata.uid !== requiredUid) throw new Error('nginx 不限速策略所有者不符合要求')
  if ((metadata.mode & 0o077) !== 0) throw new Error('nginx 不限速策略权限必须禁止 group/other 访问')
}

function readPolicyRequest(policyPath: string, requiredUid: number): NginxUnlimitedPolicyRequest {
  assertSecurePolicyFile(policyPath, requiredUid)
  if (fs.statSync(policyPath).size > 512 * 1024) throw new Error('nginx 不限速策略文件过大')
  return parseNginxUnlimitedPolicyRequest(JSON.parse(fs.readFileSync(policyPath, 'utf8')))
}

function writeAtomic(filePath: string, content: string | Buffer, mode: number, uid: number, gid: number) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  fs.chownSync(directory, uid, gid)
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`)
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', mode)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, mode)
    fs.chownSync(filePath, uid, gid)
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch { /* preserve the original write error */ }
    throw error
  }
}

function previousInclude(includePath: string): PreviousInclude {
  try {
    const metadata = fs.lstatSync(includePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('nginx 不限速 include 必须是普通文件')
    return {
      existed: true,
      content: fs.readFileSync(includePath),
      mode: metadata.mode & 0o777,
      uid: metadata.uid,
      gid: metadata.gid,
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { existed: false, content: Buffer.alloc(0), mode: 0o600, uid: 0, gid: 0 }
    }
    throw error
  }
}

function restoreInclude(includePath: string, previous: PreviousInclude, uid: number, gid: number) {
  if (!previous.existed) {
    try { fs.unlinkSync(includePath) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    return
  }
  writeAtomic(includePath, previous.content, previous.mode, uid, gid)
  fs.chownSync(includePath, previous.uid, previous.gid)
}

function backupInclude(
  backupRoot: string,
  includePath: string,
  previous: PreviousInclude,
  now: Date,
  requestId: string,
  uid: number,
  gid: number,
) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const directory = path.join(backupRoot, `${timestamp}-${requestId}-nginx-unlimited-policy`)
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  fs.chmodSync(backupRoot, 0o700)
  fs.chownSync(backupRoot, uid, gid)
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  fs.chownSync(directory, uid, gid)
  if (previous.existed) {
    writeAtomic(path.join(directory, path.basename(includePath)), previous.content, 0o600, uid, gid)
  }
  writeAtomic(
    path.join(directory, 'metadata.json'),
    `${JSON.stringify({ previousExisted: previous.existed })}\n`,
    0o600,
    uid,
    gid,
  )
  return directory
}

function statusFor(
  request: NginxUnlimitedPolicyRequest,
  outcome: 'ok' | 'error',
  appliedAt: Date,
  errorCode?: string,
): NginxUnlimitedApplyStatus {
  return {
    version: 1,
    requestId: request.requestId,
    policyHash: request.policyHash,
    outcome,
    unlimitedKeyCount: request.unlimitedKeys.length,
    appliedAt: appliedAt.toISOString(),
    ...(errorCode ? { errorCode } : {}),
  }
}

function writeStatus(statusPath: string, status: NginxUnlimitedApplyStatus, uid: number, gid: number) {
  writeAtomic(statusPath, `${JSON.stringify(status)}\n`, 0o600, uid, gid)
}

export async function applyNginxUnlimitedPolicy(options: NginxUnlimitedApplyOptions) {
  assertAbsolutePaths(options)
  const now = options.now ?? (() => new Date())
  const outputUid = options.outputUid ?? 0
  const outputGid = options.outputGid ?? 0
  const request = readPolicyRequest(options.policyPath, options.requiredPolicyUid ?? 0)
  const rendered = renderNginxUnlimitedInclude(request)
  const current = previousInclude(options.includePath)
  if (current.existed && current.content.equals(Buffer.from(rendered))) {
    const status = statusFor(request, 'ok', now())
    writeStatus(options.statusPath, status, outputUid, outputGid)
    return { changed: false, backupDirectory: null, status }
  }

  const backupDirectory = backupInclude(
    options.backupRoot,
    options.includePath,
    current,
    now(),
    request.requestId,
    outputUid,
    outputGid,
  )
  const runNginxTest = options.runNginxTest ?? (async () => undefined)
  const reloadNginx = options.reloadNginx ?? (async () => undefined)
  try {
    writeAtomic(options.includePath, rendered, 0o600, outputUid, outputGid)
    await runNginxTest()
    await reloadNginx()
    const status = statusFor(request, 'ok', now())
    writeStatus(options.statusPath, status, outputUid, outputGid)
    return { changed: true, backupDirectory, status }
  } catch (error) {
    let rollbackError: unknown
    try {
      restoreInclude(options.includePath, current, outputUid, outputGid)
      await runNginxTest()
      await reloadNginx()
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure
    }
    const errorCode = rollbackError ? 'NGINX_UNLIMITED_ROLLBACK_FAILED' : 'NGINX_UNLIMITED_APPLY_FAILED'
    writeStatus(
      options.statusPath,
      statusFor(request, 'error', now(), errorCode),
      outputUid,
      outputGid,
    )
    throw new Error(errorCode, { cause: rollbackError ?? error })
  }
}
