/**
 * 静态文本资源的压缩层（task-50）：**零新增依赖**，只用 Node 内置 `zlib`。
 *
 * 背景：`express.static` 不做协商压缩——实测 `dist/assets/console-*.css` 640,500 B 原样返回
 * （gzip 94 KB / brotli 78 KB，约 7-8×）。本机 127.0.0.1 无所谓，但发布后用户走网络，
 * 每个页面都要加载这份 CSS，这是真实的首屏成本。
 *
 * 设计（挂载顺序见 `server/index.ts`）：
 * - 本中间件挂在 `/docs` 路由**之后**、`express.static` **之前**，只接管：
 *   `GET/HEAD` + 无 `Range` + 路径落在静态根目录内 + 扩展名属于可压缩文本 + 文件 ≥ 1KB。
 * - 其余一切（API、SSE、小文件、二进制、Range 请求、目录、SPA 回退）**原样 `next()`**，
 *   由既有处理器负责，因此 `express.static` 的 maxAge/immutable 语义、`/docs` 的 sendFile、
 *   SPA 回退都不受影响（`index.html`/`docs.html` 都 < 1KB，根本不会进入本中间件）。
 * - 命中可压缩文件时，**无论客户端是否接受压缩**都由本中间件出响应，这样 identity 响应也能
 *   带上 `Vary: Accept-Encoding`（否则共享缓存可能把压缩体发给不接受压缩的客户端）。
 *   ETag 统一按「文件 stat」生成（与 `send` 的弱 ETag 同构），三种编码共用一个 ETag，
 *   条件请求（`If-None-Match` / `If-Modified-Since`）由本中间件处理 → 304。
 * - 压缩结果**只放内存**（键 = 编码 + 路径 + mtime + size），分条数与总字节双重上限做 LRU 淘汰；
 *   生产是 `ProtectSystem=strict`，绝不写临时文件。
 * - 只在 miss 时压缩；默认 brotli quality 9 / gzip level 9（实测 640KB CSS：br-9 78 KB/10.9ms、
 *   gzip-9 94 KB/8.4ms；br-11 只多省 6 KB 却要 533ms，不划算——见 docs/qa/blue/static-compression.md）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import type { NextFunction, Request, Response } from 'express'

export type StaticEncoding = 'br' | 'gzip' | 'identity'

/** 可压缩扩展名 → Content-Type（与 Vite 产物实际用到的类型一致）。 */
const COMPRESSIBLE_EXT = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
])

/** 小于这个大小不压：头部开销（Content-Encoding/Vary）+ CPU 不划算。 */
export const MIN_COMPRESS_BYTES = 1024

const BROTLI_QUALITY = 9
const GZIP_LEVEL = 9
const MAX_CACHE_ENTRIES = 128
const MAX_CACHE_BYTES = 64 * 1024 * 1024

type CacheEntry = { body: Buffer; hits: number }

const cache = new Map<string, CacheEntry>()
let cacheBytes = 0
const stats = { hits: 0, misses: 0, stored: 0, skippedIncompressible: 0 }

/** 诊断/测试用：缓存与命中情况。 */
export function compressionStats(): { hits: number; misses: number; stored: number; entries: number; bytes: number; skippedIncompressible: number } {
  return { ...stats, entries: cache.size, bytes: cacheBytes }
}

/** 测试用：清空缓存（生产不需要）。 */
export function resetCompressionCache(): void {
  cache.clear()
  cacheBytes = 0
  stats.hits = 0
  stats.misses = 0
  stats.stored = 0
  stats.skippedIncompressible = 0
}

/** 与 `send`/`etag` 对 stat 的弱 ETag 同构：三种编码共用一个 ETag，避免缓存分身。 */
export function fileETag(stat: { size: number; mtimeMs: number }): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

/** 解析 `Accept-Encoding`：优先 br，其次 gzip；q=0 视为不接受。 */
export function negotiateEncoding(header: string | undefined): StaticEncoding {
  if (!header) return 'identity'
  const quality = new Map<string, number>()
  for (const part of header.split(',')) {
    const [rawToken, ...params] = part.split(';')
    const token = rawToken.trim().toLowerCase()
    if (!token) continue
    let q = 1
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)
      if (match) q = Number(match[1])
    }
    quality.set(token, Number.isFinite(q) ? q : 1)
  }
  const accept = (token: string): number => quality.get(token) ?? quality.get('*') ?? 0
  if (accept('br') > 0) return 'br'
  if (accept('gzip') > 0) return 'gzip'
  return 'identity'
}

function isFresh(req: Request, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = req.headers['if-none-match']
  if (ifNoneMatch) {
    // 逐项比对，兼容 `W/"x", "y"` 与 `*`
    return String(ifNoneMatch).split(',').some(candidate => {
      const value = candidate.trim()
      return value === '*' || value === etag
    })
  }
  const ifModifiedSince = req.headers['if-modified-since']
  if (ifModifiedSince) {
    const since = Date.parse(String(ifModifiedSince))
    // HTTP 的 If-Modified-Since 精度到秒
    return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since
  }
  return false
}

function compress(filePath: string, encoding: Exclude<StaticEncoding, 'identity'>, cacheKey: string): Buffer {
  const cached = cache.get(cacheKey)
  if (cached) {
    stats.hits += 1
    cached.hits += 1
    return cached.body
  }
  stats.misses += 1
  const raw = fs.readFileSync(filePath)
  const body = encoding === 'br'
    ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
    : gzipSync(raw, { level: GZIP_LEVEL })
  // 压不动（已压缩内容/极小收益）就不缓存压缩体，让调用方回退 identity
  if (body.length >= raw.length) {
    stats.skippedIncompressible += 1
    return raw
  }
  cache.set(cacheKey, { body, hits: 0 })
  cacheBytes += body.length
  stats.stored += 1
  // LRU：Map 的迭代顺序就是插入顺序，超限时从头淘汰
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    const entry = cache.get(oldest.value)
    if (entry) cacheBytes -= entry.body.length
    cache.delete(oldest.value)
  }
  return body
}

/**
 * 静态文本压缩中间件。`root` 是静态根（`dist`）；只接管可压缩文本，其余 `next()`。
 */
export function staticCompression(root: string, options: { maxAgeSeconds?: number } = {}) {
  const resolvedRoot = path.resolve(root)
  const maxAgeSeconds = options.maxAgeSeconds ?? 3600

  return function compressionMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    // Range 请求交回 express.static：保持 206/Content-Range 语义不变
    if (req.headers.range) return next()

    const rawUrl = String(req.url || '/')
    const queryAt = rawUrl.indexOf('?')
    let urlPath = queryAt >= 0 ? rawUrl.slice(0, queryAt) : rawUrl
    try {
      urlPath = decodeURIComponent(urlPath)
    } catch {
      return next()
    }
    if (urlPath.includes('\0')) return next()

    const filePath = path.resolve(resolvedRoot, `.${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`)
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) return next() // 目录穿越

    const contentType = COMPRESSIBLE_EXT.get(path.extname(filePath).toLowerCase())
    if (!contentType) return next()

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return next()
    }
    if (!stat.isFile()) return next()
    if (stat.size < MIN_COMPRESS_BYTES) return next() // 小文件保持原行为（/docs 与 index.html 都在此列）

    const etag = fileETag(stat)
    const baseHeaders = () => {
      res.setHeader('Content-Type', contentType)
      res.setHeader('Vary', 'Accept-Encoding')
      res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}, immutable`)
      res.setHeader('ETag', etag)
      res.setHeader('Last-Modified', stat.mtime.toUTCString())
    }

    if (isFresh(req, etag, stat.mtimeMs)) {
      baseHeaders()
      res.statusCode = 304
      res.end()
      return
    }

    const negotiated = negotiateEncoding(req.headers['accept-encoding'] as string | undefined)
    let encoding: StaticEncoding = negotiated
    let body: Buffer
    if (encoding === 'identity') {
      body = fs.readFileSync(filePath)
    } else {
      const cacheKey = `${encoding}|${filePath}|${stat.mtimeMs}|${stat.size}`
      body = compress(filePath, encoding, cacheKey)
      // 压不动时回退 identity（此时 body 是原始内容）
      if (body.length >= stat.size) encoding = 'identity'
    }

    baseHeaders()
    if (encoding !== 'identity') res.setHeader('Content-Encoding', encoding)
    res.statusCode = 200
    res.setHeader('Content-Length', String(body.length))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  }
}
