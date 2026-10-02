import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Finds the mihomo binary the console may run (PROXY-SPEC §4 "Binary").
 *
 * Lookup order: `MIHOMO_BIN`, then Clash Party's bundled stable `sidecar/mihomo` (darwin only; never `-alpha`/`-smart`),
 * then `mihomo` / `clash-meta` on PATH. An explicit but unusable `MIHOMO_BIN` is reported, not silently skipped.
 *
 * Copy rule: the bundled file is `root:admin 6755` [verified], so executing it in place would run it as root. Any
 * setuid/setgid source, or any file inside a `.app`, is copied to `<dir>/bin/mihomo` (0700, owned by us) and that copy is
 * what runs; the copy is refreshed when the source's sha256 changes. A plain binary runs in place. `-v` only ever runs on
 * the binary that will actually be executed.
 */

export const CLASH_PARTY_MIHOMO = '/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo'
export const MIN_MIHOMO_VERSION: readonly [number, number] = [1, 19]

export type MihomoBinarySource = 'env' | 'bundle' | 'path'

export type MihomoBinary =
  | { ok: true; source: MihomoBinarySource; sourcePath: string; runPath: string; copied: boolean; version: string }
  | { ok: false; reason: string }

export type ResolveMihomoOptions = {
  /** Kernel directory (`DATA_DIR/proxy/mihomo`); copies go to `<dir>/bin/`. */
  dir: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Test override for the Clash Party bundle path. */
  bundlePath?: string
  /** Test override for `<bin> -v`. */
  readVersion?: (bin: string) => Promise<string>
}

type SourceMeta = { sourcePath: string; size: number; mtimeMs: number; sha256: string }

export function parseMihomoVersion(output: string): string | null {
  const match = /Mihomo(?: Meta)?\s+v?(\d+)\.(\d+)\.(\d+)/i.exec(String(output))
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

export function versionSupported(version: string): boolean {
  const [major, minor] = version.split('.').map(Number)
  return major > MIN_MIHOMO_VERSION[0] || (major === MIN_MIHOMO_VERSION[0] && minor >= MIN_MIHOMO_VERSION[1])
}

export function defaultReadVersion(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-v'], { timeout: 5_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }, (error, stdout) => {
      if (error) reject(new Error('mihomo -v 执行失败'))
      else resolve(String(stdout))
    })
  })
}

function isExecutableFile(file: string): fs.Stats | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    fs.accessSync(file, fs.constants.X_OK)
    return stat
  } catch {
    return null
  }
}

function findOnPath(env: NodeJS.ProcessEnv): string | null {
  for (const name of ['mihomo', 'clash-meta']) {
    for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
      if (!dir || !path.isAbsolute(dir)) continue
      const candidate = path.join(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

export function needsCopy(file: string, stat: fs.Stats): boolean {
  return (stat.mode & 0o6000) !== 0 || /\.app(\/|$)/.test(path.resolve(file))
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).once('end', resolve).once('error', reject)
  })
  return hash.digest('hex')
}

function readMeta(file: string): SourceMeta | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as SourceMeta
    return value && typeof value.sha256 === 'string' && typeof value.sourcePath === 'string' ? value : null
  } catch {
    return null
  }
}

/** Copies `source` to `<dir>/bin/mihomo` (0700) unless an identical copy is already there. */
export async function ensureCopy(source: string, dir: string): Promise<string> {
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(binDir, 0o700)
  const target = path.join(binDir, 'mihomo')
  const metaFile = path.join(binDir, 'source.json')
  const stat = fs.statSync(source)
  const meta = readMeta(metaFile)
  const copyOk = (() => {
    try {
      const copy = fs.lstatSync(target)
      return copy.isFile() && (copy.mode & 0o7777) === 0o700
    } catch {
      return false
    }
  })()
  if (copyOk && meta && meta.sourcePath === source && meta.size === stat.size && meta.mtimeMs === stat.mtimeMs) return target
  const sha256 = await sha256File(source)
  if (copyOk && meta && meta.sha256 === sha256 && (await sha256File(target)) === sha256) {
    fs.writeFileSync(metaFile, JSON.stringify({ sourcePath: source, size: stat.size, mtimeMs: stat.mtimeMs, sha256 }), { mode: 0o600 })
    return target
  }
  const temporary = `${target}.${process.pid}.tmp`
  fs.rmSync(temporary, { force: true })
  // copyFile never carries setuid/setgid to a file we own; chmod pins the mode regardless.
  fs.copyFileSync(source, temporary)
  fs.chmodSync(temporary, 0o700)
  fs.renameSync(temporary, target)
  fs.writeFileSync(metaFile, JSON.stringify({ sourcePath: source, size: stat.size, mtimeMs: stat.mtimeMs, sha256 }), { mode: 0o600 })
  return target
}

export type LocatedMihomo =
  | { ok: true; source: MihomoBinarySource; sourcePath: string; needsCopy: boolean }
  | { ok: false; reason: string }

/** Finds the source binary without copying or executing anything (cheap; safe at every console boot). */
export function locateMihomoBinary(options: Omit<ResolveMihomoOptions, 'dir' | 'readVersion'> = {}): LocatedMihomo {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  let source: MihomoBinarySource
  let sourcePath: string | null
  const explicit = String(env.MIHOMO_BIN ?? '').trim()
  if (explicit) {
    if (!path.isAbsolute(explicit) || !isExecutableFile(explicit)) return { ok: false, reason: 'MIHOMO_BIN 不是可执行文件的绝对路径' }
    source = 'env'
    sourcePath = explicit
  } else {
    const bundle = options.bundlePath ?? CLASH_PARTY_MIHOMO
    if (platform === 'darwin' && isExecutableFile(bundle)) {
      source = 'bundle'
      sourcePath = bundle
    } else {
      source = 'path'
      sourcePath = findOnPath(env)
    }
  }
  if (!sourcePath) return { ok: false, reason: '未找到 mihomo（设置 MIHOMO_BIN 后重启控制台）' }
  return { ok: true, source, sourcePath, needsCopy: needsCopy(sourcePath, fs.statSync(sourcePath)) }
}

/** Copies the binary into `<dir>/bin` when the copy rule says so, then gates on `-v` (≥ 1.19) of what will run. */
export async function prepareMihomoBinary(located: Extract<LocatedMihomo, { ok: true }>, options: Pick<ResolveMihomoOptions, 'dir' | 'readVersion'>): Promise<MihomoBinary> {
  const readVersion = options.readVersion ?? defaultReadVersion
  let runPath = located.sourcePath
  if (located.needsCopy) {
    try {
      runPath = await ensureCopy(located.sourcePath, options.dir)
    } catch {
      return { ok: false, reason: '复制 mihomo 到控制台目录失败' }
    }
  }
  let version: string | null = null
  try {
    version = parseMihomoVersion(await readVersion(runPath))
  } catch {
    return { ok: false, reason: 'mihomo -v 执行失败' }
  }
  if (!version) return { ok: false, reason: '无法识别 mihomo 版本' }
  if (!versionSupported(version)) return { ok: false, reason: `mihomo 版本过旧（${version}，需要 ≥ ${MIN_MIHOMO_VERSION.join('.')}）` }
  return { ok: true, source: located.source, sourcePath: located.sourcePath, runPath, copied: located.needsCopy, version }
}

export async function resolveMihomoBinary(options: ResolveMihomoOptions): Promise<MihomoBinary> {
  const located = locateMihomoBinary(options)
  return located.ok ? prepareMihomoBinary(located, options) : located
}
