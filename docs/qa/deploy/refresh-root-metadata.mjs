#!/usr/bin/env node
/**
 * refresh-root-metadata.mjs —— 刷新**仓库根**的 `MANIFEST.sha256` 与 `RELEASE.json`，让它们与代码树对齐
 * （`deploy/edge/README.md:44`：「keep it [RELEASE.json] and MANIFEST.sha256 in step with the tree」）。
 *
 * 用法：
 *   node docs/qa/deploy/refresh-root-metadata.mjs            # 写入两个根文件
 *   node docs/qa/deploy/refresh-root-metadata.mjs --check    # 只校验现状，不写（CI/复核用）
 *
 * ── 清单规则（与 assemble-release.mjs 同源：都以 git 索引为文件来源）────────────────
 *   来源：`git ls-files`（受版本控制的文件 = 一次干净检出会有的文件）；工作区里已删除但仍在索引里的
 *         条目会被跳过并在输出里列出；**未跟踪文件不入清单**（干净检出不会有它们）。
 *   排除（逐条给理由）：
 *     - `docs/qa/**`        本轮 QA 交付物/证据，不属于应用树（release 组装同样排除）
 *     - `.env`、`.env.*`（放行 `.env.example`）  本地密钥，绝不进清单
 *     - `MANIFEST.sha256`   自身，无法自引用
 *     - `.DS_Store`、`._.DS_Store`  macOS 噪音
 *     - `.git/**`、`node_modules/**`、`dist/**`、`build/**`、`.cache/**`、`*.tsbuildinfo`、`data/**`
 *       生成物 / 依赖 / 本地运行态；这些本来就不在 `git ls-files` 里，列出来是为了把规则写全
 *   格式：`<sha256>  ./<相对路径>`，按路径 `LC_ALL=C` 升序，末尾单个换行。
 *
 * ── 与「历史形状」的差异（重要）───────────────────────────────────────────────────
 *   刷新前根目录那份 295 行清单并**不是**本仓库的清单，而是 2026-09-25 开源导入时从**生产 release
 *   目录**整体拷过来的：它包含 `dist/**`（49 条生产 React 构建产物）、`build/**`（2 条）、
 *   `.DS_Store`，以及 27 条当时就不存在于本仓库的路径（`src/**.tsx`、`src/App.css`、
 *   `server/pageMotionVisibility.test.ts`）。本脚本产出的是**本仓库工作树**的清单。
 *
 * ── RELEASE.json ────────────────────────────────────────────────────────────────
 *   `releaseId` / `createdAt` 是 `server/cpa.ts:510-524` 读取的字段（Console 版本显示），**必须保留**；
 *   其余字段如实描述本地工作树，并说明「本地这份 ≠ 生产 release 目录里那份」。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根：交给 git 判定，不做相对路径算术（2026-10-01 首跑曾因 `../..` 少一层而写进 docs/，见下方断言）。 */
const ROOT = execFileSync('git', ['-C', SCRIPT_DIR, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** 安全断言：必须是真正的仓库根，否则宁可不写。 */
for (const probe of ['package.json', 'server/index.ts', 'src', 'vite.config.ts']) {
  if (!fs.existsSync(path.join(ROOT, probe))) throw new Error(`ROOT 断言失败：${ROOT} 下没有 ${probe}`)
}
if (path.basename(ROOT) === 'docs' || path.basename(ROOT) === 'deploy') throw new Error(`ROOT 断言失败：解析到了 ${ROOT}`)

const CHECK = process.argv.includes('--check')

/** 逐条排除规则（顺序即文档顺序）。 */
const EXCLUDES = [
  { re: /^docs\/qa\//, why: 'QA 交付物/证据，不属于应用树' },
  { re: /^\.env$/, why: '本地密钥' },
  { re: /^\.env\.(?!example$)/, why: '本地密钥（放行 .env.example）' },
  { re: /^MANIFEST\.sha256$/, why: '自身，无法自引用' },
  { re: /(^|\/)\.DS_Store$/, why: 'macOS 噪音' },
  { re: /(^|\/)\._\.DS_Store$/, why: 'macOS AppleDouble 噪音' },
  { re: /^\.git\//, why: 'VCS 元数据' },
  { re: /^node_modules\//, why: '安装的依赖' },
  { re: /^dist\//, why: '构建产物' },
  { re: /^build\//, why: 'tsc 构建产物' },
  { re: /^\.cache\//, why: '增量构建缓存' },
  { re: /\.tsbuildinfo$/, why: '增量构建缓存' },
  { re: /^data\//, why: '本地运行态（SQLite/凭据），绝不进清单' },
]

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })
const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex')

// `-z`：按 NUL 分隔且**不做路径引号转义** —— 否则非 ASCII 文件名会被 git 变成 "\345\205\245" 这类转义串，
// 既匹配不上排除规则、也 existsSync 不到（2026-10-01 首跑踩到，73 个中文名文件被误判为「已删除」）。
const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
const excludedHits = new Map() // rule.why -> count
const missing = []
const files = []
for (const rel of tracked) {
  const rule = EXCLUDES.find((e) => e.re.test(rel))
  if (rule) {
    excludedHits.set(rule.why, (excludedHits.get(rule.why) || 0) + 1)
    continue
  }
  if (!fs.existsSync(path.join(ROOT, rel))) {
    missing.push(rel)
    continue
  }
  files.push(rel)
}
files.sort()

const target = path.join(ROOT, 'MANIFEST.sha256')

const head = git('rev-parse', 'HEAD').trim()
const dirty = git('status', '--porcelain').split('\n').filter(Boolean)

const releaseJson = {
  releaseId: 'local-working-tree-20261001',
  createdAt: new Date().toISOString(),
  baseline: 'LOCAL COPY — 本文件描述的是**本地仓库工作树**，不是任何已发布的生产 release。'
    + ' 生产 release 的元数据以 release 目录里的那份为准：`/opt/crosery-api-console-releases/<release-id>/RELEASE.json`'
    + '（例如当前生产 `20260928-reset-clears-cooldown`）。发布时由 docs/qa/deploy/assemble-release.mjs '
    + '按 `deploy/edge/README.md:37-44`「复制当前 release 再叠加」的流程重新生成 release 内的 RELEASE.json。',
  sourceRepository: ROOT,
  source: '本地工作树：Tuffex/Vue 3 前端迁移（React 死树已移除）+ Magpie 内核适配与动态模型同步 + RTK 三平面控制面'
    + ' + 生产补丁回移（清冷却、凭据导入收口、gpt-image 默认开放）+ 测试夹具每进程独立 DATA_DIR。',
  baseRelease: '/opt/crosery-api-console-releases/20260928-reset-clears-cooldown',
  changes: [
    'src/**（Vue 3 + Tuffex 重写；React 死树于 e52617a / fabd4fe 移除，清单中已无任何 .tsx）',
    'server/rtkService.ts, server/rtkPlane.ts, src/pages/RtkPage.vue（RTK 三平面控制面：kernel/relay/local）',
    'server/magpie*.ts, server/modelSync.ts, deploy/magpie/**（Magpie 内核适配与动态模型同步）',
    'server/cpa.ts, server/index.ts, server/cooldownClear.test.ts, server/credentialUpload.ts（生产 20260926/20260928 补丁回移）',
    'server/testDataDir.ts 与 22 个 server/*.test.ts（测试夹具：每进程独立 DATA_DIR）',
    'MANIFEST.sha256',
    'RELEASE.json',
  ],
  provenance: {
    localHead: head,
    generatedBy: 'docs/qa/deploy/refresh-root-metadata.mjs',
    workingTreeDirty: dirty.length > 0,
    workingTreeChanges: dirty.slice(0, 20),
    manifestEntries: files.length,
  },
}

const jsonText = JSON.stringify(releaseJson, null, 1) + '\n'

console.log(`来源: git ls-files（${tracked.length} 条）`)
console.log(`排除命中: ${[...excludedHits.entries()].map(([w, n]) => `${w}×${n}`).join('；') || '（无）'}`)
if (missing.length) console.log(`索引里已删除、已跳过: ${missing.length} → ${missing.slice(0, 10).join(', ')}`)
console.log(`清单条目: ${files.length}`)
const byTop = files.reduce((acc, f) => ((acc[f.split('/')[0]] = (acc[f.split('/')[0]] || 0) + 1), acc), {})
console.log(`按顶层: ${JSON.stringify(byTop)}`)
console.log(`工作树脏项: ${dirty.length}${dirty.length ? ' → ' + dirty.slice(0, 5).join(' | ') : ''}`)

// 关键顺序：**先写 RELEASE.json，再生成 MANIFEST**——否则清单里记的是上一版 RELEASE.json 的哈希，
// 生成的清单立刻 `shasum -c` 失败（task-15 演练时踩过同一个坑）。
if (!CHECK) fs.writeFileSync(path.join(ROOT, 'RELEASE.json'), jsonText)
const lines = files.map((rel) => `${sha256(rel)}  ./${rel}`)
const content = lines.join('\n') + '\n'

if (CHECK) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
  const sameManifest = current === content
  const relNow = fs.existsSync(path.join(ROOT, 'RELEASE.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'RELEASE.json'), 'utf8')) : {}
  const sameKeys = ['releaseId', 'createdAt'].every((k) => typeof relNow[k] === 'string' && relNow[k])
  console.log(`--check: MANIFEST 一致=${sameManifest}；RELEASE.json 必填字段齐全=${sameKeys}`)
  process.exit(sameManifest && sameKeys ? 0 : 1)
}

fs.writeFileSync(target, content)
console.log(`已写入 RELEASE.json 与 MANIFEST.sha256（${lines.length} 行）`)
