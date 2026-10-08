import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 仓库公开发布：跟踪文件里不能出现真实地址、真实 Key、真实邮箱和内部主机名。
// 二进制文件（截图等）不在扫描范围内，靠评审把关。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 白名单：path 以 `/` 结尾按目录前缀匹配；rule 为规则 id。
 * pending 的条目由别的分支收口，暂不做「已失效」检查。
 */
export const ALLOWLIST = [
  { path: 'server/proxyParseSubscription.test.ts', rule: 'ipv4', reason: '私网/保留段判定与 SSRF 拦截测试，必须用这些段本身（含一个公网对照 8.8.8.8）' },
  { path: 'server/mihomoConfig.ts', rule: 'ipv4', reason: '内核 DNS 用的公共解析器 223.5.5.5 / 1.1.1.1，不是自有地址' },
  { path: 'public/logos/codex.svg', rule: 'ipv4', reason: 'SVG 路径里连写的小数，不是地址' },
  { path: 'scripts/public-tree-check.test.mjs', rule: '*', reason: '本文件：规则本身与规则自检夹具' },
]

/** 计划与实测记录持续写进这里，写时脱敏（`<正式机>`/`<预发布机>` 占位），白名单不得覆盖其中任何文件。 */
const NEVER_EXEMPT = 'docs/qa/deploy/'

const octets = (ip) => ip.split('.').map(Number)

/** 回环、0.0.0.0 与 RFC 5737 文档段之外的合法 IPv4 才算命中；超过 255 的段说明是版本号之类。 */
function ipv4Hit(ip) {
  const [a, b, c] = octets(ip)
  if (octets(ip).some((n) => n > 255)) return false
  if (a === 127 || ip === '0.0.0.0') return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

/**
 * example.com/.net/.org 与 RFC 2606 保留顶级域（.test/.example/.invalid/.localhost）、noreply 地址放行。
 * 凭据文件名把账号邮箱直接拼进 `<邮箱>.json`，先去掉扩展名再判域名。
 */
function emailHit(address) {
  const [local, rawDomain] = address.toLowerCase().split('@')
  const domain = rawDomain.replace(/\.json$/, '')
  if (local === 'noreply' || domain.endsWith('.noreply.github.com')) return false
  if (/(^|\.)example\.(com|net|org)$/.test(domain)) return false
  if (/\.(test|example|invalid|localhost)$/.test(domain)) return false
  return true
}

export const RULES = [
  // 浏览器 UA 里的 `Chrome/131.0.0.0` 与 RFC 章节号 `§8.4.1.3` 不是地址
  { id: 'ipv4', re: /(?<![\w.§]|(?:Chrome|Chromium|Firefox|Edg|Safari|Version)\/)(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g, hit: ipv4Hit },
  { id: 'sk-hex', re: /sk-[0-9a-f]{40,}/gi, hit: () => true },
  { id: 'email', re: /[\w.%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/gi, hit: emailHit },
  { id: 'internal-host', re: /cpa-vps|hk-cn2|ibuki-wsl|ktvsky/gi, hit: () => true },
]

const allowedBy = (path, rule) =>
  ALLOWLIST.find((entry) => (entry.rule === '*' || entry.rule === rule) && (entry.path.endsWith('/') ? path.startsWith(entry.path) : path === entry.path))

function trackedTextFiles() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean)
  const out = []
  for (const path of files) {
    const abs = join(ROOT, path)
    let stat
    try {
      stat = lstatSync(abs)
    } catch {
      continue // 已删除未提交
    }
    if (!stat.isFile()) continue
    const buf = readFileSync(abs)
    if (buf.subarray(0, 8000).includes(0)) continue
    out.push({ path, text: buf.toString('utf8') })
  }
  return out
}

/** 只回显前缀，测试输出本身不能变成泄漏渠道。 */
const redact = (value) => (value.length > 10 ? `${value.slice(0, 6)}…` : value)

test('跟踪文件不含真实地址、Key、邮箱与内部主机名', () => {
  const used = new Set()
  const problems = []
  for (const { path, text } of trackedTextFiles()) {
    const lines = text.split('\n')
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i].matchAll(rule.re)) {
          if (!rule.hit(match[0])) continue
          const entry = allowedBy(path, rule.id)
          if (entry) {
            used.add(entry)
            continue
          }
          problems.push(`${path}:${i + 1} [${rule.id}] ${redact(match[0])}`)
        }
      }
    }
  }
  assert.deepEqual(problems, [], `公开树里有 ${problems.length} 处命中：\n${problems.join('\n')}`)
  const stale = ALLOWLIST.filter((entry) => !entry.pending && !used.has(entry)).map((entry) => `${entry.path} [${entry.rule}]`)
  assert.deepEqual(stale, [], '白名单条目已不再命中，删掉它')
})

test(`${NEVER_EXEMPT} 不在任何白名单条目覆盖范围内`, () => {
  const covering = ALLOWLIST.filter((entry) => entry.path.startsWith(NEVER_EXEMPT) || (entry.path.endsWith('/') && NEVER_EXEMPT.startsWith(entry.path)))
  assert.deepEqual(covering, [])
  assert.equal(allowedBy(`${NEVER_EXEMPT}20261009-x.md`, 'ipv4'), undefined)
})

test('规则自检：放行与命中边界', () => {
  const ip = RULES.find((rule) => rule.id === 'ipv4')
  for (const ok of ['127.0.0.1', '0.0.0.0', '192.0.2.1', '198.51.100.20', '203.0.113.9', '1.2.300.4']) assert.equal(ip.hit(ok), false, ok)
  for (const bad of ['10.0.0.1', '8.8.8.8', '100.64.0.8', '192.168.1.1']) assert.equal(ip.hit(bad), true, bad)
  const email = RULES.find((rule) => rule.id === 'email')
  for (const ok of ['a@example.com', 'ops@company.example', 'x@sub.example.test', 'noreply@anthropic.com']) assert.equal(email.hit(ok), false, ok)
  for (const bad of ['a@x.io', 'someone@qq.com', 'codex-someone@gmail.com.json']) assert.equal(email.hit(bad), true, bad)
  assert.equal(email.hit('claude-a@example.test.json'), false)
  const ipsIn = (text) => [...text.matchAll(ip.re)].map((match) => match[0])
  assert.deepEqual(ipsIn('Chrome/131.0.0.0 Safari/537.36 · RFC 9110 §8.4.1.3 · http://10.0.0.1:80 · 1.2.3.4.'), ['10.0.0.1', '1.2.3.4'])
  assert.equal(`sk-${'ab'.repeat(20)}`.match(RULES.find((rule) => rule.id === 'sk-hex').re)?.length, 1)
})
