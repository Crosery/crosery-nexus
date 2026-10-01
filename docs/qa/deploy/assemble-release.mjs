#!/usr/bin/env node
/**
 * assemble-release.mjs —— 在**临时目录**里模拟组装一个生产 release 并做发布前校验。
 *
 * 设计原则（对应 task-15）：
 *  1. 绝不触碰 /opt 或任何生产路径：`--out` 必须在临时目录下（脚本自己断言）。
 *  2. 组装方式遵循 deploy/edge/README.md:37-44：**以当前生产 release 为基底复制，再叠加本地文件**，
 *     不用本地树整体替换。
 *  3. 产出草稿 `MANIFEST.sha256` / `RELEASE.json`，并把三项校验的逐条结果写成 `assembly-report.md`。
 *
 * 用法：
 *   node docs/qa/deploy/assemble-release.mjs \
 *     --prod-snapshot=/tmp/prod-release-snapshot \   # 生产 release 的只读快照（不含 node_modules）
 *     --repo=/path/to/crosery-api-console \
 *     --out=/tmp/release-20261001-tuffex-rtk \
 *     --release-id=20261001-tuffex-rtk \
 *     --frontend=vue|keep-prod \
 *     [--dist-from=$REPO/dist] [--expect-node=v24.20.0] [--strict-node] [--allow-dirty] [--base-release=...]
 *
 * 三项校验：
 *   V1 不缺失任何生产侧文件（与生产 MANIFEST.sha256 逐条对比；.cache/*.tsbuildinfo 允许缺失但单独列出）
 *   V2 dist 与源码一致（产物新鲜度 + index.html/manifest 引用完整性 + 入口 chunk 存在 + 记录 dist 树哈希）
 *   V3 Node 版本（生产 runtime / 本地构建用 node / package.json engines 三方对照）
 * 附加自检：V4 MANIFEST 自洽；V5 禁运清单（docs/qa、.env、data、node_modules、*.log、*.tar.gz）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

/* ------------------------------------------------------------------ */
/* 参数与工具                                                          */
/* ------------------------------------------------------------------ */

const argv = new Map()
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/s.exec(arg)
  if (m) argv.set(m[1], m[2] === undefined ? 'true' : m[2])
}
const arg = (name, fallback = undefined) => (argv.has(name) ? argv.get(name) : fallback)

const REPO = path.resolve(arg('repo', process.cwd()))
const PROD = arg('prod-snapshot') ? path.resolve(arg('prod-snapshot')) : null
const OUT = arg('out') ? path.resolve(arg('out')) : null
const FRONTEND = arg('frontend', 'vue')
const RELEASE_ID = arg('release-id', `local-${new Date().toISOString().slice(0, 10)}`)
const EXPECT_NODE = arg('expect-node', '')
const BASE_RELEASE = arg('base-release', '/opt/crosery-api-console-releases/20260928-reset-clears-cooldown')
const DIST_FROM = arg('dist-from') ? path.resolve(arg('dist-from')) : path.join(REPO, 'dist')
const ALLOW_DIRTY = argv.has('allow-dirty')
const STRICT_NODE = argv.has('strict-node')

const problems = []
const warnings = []
const fail = (msg) => problems.push(msg)
const warn = (msg) => warnings.push(msg)

if (!PROD || !OUT) {
  console.error('必须提供 --prod-snapshot=<dir> 与 --out=<dir>')
  process.exit(2)
}
if (!fs.existsSync(PROD) || !fs.statSync(PROD).isDirectory()) fail(`--prod-snapshot 不存在: ${PROD}`)
if (!fs.existsSync(REPO)) fail(`--repo 不存在: ${REPO}`)
if (!['vue', 'keep-prod'].includes(FRONTEND)) fail(`--frontend 只能是 vue 或 keep-prod，收到 ${FRONTEND}`)

/** 生产安全断言：输出目录绝不可以在 /opt 下、也绝不可以在仓库内覆盖源码。 */
const tmpRoots = [...new Set([os.tmpdir(), '/tmp', '/private/tmp']
  .filter((p) => fs.existsSync(p))
  .map((p) => fs.realpathSync(p)))]
const outParentReal = fs.existsSync(path.dirname(OUT)) ? fs.realpathSync(path.dirname(OUT)) : path.dirname(OUT)
const outReal = path.join(outParentReal, path.basename(OUT))
if (OUT) {
  if (outReal.startsWith('/opt')) fail(`拒绝执行：--out 落在 /opt 下（${OUT}）`)
  if (!tmpRoots.some((t) => outReal.startsWith(t + path.sep))) fail(`拒绝执行：--out 必须在临时目录下（收到 ${OUT}）`)
  if (outReal === REPO || outReal.startsWith(REPO + path.sep)) fail(`拒绝执行：--out 不能在仓库内（${OUT}）`)
}
if (problems.length) {
  for (const p of problems) console.error('✖ ' + p)
  process.exit(2)
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const walk = (dir, rel = '') => {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(dir, r))
    else if (entry.isFile()) out.push(r)
    else if (entry.isSymbolicLink()) out.push(r) // 记录但不复制（release 里不应有 symlink）
  }
  return out
}
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB'

/** release 的 MANIFEST 覆盖规则（与生产实测一致）：除 node_modules/**、.DS_Store、MANIFEST.sha256 之外的全部文件。 */
const manifestEligible = (rel) =>
  !rel.startsWith('node_modules/') && path.basename(rel) !== '.DS_Store' && rel !== 'MANIFEST.sha256'

const readManifest = (file) => {
  const map = new Map()
  if (!fs.existsSync(file)) return map
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64}) {2}\.?\/(.+)$/.exec(line.trim())
    if (m) map.set(m[2], m[1])
  }
  return map
}

/* ------------------------------------------------------------------ */
/* 0. 本地仓库状态                                                      */
/* ------------------------------------------------------------------ */

const head = git('rev-parse', 'HEAD')
const dirty = git('status', '--porcelain').split('\n').filter(Boolean)
const dirtyTracked = dirty.filter((l) => !l.startsWith('??')).map((l) => l.slice(3))
if (dirty.length && !ALLOW_DIRTY) {
  fail(`本地工作区不干净（${dirty.length} 项）：发布内容必须能由某个 commit 复现。用 --allow-dirty 仅做演练。\n    ` +
    dirty.slice(0, 12).join('\n    '))
}
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const tracked = git('ls-files').split('\n').filter(Boolean)

/* ------------------------------------------------------------------ */
/* 1. 复制生产 release 作为基底                                          */
/* ------------------------------------------------------------------ */

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const copyTree = (srcDir, dstDir, filter = () => true) => {
  fs.mkdirSync(dstDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name)
    const d = path.join(dstDir, entry.name)
    if (entry.isDirectory()) { if (filter(entry.name + '/')) copyTree(s, d, filter); continue }
    if (!entry.isFile()) continue
    if (!filter(entry.name)) continue
    fs.copyFileSync(s, d)
    fs.chmodSync(d, 0o644)
  }
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.cache', 'dist-old-20260830-110517', 'dist-old-layout-20260830-111154'])
copyTree(PROD, OUT, (rel) => {
  const top = rel.split('/')[0]
  if (rel.endsWith('/')) return !SKIP_DIRS.has(top) && top !== 'docs-old'
  return true
})
// 注：真实上机时用 `cp -a /opt/crosery-api-console-current/. <新目录>/`（含 node_modules）作为基底，
// 本地演练没有那份 node_modules，脚本在报告里显式标注这一点。

const prodManifest = readManifest(path.join(PROD, 'MANIFEST.sha256'))
const prodReleaseJson = fs.existsSync(path.join(PROD, 'RELEASE.json'))
  ? JSON.parse(fs.readFileSync(path.join(PROD, 'RELEASE.json'), 'utf8')) : {}

/* ------------------------------------------------------------------ */
/* 2. 叠加本地文件                                                      */
/* ------------------------------------------------------------------ */

/** 永不进入 release 的本地路径（工具链/QA/本地状态）。注意 `.env.example` 与 `.gitignore` 是要发的。 */
const NEVER_SHIP = [
  /^docs\/qa\//,            // 本次 QA 交付物（生产 release 只带应用文档）
  /^\.git\//,               // 只排除 .git 目录，不要误伤 .gitignore
  /^\.env$/,                // 只排除 .env 本体
  /^\.env\.(?!example$)/,   // 排除 .env.local 等，但放行 .env.example
  /^node_modules\//, /^data\//, /^dist-old/,
  /\.log$/, /\.tar\.gz$/, /^\.DS_Store$/, /^.*\/\.DS_Store$/,
  /^public\/tuffex-dashboard-preview\.png$/, // 本地预览图，未在产物中引用
]
/** keep-prod 模式：保持生产 React 前端与既有 dist，不发布任何前端源码/构建配置。 */
const FRONTEND_LOCAL = [
  /^src\//, /^index\.html$/, /^uno\.config\.ts$/, /^vite\.config\.ts$/,
  /^public\//, /^tsconfig\.app\.json$/, /^\.oxlintrc\.json$/,
]

const shipped = []   // { rel, action, localSha, prodSha, bytes }
const skipped = []   // { rel, reason }
for (const rel of tracked) {
  if (NEVER_SHIP.some((re) => re.test(rel))) { skipped.push({ rel, reason: 'never-ship 规则' }); continue }
  if (FRONTEND === 'keep-prod' && FRONTEND_LOCAL.some((re) => re.test(rel))) {
    skipped.push({ rel, reason: 'keep-prod 模式：保留生产 React 前端' }); continue
  }
  const src = path.join(REPO, rel)
  if (!fs.existsSync(src)) { skipped.push({ rel, reason: '工作区缺失' }); continue }
  const localSha = sha256(src)
  const prodSha = prodManifest.get(rel) || null
  const action = prodSha === null ? 'add' : prodSha === localSha ? 'keep-prod' : 'replace'
  if (action !== 'keep-prod') {
    const dst = path.join(OUT, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    fs.chmodSync(dst, 0o644)
  }
  shipped.push({ rel, action, localSha, prodSha, bytes: fs.statSync(src).size })
}

// dist：vue 模式用本地构建产物整体替换；keep-prod 模式保留生产 dist
let distInfo = null
if (FRONTEND === 'vue') {
  if (!fs.existsSync(DIST_FROM)) {
    fail(`--dist-from 不存在：${DIST_FROM}（先跑 npm run build）`)
  } else {
    fs.rmSync(path.join(OUT, 'dist'), { recursive: true, force: true })
    copyTree(DIST_FROM, path.join(OUT, 'dist'))
    distInfo = { files: walk(path.join(OUT, 'dist')).length, treeHash: null }
  }
} else {
  distInfo = { files: walk(path.join(OUT, 'dist')).length, treeHash: null, note: '保留生产 dist（未重建）' }
}
if (distInfo && fs.existsSync(path.join(OUT, 'dist'))) {
  const h = crypto.createHash('sha256')
  for (const rel of walk(path.join(OUT, 'dist')).sort()) {
    h.update(rel + '\0' + sha256(path.join(OUT, 'dist', rel)) + '\0')
  }
  distInfo.treeHash = h.digest('hex')
}

/* ------------------------------------------------------------------ */
/* 3. 生成 MANIFEST.sha256 与 RELEASE.json 草稿                          */
/* ------------------------------------------------------------------ */

fs.rmSync(path.join(OUT, 'MANIFEST.sha256'), { force: true })
const changedForRelease = shipped.filter((s) => s.action !== 'keep-prod').map((s) => s.rel).sort()
const releaseJson = {
  releaseId: RELEASE_ID,
  createdAt: new Date().toISOString(),
  baseRelease: BASE_RELEASE,
  sourceRepository: REPO,
  source: arg('source', `${RELEASE_ID}: 由生产 release ${path.basename(BASE_RELEASE)} 复制后叠加本地 commit ${head.slice(0, 7)} 的改动` + (FRONTEND === 'vue' ? '，前端切换为 Vue/Tuffex 并重建 dist' : '，保留生产 React 前端与既有 dist')),
  changes: [...changedForRelease.filter((r) => !r.startsWith('dist/')), 'dist/**', 'MANIFEST.sha256', 'RELEASE.json'],
  provenance: {
    localHead: head,
    frontend: FRONTEND,
    builtWithNode: process.version,
    prodRuntimeNode: EXPECT_NODE || null,
    dirtyFiles: dirtyTracked,
    distTreeHash: distInfo?.treeHash || null,
  },
}
// 先写 RELEASE.json，再生成 MANIFEST，保证 MANIFEST 覆盖的 RELEASE.json 是最终内容。
fs.writeFileSync(path.join(OUT, 'RELEASE.json'), JSON.stringify(releaseJson, null, 1) + '\n')
const allFiles = walk(OUT).filter(manifestEligible).sort()
const manifestLines = allFiles.map((rel) => `${sha256(path.join(OUT, rel))}  ./${rel}`)
fs.writeFileSync(path.join(OUT, 'MANIFEST.sha256'), manifestLines.join('\n') + '\n')

/* ------------------------------------------------------------------ */
/* V1 不缺失任何生产侧文件                                              */
/* ------------------------------------------------------------------ */

const assembled = new Map(walk(OUT).map((rel) => [rel, sha256(path.join(OUT, rel))]))
const missing = []
const expectedAbsent = []
const changedVsProd = []
const distReplaced = []
for (const [rel, prodSha] of prodManifest) {
  if (assembled.has(rel)) {
    if (assembled.get(rel) !== prodSha) changedVsProd.push(rel)
    continue
  }
  if (FRONTEND === 'vue' && rel.startsWith('dist/')) { distReplaced.push(rel); continue } // 整个 dist 由 Vue 构建替换
  if (rel.startsWith('.cache/') || rel.endsWith('tsbuildinfo')) expectedAbsent.push(rel) // 构建元数据，重新生成
  else if (rel.endsWith('/._.DS_Store') || rel === '._.DS_Store') expectedAbsent.push(rel) // AppleDouble 噪音
  else missing.push(rel)
}
const addedAll = [...assembled.keys()].filter((rel) => !prodManifest.has(rel) && rel !== 'MANIFEST.sha256' && rel !== 'RELEASE.json').sort()
const addedVsProd = addedAll.filter((rel) => !rel.startsWith('dist/'))
const addedDist = addedAll.filter((rel) => rel.startsWith('dist/'))
if (missing.length) fail(`V1 组装树缺失 ${missing.length} 个生产文件：${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`)
if (FRONTEND === 'keep-prod' && !fs.existsSync(path.join(OUT, 'dist/index.html'))) fail('V1 keep-prod 模式下 dist/index.html 丢失')

/* ------------------------------------------------------------------ */
/* V2 dist 与源码一致                                                   */
/* ------------------------------------------------------------------ */

const distChecks = []
let v2Fail = false
if (FRONTEND === 'vue') {
  const distDir = path.join(OUT, 'dist')
  const indexHtml = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexHtml)) { fail('V2 dist/index.html 不存在'); v2Fail = true }
  else {
    const html = fs.readFileSync(indexHtml, 'utf8')
    const refs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1])
    const missingRefs = refs.filter((r) => !fs.existsSync(path.join(distDir, r)))
    distChecks.push(`dist/index.html 引用 ${refs.length} 个资源，缺失 ${missingRefs.length}`)
    if (missingRefs.length) { fail(`V2 index.html 引用的资源不存在：${missingRefs.join(', ')}`); v2Fail = true }
    const entry = refs.find((r) => r.endsWith('.js'))
    if (!entry) fail('V2 dist/index.html 没有入口 JS 引用')
  }
  const viteManifest = path.join(distDir, '.vite/manifest.json')
  if (!fs.existsSync(viteManifest)) { fail('V2 dist/.vite/manifest.json 不存在（构建未开启 build.manifest）'); v2Fail = true }
  else {
    const vm = JSON.parse(fs.readFileSync(viteManifest, 'utf8'))
    const entries = Object.keys(vm)
    const vuePages = entries.filter((k) => k.endsWith('.vue'))
    const reactPages = entries.filter((k) => k.endsWith('.tsx'))
    distChecks.push(`vite manifest 条目 ${entries.length}（其中 .vue ${vuePages.length} / .tsx ${reactPages.length}）`)
    if (!entries.includes('index.html')) { fail('V2 vite manifest 缺少 index.html 入口'); v2Fail = true }
    if (vuePages.length === 0) { fail('V2 vite manifest 没有任何 .vue 页面 —— 说明 dist 不是 Vue 构建'); v2Fail = true }
    const mainTs = entries.filter((k) => k === 'src/main.ts')
    distChecks.push(`入口 src/main.ts 在产物中：${mainTs.length > 0}`)
  }
  // 新鲜度：dist 必须晚于它要发布的源码（在**仓库**里比 mtime：copyFileSync 会重置组装树的 mtime）
  const newestSource = ['src', 'public', 'index.html', 'vite.config.ts', 'uno.config.ts', 'package.json']
    .flatMap((p) => {
      const full = path.join(REPO, p)
      if (!fs.existsSync(full)) return []
      return fs.statSync(full).isDirectory() ? walk(full).map((r) => path.join(full, r)) : [full]
    })
    .reduce((max, f) => Math.max(max, fs.statSync(f).mtimeMs), 0)
  const newestDist = walk(DIST_FROM).reduce((max, r) => Math.max(max, fs.statSync(path.join(DIST_FROM, r)).mtimeMs), 0)
  const staleSeconds = Math.round((newestSource - newestDist) / 1000)
  distChecks.push(`仓库源码最新 mtime − dist 最新 mtime = ${-staleSeconds}s（负值=dist 更新）`)
  if (newestDist < newestSource) {
    fail(`V2 dist 比源码旧（相差 ${staleSeconds}s）：先重新 npm run build 再组装`)
    v2Fail = true
  }
} else {
  distChecks.push(`keep-prod 模式：未重建 dist（${distInfo.files} 个文件，树哈希 ${distInfo.treeHash?.slice(0, 16)}…）`)
}

/* ------------------------------------------------------------------ */
/* V3 Node 版本                                                         */
/* ------------------------------------------------------------------ */

const engines = pkg.engines?.node || '(未声明)'
const localNode = process.version
const nodeChecks = [
  `本地构建用的 node：${localNode}`,
  `生产 runtime（/opt/crosery-node-current）：${EXPECT_NODE || '(未提供 --expect-node)'}`,
  `package.json engines.node：${engines}`,
]
let nodeVerdict = 'UNKNOWN'
if (EXPECT_NODE) {
  if (localNode === EXPECT_NODE) nodeVerdict = 'PASS'
  else {
    nodeVerdict = 'WARN'
    const msg = `V3 本地构建 node ${localNode} ≠ 生产 runtime ${EXPECT_NODE}：dist 由非生产版本构建，建议改为在生产 release 目录内用 /opt/crosery-node-current 构建（runbook 模式 V），或至少保留本次 WARN 作为已知风险`
    if (STRICT_NODE) fail(msg) ; else warn(msg)
  }
}
if (engines !== '(未声明)') {
  const min = Number((/>=(\d+)/.exec(engines) || [])[1] || 0)
  const max = Number((/<(\d+)/.exec(engines) || [])[1] || 999)
  const major = Number(localNode.replace(/^v/, '').split('.')[0])
  nodeChecks.push(`本地 node major ${major} 是否落在 ${engines}：${major >= min && major < max}`)
  if (!(major >= min && major < max)) {
    const msg = `V3 本地 node ${localNode} 不满足 engines ${engines}（生产 node 满足）`
    if (STRICT_NODE) fail(msg); else warn(msg)
  }
}

/* ------------------------------------------------------------------ */
/* V4/V5 自检                                                           */
/* ------------------------------------------------------------------ */

const recomputed = readManifest(path.join(OUT, 'MANIFEST.sha256'))
const manifestMismatch = allFiles.filter((rel) => recomputed.get(rel) !== sha256(path.join(OUT, rel)))
if (manifestMismatch.length) fail(`V4 MANIFEST 自洽失败：${manifestMismatch.slice(0, 5).join(', ')}`)

const contraband = walk(OUT).filter((rel) =>
  /^docs\/qa\//.test(rel) || (/^\.env($|\.(?!example$))/.test(rel)) || /^data\//.test(rel) || rel.startsWith('node_modules/') ||
  /\.log$/.test(rel) || /\.tar\.gz$/.test(rel) || /^\.git\//.test(rel))
if (contraband.length) fail(`V5 组装树含禁运文件：${contraband.slice(0, 10).join(', ')}`)

const symlinks = walk(OUT).filter((rel) => fs.lstatSync(path.join(OUT, rel)).isSymbolicLink())
if (symlinks.length) warn(`V5 组装树含符号链接（release 不应包含）：${symlinks.join(', ')}`)

/* ------------------------------------------------------------------ */
/* 报告                                                                 */
/* ------------------------------------------------------------------ */

const stats = {
  files: walk(OUT).length,
  manifestEntries: manifestLines.length,
  bytes: walk(OUT).reduce((n, rel) => n + fs.statSync(path.join(OUT, rel)).size, 0),
}
const byAction = shipped.reduce((acc, s) => ((acc[s.action] = (acc[s.action] || 0) + 1), acc), {})
const lines = []
const P = (s = '') => lines.push(s)
P(`# 组装报告（由 assemble-release.mjs 生成）`)
P()
P(`- releaseId: \`${RELEASE_ID}\` ｜ 模式: \`${FRONTEND}\` ｜ 基底: \`${path.basename(BASE_RELEASE)}\``)
P(`- 本地 commit: \`${head}\`${dirtyTracked.length ? `（**工作区不干净**：${dirtyTracked.length} 个已跟踪文件有改动）` : '（工作区干净）'}`)
P(`- 组装树: ${stats.files} 个文件 / ${mb(stats.bytes)}；MANIFEST 条目 ${stats.manifestEntries}`)
P(`- 本地文件动作统计: ${Object.entries(byAction).map(([k, v]) => `${k}=${v}`).join(' ') || '（无）'}`)
P(`- dist: ${distInfo?.files} 个文件，树哈希 \`${distInfo?.treeHash || '-'}\``)
P()
P(`## 校验结论`)
P()
P(`| 校验 | 结果 | 说明 |`)
P(`| --- | --- | --- |`)
P(`| V1 不缺失生产文件 | ${missing.length ? '**FAIL**' : 'PASS'} | 生产 MANIFEST ${prodManifest.size} 条；缺失 ${missing.length}；预期缺失（构建元数据/AppleDouble）${expectedAbsent.length}；内容变化 ${changedVsProd.length}；非 dist 新增 ${addedVsProd.length}；dist 替换 ${distReplaced.length}+${addedDist.length} |`)
P(`| V2 dist 与源码一致 | ${v2Fail ? '**FAIL**' : 'PASS'} | ${distChecks.join('；')} |`)
P(`| V3 Node 版本 | ${nodeVerdict} | ${nodeChecks.join('；')} |`)
P(`| V4 MANIFEST 自洽 | ${manifestMismatch.length ? '**FAIL**' : 'PASS'} | 逐条重算比对 |`)
P(`| V5 禁运清单 | ${contraband.length ? '**FAIL**' : 'PASS'} | docs\/qa、.env、data、node_modules、*.log、*.tar.gz 均未进入 |`)
P()
if (problems.length) { P(`## ✖ 失败项`); P(); for (const p of problems) P(`- ${p}`); P() }
if (warnings.length) { P(`## ⚠ 警告`); P(); for (const w of warnings) P(`- ${w}`); P() }
P(`## V1 明细`)
P()
P(`- 缺失的生产文件（必须为空）：${missing.length ? missing.join(', ') : '无'}`)
P(`- 预期缺失（`+'`.cache/*.tsbuildinfo`'+` 构建元数据、AppleDouble）：${expectedAbsent.join(', ') || '无'}`)
P(`- 相对生产内容不同的文件：${changedVsProd.length} 个（见 release-plan.md 逐文件表）`)
P(`- 生产 dist 被替换：${distReplaced.length} 个旧 chunk 移除、${addedDist.length} 个新 chunk 加入（Vue 构建，整体替换，见 V2）`)
P(`- 新增且生产没有的文件：${addedVsProd.length} 个：${addedVsProd.slice(0, 40).join(', ')}${addedVsProd.length > 40 ? ' …' : ''}`)
P()
P(`## 本地文件的发布动作（逐文件，完整）`)
P()
P(`| 动作 | 文件 | 本地 sha256 | 生产 sha256 |`)
P(`| --- | --- | --- | --- |`)
for (const s of shipped.sort((a, b) => a.rel.localeCompare(b.rel))) {
  P(`| ${s.action} | \`${s.rel}\` | \`${s.localSha.slice(0, 16)}…\` | ${s.prodSha ? '`' + s.prodSha.slice(0, 16) + '…`' : '—'} |`)
}
P()
P(`## 被排除的本地文件（不进入 release）`)
P()
const skipBuckets = skipped.reduce((acc, s) => ((acc[s.reason] = (acc[s.reason] || 0) + 1), acc), {})
P(`- 统计：${Object.entries(skipBuckets).map(([k, v]) => `${k} × ${v}`).join('；')}`)
P(`- 明细（前 40）：${skipped.slice(0, 40).map((s) => s.rel).join(', ')}${skipped.length > 40 ? ' …' : ''}`)
P()
P(`> 本脚本只在临时目录组装；真实上机时基底用 \`cp -a\` 从生产 release 复制（含 node_modules），本演练快照不含 node_modules。`)
fs.writeFileSync(path.join(OUT, 'assembly-report.md'), lines.join('\n') + '\n')

/* ------------------------------------------------------------------ */
/* 控制台摘要                                                          */
/* ------------------------------------------------------------------ */

console.log(`组装目录: ${OUT}`)
console.log(`releaseId: ${RELEASE_ID} | mode: ${FRONTEND} | HEAD: ${head.slice(0, 7)}${dirtyTracked.length ? ` (+${dirtyTracked.length} 脏文件)` : ''}`)
console.log(`文件 ${stats.files} 个 / ${mb(stats.bytes)} | MANIFEST ${stats.manifestEntries} 条 | dist ${distInfo?.files} 个 (tree ${distInfo?.treeHash?.slice(0, 16)}…)`)
console.log(`本地动作: ${Object.entries(byAction).map(([k, v]) => `${k}=${v}`).join(' ') || '无'}`)
console.log(`V1 缺失生产文件: ${missing.length} | 预期缺失: ${expectedAbsent.length} | 替换: ${changedVsProd.length} | 新增: ${addedVsProd.length}`)
console.log(`V3 node: local=${localNode} prod=${EXPECT_NODE || '-'} engines=${engines} -> ${nodeVerdict}`)
for (const w of warnings) console.log('⚠ ' + w)
for (const p of problems) console.log('✖ ' + p)
console.log(problems.length ? '结果: FAIL' : '结果: PASS（含 ' + warnings.length + ' 条警告）')
console.log(`报告: ${path.join(OUT, 'assembly-report.md')}`)
process.exit(problems.length ? 1 : 0)
