import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

/**
 * 静态文本压缩（task-50）的服务端级验证。
 *
 * 端到端：真起一个 `server/index.ts` 子进程（临时 `DATA_DIR`），只打 HTTP：
 * - 不协商 / `gzip` / `br` 三态的实际字节数、`Content-Encoding`、`Vary`、`Content-Length`
 * - 解压后必须与磁盘字节**逐字节相同**（防「压缩层把响应写坏」）
 * - 小于 1KB 的可压缩文件与已压缩类型（.ico/.woff2/.png）**不被压缩**（也不带 Vary）
 * - 条件请求 304、`Range` 走回 express.static 的 206、SPA 深链接回退的 `no-cache`
 * - `Cache-Control` 仍是 `public, max-age=3600, immutable`（没破坏 express.static 语义）
 *
 * 缓存命中/未命中与协商逻辑用**单元级**断言（`compressionStats()`），避免对耗时做断言（那会 flake）。
 * 本文件不引入 `./testDataDir.js`：它自己 `mkdtemp` 并显式传给子进程（与 concurrency 用例同样的例外）。
 */

const REPO = new URL('../', import.meta.url).pathname
const DIST = path.resolve(REPO, 'dist')

const service = await import('./compression.js')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))))
    })
  })
}

/**
 * 用 node:http 发**原始**请求：`fetch`（undici）会自动补 `accept-encoding` 并透明解压，
 * 那样既测不到「不协商」的真实响应，也拿不到压缩后的字节数。
 */
function rawGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const flat: Record<string, string> = {}
        for (const [key, value] of Object.entries(response.headers)) {
          flat[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
        }
        resolve({ status: response.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitForReady(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}`)
    try {
      const response = await fetch(`${base}/api/session`)
      if (response.status < 500) return
    } catch {
      /* 还没起来 */
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('服务子进程 25s 内没就绪')
}

const largestAsset = (extension: string): { url: string; file: string; size: number } | null => {
  const dir = path.join(DIST, 'assets')
  if (!fs.existsSync(dir)) return null
  const candidates = fs.readdirSync(dir)
    .filter(name => name.endsWith(extension))
    .map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }))
    .filter(entry => entry.size >= service.MIN_COMPRESS_BYTES)
    .sort((left, right) => right.size - left.size)
  const best = candidates[0]
  return best ? { url: `/assets/${best.name}`, file: path.join(dir, best.name), size: best.size } : null
}

const css = largestAsset('.css')
const js = largestAsset('.js')

// index.html 已因 modulepreload 列表超过 1KB，⑤ 改用 dist 里最小的可压缩文件守住「小文件不压」边界。
const smallestCompressible = (): string | null => {
  const found: { url: string; size: number }[] = []
  for (const [dir, prefix] of [[DIST, '/'], [path.join(DIST, 'assets'), '/assets/']] as const) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(js|css|html|svg)$/.test(name)) continue
      const stat = fs.statSync(path.join(dir, name))
      if (stat.isFile() && stat.size > 0 && stat.size < service.MIN_COMPRESS_BYTES) found.push({ url: `${prefix}${name}`, size: stat.size })
    }
  }
  found.sort((left, right) => left.size - right.size)
  return found[0]?.url ?? null
}
const small = smallestCompressible()

test('静态文本压缩：三态协商 / 完整性 / 边界不被破坏', { timeout: 120_000 }, async (t) => {
  if (!css || !js || !small) {
    t.skip('dist 里缺少 ≥1KB 的 css/js 或 <1KB 的可压缩产物（先 npm run build）')
    return
  }
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-compression-test-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CPA_BASE_URL: 'http://127.0.0.1:9',
      CPA_MANAGEMENT_KEY: 'test-management-key',
      MAGPIE_CONTROL_PLANE: 'local',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret',
      COOKIE_SECURE: 'false',
      GATEWAY_ENGINE: 'cpa',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  try {
    await waitForReady(base, child)
    const rawCss = fs.readFileSync(css.file)
    const rawJs = fs.readFileSync(js.file)

    // ① 不协商：原大小、无 Content-Encoding、但必须有 Vary（共享缓存不能把压缩体发给不接受压缩的客户端）
    const identity = await rawGet(`${base}${css.url}`, { 'accept-encoding': 'identity' })
    assert.equal(identity.status, 200)
    assert.equal(identity.headers['content-encoding'], undefined, '不协商时不得带 Content-Encoding')
    assert.equal(Number(identity.headers['content-length']), css.size)
    assert.equal(identity.body.length, css.size)
    assert.match(String(identity.headers.vary), /Accept-Encoding/i, '可压缩资源必须带 Vary')
    assert.match(String(identity.headers['cache-control']), /max-age=3600/)
    assert.match(String(identity.headers['cache-control']), /immutable/)

    // ② gzip：更小 + Content-Encoding: gzip + 解压后逐字节一致
    const gzip = await rawGet(`${base}${css.url}`, { 'accept-encoding': 'gzip' })
    const gzipBody = gzip.body
    assert.equal(gzip.status, 200)
    assert.equal(gzip.headers['content-encoding'], 'gzip')
    assert.match(String(gzip.headers.vary), /Accept-Encoding/i)
    assert.equal(Number(gzip.headers['content-length']), gzipBody.length, 'Content-Length 必须是压缩后的长度')
    assert.ok(gzipBody.length < css.size, `gzip 必须更小：${gzipBody.length} vs ${css.size}`)
    assert.ok(gunzipSync(gzipBody).equals(rawCss), 'gzip 解压后必须与磁盘字节一致')

    // ③ br：优先 br，且比 gzip 更小
    const br = await rawGet(`${base}${css.url}`, { 'accept-encoding': 'br' })
    const brBody = br.body
    assert.equal(br.status, 200)
    assert.equal(br.headers['content-encoding'], 'br')
    assert.match(String(br.headers.vary), /Accept-Encoding/i)
    assert.ok(brBody.length < gzipBody.length, `br 应比 gzip 更小：${brBody.length} vs ${gzipBody.length}`)
    assert.ok(brotliDecompressSync(brBody).equals(rawCss), 'br 解压后必须与磁盘字节一致')

    // ④ JS 同样生效（且 br 优先于 gzip）
    const jsBr = await rawGet(`${base}${js.url}`, { 'accept-encoding': 'gzip, deflate, br' })
    const jsBody = jsBr.body
    assert.equal(jsBr.headers['content-encoding'], 'br')
    assert.ok(brotliDecompressSync(jsBody).equals(rawJs))

    // ⑤ 边界：<1KB 的可压缩文件不压、也不带 Vary（保持既有行为）
    const smallResponse = await rawGet(`${base}${small}`, { 'accept-encoding': 'br' })
    assert.equal(smallResponse.status, 200)
    assert.equal(smallResponse.headers['content-encoding'], undefined, `小文件不压：${small}`)
    assert.equal(smallResponse.headers.vary, undefined, '小文件不参与协商，不应凭空多出 Vary')

    // ⑥ 边界：已压缩类型不被二次压缩（dist 里挑一个 .ico/.woff2/.png）
    const binary = fs.existsSync(path.join(DIST, 'favicon.ico'))
      ? '/favicon.ico'
      : fs.readdirSync(DIST).find(name => /\.(png|woff2|jpg)$/.test(name))
        ? `/${fs.readdirSync(DIST).find(name => /\.(png|woff2|jpg)$/.test(name))}`
        : null
    if (binary) {
      const raw = await rawGet(`${base}${binary}`, { 'accept-encoding': 'br' })
      assert.equal(raw.headers['content-encoding'], undefined, `已压缩类型不得二次压缩：${binary}`)
    }

    // ⑦ 条件请求：用 br 响应的 ETag 再请求 → 304（且仍带 Vary）
    const etag = br.headers.etag
    assert.ok(etag, '必须返回 ETag')
    const conditional = await rawGet(`${base}${css.url}`, { 'accept-encoding': 'br', 'if-none-match': String(etag) })
    assert.equal(conditional.status, 304)
    assert.match(String(conditional.headers.vary), /Accept-Encoding/i)

    // ⑧ Range 请求走回 express.static（206 + Content-Range），不被压缩层吃掉
    const range = await rawGet(`${base}${css.url}`, { range: 'bytes=0-99' })
    assert.equal(range.status, 206)
    assert.match(String(range.headers['content-range']), /^bytes 0-99\//)
    assert.equal(range.body.length, 100)

    // ⑨ SPA 深链接回退保持 no-cache（压缩层不接管不存在于 dist 的路径）
    const spa = await rawGet(`${base}/some/deep/link`)
    assert.equal(spa.status, 200)
    assert.match(String(spa.headers['cache-control']), /no-cache/)
    assert.match(String(spa.headers['content-type']), /text\/html/)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 200))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('压缩层单元契约：协商优先级 / 缓存命中计数 / ETag 稳定', () => {
  // 协商：优先 br；q=0 视为不接受；只有 gzip 时用 gzip；都没有就 identity
  assert.equal(service.negotiateEncoding(undefined), 'identity')
  assert.equal(service.negotiateEncoding('gzip'), 'gzip')
  assert.equal(service.negotiateEncoding('br'), 'br')
  assert.equal(service.negotiateEncoding('gzip, deflate, br'), 'br')
  assert.equal(service.negotiateEncoding('br;q=0, gzip'), 'gzip', 'br;q=0 应当回退 gzip')
  assert.equal(service.negotiateEncoding('br;q=0, gzip;q=0, identity'), 'identity')
  assert.equal(service.negotiateEncoding('*'), 'br', '通配应命中优先级最高的 br')

  // ETag 只依赖 stat（size+mtime），与编码无关 ⇒ 三种表示共用一个 ETag
  const stat = { size: 640500, mtimeMs: 1_759_000_000_000 }
  assert.equal(service.fileETag(stat), service.fileETag({ ...stat }))
  assert.notEqual(service.fileETag(stat), service.fileETag({ ...stat, size: stat.size + 1 }))
  assert.match(service.fileETag(stat), /^W\/"[0-9a-f]+-[0-9a-f]+"$/)

  // 缓存：同一文件两次 gzip → 第二次命中（miss 只发生一次）；不同文件各记一次
  service.resetCompressionCache()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-compression-unit-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), `const a = ${'1'.repeat(4096)}\n`)
    fs.writeFileSync(path.join(dir, 'b.js'), `const b = ${'2'.repeat(4096)}\n`)
    const middleware = service.staticCompression(dir)
    const run = (url: string, acceptEncoding: string): { headers: Record<string, string>; body: Buffer } => {
      const headers: Record<string, string> = {}
      let body: Buffer = Buffer.alloc(0)
      const req = { method: 'GET', url, headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} }
      const res = {
        statusCode: 200,
        setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = String(value) },
        end: (chunk?: Buffer) => { if (chunk) body = chunk },
      }
      let passed = false
      middleware(req as never, res as never, () => { passed = true })
      assert.equal(passed, false, '可压缩文件应当由压缩层处理，而不是 next()')
      return { headers, body }
    }
    const first = run('/a.js', 'gzip')
    const afterFirst = service.compressionStats()
    assert.equal(afterFirst.misses, 1)
    assert.equal(afterFirst.stored, 1)
    const second = run('/a.js', 'gzip')
    const afterSecond = service.compressionStats()
    assert.equal(afterSecond.hits, 1, '第二次应当命中内存缓存')
    assert.equal(afterSecond.misses, 1, '命中后不得再压缩')
    assert.ok(second.body.equals(first.body))
    run('/b.js', 'br')
    const afterThird = service.compressionStats()
    assert.equal(afterThird.misses, 2)
    assert.equal(afterThird.entries, 2)

    // 小文件与非文本一律 next()（不接管）
    fs.writeFileSync(path.join(dir, 'tiny.js'), 'x')
    fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.alloc(4096, 7))
    for (const [url, why] of [['/tiny.js', '<1KB'], ['/pic.png', '已压缩类型'], ['/missing.js', '不存在']] as const) {
      let passed = false
      middleware({ method: 'GET', url, headers: { 'accept-encoding': 'br' } } as never,
        { setHeader: () => undefined, end: () => undefined } as never, () => { passed = true })
      assert.equal(passed, true, `${why} 应当 next() 交给 express.static：${url}`)
    }
    // Range 请求也一律放行
    let ranged = false
    middleware({ method: 'GET', url: '/a.js', headers: { range: 'bytes=0-9' } } as never,
      { setHeader: () => undefined, end: () => undefined } as never, () => { ranged = true })
    assert.equal(ranged, true, 'Range 请求必须交回 express.static')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    service.resetCompressionCache()
  }
})
