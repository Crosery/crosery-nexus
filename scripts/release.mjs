#!/usr/bin/env node
// 本机发布：干净 worktree 构建 → RELEASE.json → 传到目标机新目录 → 原子切换 current → 健康检查 → 失败自动切回。
// 没有 CI/CD。正式只接收「预发布部署成功 + 含网关请求的验收通过」的同一提交。流程见 docs/ops/release.md。
//
//   node scripts/release.mjs plan     <preview|production> <tag>
//   node scripts/release.mjs deploy   <preview|production> <tag>
//   node scripts/release.mjs accept   <preview|production>      （RELEASE_ACCEPT_KEY=网关 Key；预发布必填）
//   node scripts/release.mjs status   <preview|production>
//   node scripts/release.mjs rollback <preview|production> [--to <发布目录>]
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkTag, environment, parseEnvFile, parseRecords, productionEvidence, publicEnvProblems, releaseIdFor, rollbackTarget, shippable,
} from './release-policy.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_KEYS = ['RELEASE_SSH', 'RELEASE_ROOT', 'RELEASE_CURRENT', 'RELEASE_SERVICE', 'RELEASE_HEALTH_URL', 'RELEASE_NODE', 'RELEASE_CONSOLE_URL', 'RELEASE_API_URL']

const log = (...parts) => console.log(...parts)
// 只在没有待清理资源（发布锁、临时 worktree）的地方直接退出；try/finally 里一律 throw
const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  const { allowFail, ...spawnOptions } = options
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...spawnOptions })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFail) {
    const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().slice(-3000)
    throw new Error(`${cmd} ${args.join(' ')} 退出码 ${result.status}\n${output}`)
  }
  return result
}
const git = (...args) => run('git', ['-C', REPO, ...args]).stdout.trim()
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

function remote(cfg, script, args = [], options = {}) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', cfg.RELEASE_SSH, `bash -s -- ${args.map(quote).join(' ')}`], { input: script, ...options })
}

/**
 * 环境配置分两份：
 * - 运行配置 deploy/env/<env>.env（入库、公开）：部署时读被部署提交里的那份，其余命令读当前检出；
 * - 发布目标 deploy/env/<env>.release.local（不入库）：主机别名、目录、公网地址、验收模型。
 */
function loadEnv(env, commit = null) {
  environment(env)
  const rel = `deploy/env/${env}.env`
  const runtime = parseEnvFile(commit ? git('show', `${commit}:${rel}`) : fs.readFileSync(path.join(REPO, rel), 'utf8'))
  const problems = publicEnvProblems(runtime)
  if (problems.length) throw new Error(`${rel} 不合规（仓库公开）：${problems.join('；')}`)
  if (runtime.CROSERY_ENV !== env) throw new Error(`${rel} 的 CROSERY_ENV=${runtime.CROSERY_ENV}，应为 ${env}`)
  const local = `deploy/env/${env}.release.local`
  const file = path.join(REPO, local)
  if (!fs.existsSync(file)) throw new Error(`缺少 ${local}（照 deploy/env/release.local.example 填写，不入库）`)
  const cfg = parseEnvFile(fs.readFileSync(file, 'utf8'))
  const missing = TARGET_KEYS.filter((key) => !cfg[key])
  if (missing.length) throw new Error(`${local} 缺少 ${missing.join(', ')}`)
  return cfg
}

const STATUS_SH = String.raw`
set -u
ROOT=$1 CURRENT=$2
echo "PATH=$([ -e "$CURRENT" ] && readlink -f "$CURRENT")"
echo "RELEASE=$(base64 -w0 "$CURRENT/RELEASE.json" 2>/dev/null)"
echo "RECORDS=$(tail -n 200 "$ROOT/deployments.jsonl" 2>/dev/null | base64 -w0)"
echo "LOCK=$(cat "$ROOT/.release.lock/owner" 2>/dev/null | base64 -w0)"
`

function targetState(cfg) {
  const out = remote(cfg, STATUS_SH, [cfg.RELEASE_ROOT, cfg.RELEASE_CURRENT]).stdout
  const field = (name) => (out.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? '').trim()
  const decode = (value) => Buffer.from(value, 'base64').toString('utf8')
  let release = null
  try {
    release = field('RELEASE') ? JSON.parse(decode(field('RELEASE'))) : null
  } catch {
    release = null
  }
  return { path: field('PATH'), release, records: parseRecords(decode(field('RECORDS'))), lock: decode(field('LOCK')).trim() }
}

async function fetchText(url, init = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache', ...(init.headers ?? {}) } })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

async function publicCommit(cfg) {
  try {
    const { status, text } = await fetchText(`${cfg.RELEASE_CONSOLE_URL}/api/public/release`)
    return status === 200 ? JSON.parse(text).commit ?? null : null
  } catch {
    return null
  }
}

/* ───────────── plan ───────────── */

async function plan(env, tag) {
  const spec = environment(env)
  const commit = run('git', ['-C', REPO, 'rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`], { allowFail: true }).stdout.trim()
  if (!commit) fail(`本地没有 tag ${tag}`)
  const pkg = JSON.parse(git('show', `${commit}:package.json`))
  const reasons = checkTag(env, tag, pkg.version)
  if (run('git', ['-C', REPO, 'merge-base', '--is-ancestor', commit, spec.branch], { allowFail: true }).status !== 0) {
    reasons.push(`提交 ${commit.slice(0, 12)} 不在 ${spec.branch} 分支上`)
  }
  let cfg
  try {
    cfg = loadEnv(env, commit)
  } catch (error) {
    fail(error.message)
  }
  const target = targetState(cfg)
  if (target.lock) reasons.push(`${env} 正在被另一个发布占用：${target.lock}`)
  if (target.release?.commit === commit) reasons.push(`${env} 已经在运行 ${commit.slice(0, 12)}（${target.release.tag}）`)
  let evidence = null
  if (env === 'production') {
    const previewCfg = loadEnv('preview', commit)
    const preview = targetState(previewCfg)
    evidence = productionEvidence({
      tag, commit,
      tagsOnCommit: git('tag', '--points-at', commit).split('\n').filter(Boolean),
      previewRecords: preview.records,
      previewHostCommit: preview.release?.commit ?? null,
      previewPublicCommit: await publicCommit(previewCfg),
    })
    reasons.push(...evidence.reasons)
  }
  log(`环境      ${env}（${cfg.RELEASE_SSH}）`)
  log(`tag       ${tag} → ${commit}`)
  log(`当前      ${target.path || '（无）'}  ${target.release?.tag ?? target.release?.releaseId ?? ''}`)
  if (evidence?.deploy) log(`预发布证据 部署 ${evidence.deploy.releaseId} @ ${evidence.deploy.at}；验收 ${evidence.accept?.at ?? '（无）'}`)
  if (reasons.length) {
    for (const reason of reasons) console.error(`  ✗ ${reason}`)
    return null
  }
  log('  ✓ 门禁全部通过')
  return { env, tag, commit, version: pkg.version, cfg, target }
}

/* ───────────── build ───────────── */

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, base, out)
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function build(release) {
  if (!process.version.startsWith('v24.')) fail(`构建必须用 Node 24（当前 ${process.version}），例如 fnm exec --using 24 node scripts/release.mjs …`)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-release-'))
  const tree = path.join(work, 'tree')
  const buildLog = path.join(work, 'build.log')
  git('worktree', 'add', '--detach', tree, release.commit)
  try {
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }
    for (const args of [['ci', '--no-audit', '--no-fund'], ['test'], ['run', 'lint'], ['run', 'build']]) {
      log(`  · npm ${args.join(' ')}`)
      const result = run('npm', args, { cwd: tree, env, allowFail: true })
      fs.appendFileSync(buildLog, `\n$ npm ${args.join(' ')}\n${result.stdout}${result.stderr}`)
      if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 失败，日志 ${buildLog}\n${`${result.stdout}${result.stderr}`.trim().split('\n').slice(-40).join('\n')}`)
    }
    const tracked = run('git', ['-C', tree, 'ls-files', '-z']).stdout.split('\0').filter(Boolean)
    const files = [...new Set([...tracked.filter(shippable), ...listFiles(path.join(tree, 'dist')).map((file) => `dist/${file}`)])]
      .filter((file) => file !== 'RELEASE.json' && file !== 'MANIFEST.sha256' && fs.statSync(path.join(tree, file), { throwIfNoEntry: false })?.isFile())
      .sort()
    const meta = {
      releaseId: release.releaseId, env: release.env, version: release.version, tag: release.tag, commit: release.commit,
      createdAt: new Date().toISOString(), builtBy: 'scripts/release.mjs', node: process.version,
      lockSha256: sha256(fs.readFileSync(path.join(tree, 'package-lock.json'))), files: files.length + 1,
    }
    fs.writeFileSync(path.join(tree, 'RELEASE.json'), `${JSON.stringify(meta, null, 1)}\n`)
    const manifest = ['RELEASE.json', ...files].map((file) => `${sha256(fs.readFileSync(path.join(tree, file)))}  ${file}`).join('\n')
    fs.writeFileSync(path.join(tree, 'MANIFEST.sha256'), `${manifest}\n`)
    const list = path.join(work, 'files.txt')
    fs.writeFileSync(list, ['RELEASE.json', 'MANIFEST.sha256', ...files].join('\n'))
    const pkg = path.join(work, `${release.releaseId}.tar.gz`)
    run('tar', ['-czf', pkg, '-C', tree, '-T', list], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    log(`  · 包 ${(fs.statSync(pkg).size / 1048576).toFixed(1)} MB，${files.length + 2} 个文件`)
    return { work, pkg, meta }
  } finally {
    run('git', ['-C', REPO, 'worktree', 'remove', '--force', tree], { allowFail: true })
  }
}

/* ───────────── remote steps ───────────── */

const LOCK_SH = String.raw`
set -eu
ROOT=$1 OWNER=$2
mkdir -p "$ROOT"
mkdir "$ROOT/.release.lock" 2>/dev/null || { echo "locked: $(cat "$ROOT/.release.lock/owner" 2>/dev/null)" >&2; exit 9; }
printf '%s\n' "$OWNER" > "$ROOT/.release.lock/owner"
`
const UNLOCK_SH = String.raw`rm -rf "$1/.release.lock"`

// 解包 → 校验清单 → node_modules（锁文件相同就从现有发布硬链接复制，否则 npm ci）→ 落到正式目录名
const INSTALL_SH = String.raw`
set -euo pipefail
ROOT=$1 ID=$2 NODE_BIN=$3 CURRENT=$4
inc="$ROOT/.incoming"; part="$inc/$ID.partial"; dest="$ROOT/$ID"
[ ! -e "$dest" ] || { echo "发布目录已存在：$dest" >&2; exit 3; }
rm -rf "$part"; mkdir -p "$part"
tar --no-same-owner -xzf "$inc/$ID.tar.gz" -C "$part"
(cd "$part" && sha256sum --quiet --strict -c MANIFEST.sha256)
lock=$(sha256sum "$part/package-lock.json" | cut -d' ' -f1)
src=""
for d in "$(readlink -f "$CURRENT" 2>/dev/null)" "$ROOT"/*; do
  [ -n "$d" ] && [ -f "$d/package-lock.json" ] && [ "$d" != "$part" ] || continue
  [ "$(sha256sum "$d/package-lock.json" | cut -d' ' -f1)" = "$lock" ] || continue
  nm=$(readlink -f "$d/node_modules" 2>/dev/null || true)
  [ -n "$nm" ] && [ -x "$nm/.bin/tsx" ] || continue
  src=$nm; break
done
if [ -n "$src" ]; then
  cp -al "$src" "$part/node_modules"; echo "node_modules：硬链接复制自 $src"
else
  (cd "$part" && PATH="$NODE_BIN:$PATH" npm ci --no-audit --no-fund --loglevel=error); echo "node_modules：npm ci"
fi
mv "$part" "$dest"; rm -f "$inc/$ID.tar.gz"
echo "installed $dest"
`

// 原子切换 current；env 文件经 drop-in 随发布目录生效（旧发布没有这个文件时用 - 前缀忽略）
const SWITCH_SH = String.raw`
set -euo pipefail
TARGET=$1 CURRENT=$2 SERVICE=$3 ENVNAME=$4
ln -sfn "$TARGET" "$CURRENT.next" && mv -T "$CURRENT.next" "$CURRENT"
dir="/etc/systemd/system/$SERVICE.d"; conf="$dir/10-release-env.conf"
want=$(printf '[Service]\nEnvironmentFile=-%s/deploy/env/%s.env\n' "$CURRENT" "$ENVNAME")
mkdir -p "$dir"
if [ "$(cat "$conf" 2>/dev/null)" != "$want" ]; then printf '%s\n' "$want" > "$conf"; systemctl daemon-reload; echo "drop-in 更新：$conf"; fi
envfile="$CURRENT/deploy/env/$ENVNAME.env"
secret=$(systemctl show -p EnvironmentFiles "$SERVICE" | tr ' ' '\n' | grep -o '/[^ ]*\.env' | grep -v "deploy/env" | head -1 || true)
if [ -f "$envfile" ] && [ -n "$secret" ] && [ -f "$secret" ]; then
  dup=$(comm -12 <(grep -oE '^[A-Z_][A-Z0-9_]*' "$envfile" | sort -u) <(grep -oE '^[A-Z_][A-Z0-9_]*' "$secret" | sort -u) | tr '\n' ' ')
  [ -z "$dup" ] || echo "注意：$secret 里也有这些键（仓库 env 文件优先）：$dup"
fi
systemctl restart "$SERVICE"
`

const HEALTH_SH = String.raw`
set -u
URL=$1 COMMIT=$2 SERVICE=$3 LIMIT=$4
session=000; page=000
for i in $(seq 1 "$LIMIT"); do
  if systemctl is-active --quiet "$SERVICE"; then
    if [ -n "$COMMIT" ]; then
      body=$(curl -fsS -m 3 "$URL/api/public/release" 2>/dev/null || true)
      case "$body" in *"\"commit\":\"$COMMIT\""*) ;; *) sleep 1; continue ;; esac
    fi
    session=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$URL/api/session" || true)
    page=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$URL/" || true)
    if [ "$session" = 200 ] && [ "$page" = 200 ]; then echo "健康（$i 秒）"; exit 0; fi
  fi
  sleep 1
done
echo "不健康：active=$(systemctl is-active "$SERVICE") session=$session page=$page"
journalctl -u "$SERVICE" -n 25 --no-pager -o cat | cut -c1-300
exit 1
`

const RECORD_SH = String.raw`
set -eu
printf '%s\n' "$(printf '%s' "$2" | base64 -d)" >> "$1/deployments.jsonl"
`

function record(cfg, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), operator: `${os.userInfo().username}@${os.hostname()}`, ...entry })
  remote(cfg, RECORD_SH, [cfg.RELEASE_ROOT, Buffer.from(line).toString('base64')])
}

function lock(cfg, action) {
  const owner = `${action} ${os.userInfo().username}@${os.hostname()} pid=${process.pid} ${new Date().toISOString()}`
  const result = remote(cfg, LOCK_SH, [cfg.RELEASE_ROOT, owner], { allowFail: true })
  if (result.status !== 0) fail(`拿不到发布锁：${result.stderr.trim()}`)
  return () => remote(cfg, UNLOCK_SH, [cfg.RELEASE_ROOT], { allowFail: true })
}

function health(cfg, commit) {
  const result = remote(cfg, HEALTH_SH, [cfg.RELEASE_HEALTH_URL, commit ?? '', cfg.RELEASE_SERVICE, '120'], { allowFail: true })
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() }
}

function switchTo(cfg, env, target) {
  const result = remote(cfg, SWITCH_SH, [target, cfg.RELEASE_CURRENT, cfg.RELEASE_SERVICE, env], { allowFail: true })
  const output = `${result.stdout}${result.stderr}`.trim()
  if (output) log(output.split('\n').map((line) => `  · ${line}`).join('\n'))
  return result.status === 0
}

/* ───────────── commands ───────────── */

async function deploy(env, tag) {
  const planned = await plan(env, tag)
  if (!planned) process.exit(1)
  const { cfg, commit, version, target } = planned
  const releaseId = releaseIdFor(tag)
  log(`构建 ${releaseId}`)
  const built = build({ env, tag, commit, version, releaseId })
  const unlock = lock(cfg, `deploy ${tag}`)
  const dest = `${cfg.RELEASE_ROOT}/${releaseId}`
  try {
    remote(cfg, 'mkdir -p "$1/.incoming"', [cfg.RELEASE_ROOT])
    run('scp', ['-q', '-o', 'BatchMode=yes', built.pkg, `${cfg.RELEASE_SSH}:${cfg.RELEASE_ROOT}/.incoming/${releaseId}.tar.gz`])
    log(remote(cfg, INSTALL_SH, [cfg.RELEASE_ROOT, releaseId, cfg.RELEASE_NODE, cfg.RELEASE_CURRENT]).stdout.trim().split('\n').map((line) => `  · ${line}`).join('\n'))
    const previous = target.path || null
    const base = { env, tag, commit, releaseId, path: dest, previous }
    const switched = switchTo(cfg, env, dest)
    const checked = switched ? health(cfg, commit) : { ok: false, output: '切换或重启失败' }
    if (checked.ok) {
      record(cfg, { action: 'deploy', result: 'success', ...base })
      log(`✓ ${env} 已切到 ${releaseId}：${checked.output}`)
      return
    }
    console.error(`✗ 新版本不健康，切回 ${previous}\n${checked.output}`)
    let restored = 'no-previous'
    if (previous) {
      const back = switchTo(cfg, env, previous) && health(cfg, '').ok
      restored = back ? 'restored' : 'restore-failed'
    }
    record(cfg, { action: 'deploy', result: 'failed', ...base, rollback: restored, detail: checked.output.slice(-1500) })
    throw new Error(`部署失败，回滚结果：${restored}`)
  } finally {
    unlock()
    fs.rmSync(built.work, { recursive: true, force: true })
  }
}

async function accept(env) {
  const cfg = loadEnv(env)
  const target = targetState(cfg)
  const release = target.release
  if (!release?.commit) fail(`${env} 当前发布没有提交号（${target.path}），不是 release.mjs 发布的，不能验收`)
  const checks = []
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, detail: detail ?? '' })
      log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error.message ?? error).slice(0, 300) })
      log(`  ✗ ${name}  ${error.message ?? error}`)
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  log(`验收 ${env}：${release.tag} ${release.commit.slice(0, 12)}（${target.path}）`)
  const consoleUrl = cfg.RELEASE_CONSOLE_URL
  await check('控制台发布身份', async () => {
    const { status, headers, text } = await fetchText(`${consoleUrl}/api/public/release`)
    expect(status === 200, `HTTP ${status}`)
    const body = JSON.parse(text)
    expect(body.commit === release.commit, `公网 commit ${body.commit} ≠ ${release.commit}`)
    expect(body.env === env, `env ${body.env}`)
    expect(headers.get('cache-control') === 'no-store', `cache-control ${headers.get('cache-control')}`)
    return body.tag
  })
  await check('控制台页面与静态资源', async () => {
    const page = await fetchText(`${consoleUrl}/`)
    expect(page.status === 200 && /<div id="app"/.test(page.text), `首页 HTTP ${page.status}`)
    const asset = page.text.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    expect(asset, '首页没有 /assets/*.js')
    const js = await fetchText(`${consoleUrl}${asset}`)
    expect(js.status === 200 && js.text.length > 1000, `${asset} HTTP ${js.status}`)
    return `${asset} cache-control=${js.headers.get('cache-control')}`
  })
  await check('控制台登录态探测', async () => {
    const { status, text } = await fetchText(`${consoleUrl}/api/session`)
    expect(status === 200 && JSON.parse(text).authenticated === false, `HTTP ${status} ${text.slice(0, 80)}`)
  })
  const key = process.env.RELEASE_ACCEPT_KEY
  let api = 'skipped'
  if (key) {
    const apiUrl = `${cfg.RELEASE_API_URL}/v1`
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const post = (body) => fetchText(`${apiUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, 120_000)
    const before = checks.length
    await check('网关 /v1/models', async () => {
      const { status, text } = await fetchText(`${apiUrl}/models`, { headers })
      expect(status === 200, `HTTP ${status} ${text.slice(0, 120)}`)
      const count = JSON.parse(text).data?.length ?? 0
      expect(count > 0, '模型列表为空')
      return `${count} 个模型`
    })
    const models = (cfg.RELEASE_ACCEPT_MODELS ?? '').split(',').map((model) => model.trim()).filter(Boolean)
    if (!models.length) checks.push({ name: 'RELEASE_ACCEPT_MODELS', ok: false, detail: '未配置要实测的模型' })
    for (const model of models) {
      await check(`${model} JSON`, async () => {
        const { status, text } = await post({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 64 })
        expect(status === 200, `HTTP ${status} ${text.slice(0, 160)}`)
        const content = JSON.parse(text).choices?.[0]?.message?.content ?? ''
        expect(content.trim(), '没有回复内容')
        return JSON.stringify(content.trim().slice(0, 30))
      })
      await check(`${model} SSE`, async () => {
        const { status, text } = await post({ model, stream: true, messages: [{ role: 'user', content: 'Count from 1 to 5.' }], max_tokens: 64 })
        expect(status === 200, `HTTP ${status} ${text.slice(0, 160)}`)
        const events = text.split('\n').filter((line) => line.startsWith('data:'))
        expect(events.some((line) => line.includes('[DONE]')), '流没有 [DONE]')
        const deltas = events.filter((line) => /"content":"[^"]/.test(line)).length
        expect(deltas > 0, '流里没有内容增量')
        return `${events.length} 个事件`
      })
      await check(`${model} 工具往返`, async () => {
        const tools = [{ type: 'function', function: { name: 'get_build_number', description: 'Returns the current build number.', parameters: { type: 'object', properties: {} } } }]
        const messages = [{ role: 'user', content: 'Call get_build_number, then reply with only the number it returned.' }]
        const first = await post({ model, messages, tools, max_tokens: 256 })
        expect(first.status === 200, `HTTP ${first.status} ${first.text.slice(0, 160)}`)
        const call = JSON.parse(first.text).choices?.[0]?.message
        const toolCall = call?.tool_calls?.[0]
        expect(toolCall?.function?.name === 'get_build_number', `模型没有调用工具：${JSON.stringify(call).slice(0, 160)}`)
        messages.push({ role: 'assistant', content: call.content ?? null, tool_calls: call.tool_calls })
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: '4217' })
        const second = await post({ model, messages, tools, max_tokens: 256 })
        expect(second.status === 200, `HTTP ${second.status} ${second.text.slice(0, 160)}`)
        const answer = JSON.parse(second.text).choices?.[0]?.message?.content ?? ''
        expect(answer.includes('4217'), `回复里没有工具结果：${answer.slice(0, 80)}`)
      })
    }
    api = checks.slice(before).every((entry) => entry.ok) ? 'passed' : 'failed'
  } else {
    log('  · 未提供 RELEASE_ACCEPT_KEY，跳过网关请求')
  }
  const ok = checks.every((entry) => entry.ok) && (env !== 'preview' || api === 'passed')
  record(cfg, { action: 'accept', result: ok ? 'success' : 'failed', env, tag: release.tag, commit: release.commit, releaseId: release.releaseId, path: target.path, api, checks })
  if (!ok) fail(env === 'preview' && api !== 'passed' ? `验收未通过（预发布必须含网关请求，api=${api}）` : '验收未通过')
  log(`✓ ${env} 验收通过（api=${api}）`)
}

async function status(env) {
  const cfg = loadEnv(env)
  const target = targetState(cfg)
  log(`环境 ${env}（${cfg.RELEASE_SSH}）`)
  log(`当前 ${target.path}`)
  log(`发布 ${target.release ? `${target.release.tag ?? '-'} ${target.release.commit ?? '-'} ${target.release.releaseId ?? ''}` : '（无 RELEASE.json）'}`)
  log(`公网 ${(await publicCommit(cfg)) ?? '（取不到）'}`)
  if (target.lock) log(`锁   ${target.lock}`)
  for (const entry of target.records.slice(-10)) {
    log(`  ${entry.at} ${entry.action.padEnd(8)} ${entry.result.padEnd(7)} ${entry.tag ?? ''} ${(entry.commit ?? '').slice(0, 12)} ${entry.api ? `api=${entry.api}` : ''} ${entry.rollback ?? ''}`)
  }
}

async function rollback(env, to) {
  const cfg = loadEnv(env)
  const target = targetState(cfg)
  const destination = to ?? rollbackTarget(target.records, target.path)
  if (!destination) fail(`找不到 ${target.path} 的上一个发布；用 --to <发布目录> 指定`)
  if (!destination.startsWith(`${cfg.RELEASE_ROOT}/`)) fail(`回滚目标必须在 ${cfg.RELEASE_ROOT}/ 下`)
  const unlock = lock(cfg, `rollback → ${destination}`)
  try {
    const exists = remote(cfg, 'test -f "$1/package.json"', [destination], { allowFail: true }).status === 0
    if (!exists) throw new Error(`${destination} 不是完整的发布目录`)
    log(`回滚 ${env}：${target.path} → ${destination}`)
    const checked = switchTo(cfg, env, destination) ? health(cfg, '') : { ok: false, output: '切换或重启失败' }
    const meta = { env, path: destination, previous: target.path, commit: null, tag: null }
    if (checked.ok) {
      record(cfg, { action: 'rollback', result: 'success', ...meta })
      log(`✓ 已回滚：${checked.output}`)
      return
    }
    console.error(`✗ 回滚目标不健康，切回 ${target.path}\n${checked.output}`)
    const back = switchTo(cfg, env, target.path) && health(cfg, '').ok
    record(cfg, { action: 'rollback', result: 'failed', ...meta, rollback: back ? 'restored' : 'restore-failed', detail: checked.output.slice(-1500) })
    throw new Error(`回滚失败（${back ? '已恢复原版本' : '原版本也没起来，立即人工处理'}）`)
  } finally {
    unlock()
  }
}

const [command, env, ...rest] = process.argv.slice(2)
try {
  if (command === 'plan' && env && rest[0]) process.exit((await plan(env, rest[0])) ? 0 : 1)
  else if (command === 'deploy' && env && rest[0]) await deploy(env, rest[0])
  else if (command === 'accept' && env) await accept(env)
  else if (command === 'status' && env) await status(env)
  else if (command === 'rollback' && env) await rollback(env, rest[0] === '--to' ? rest[1] : undefined)
  else {
    console.error('用法：node scripts/release.mjs <plan|deploy> <preview|production> <tag> | <accept|status|rollback> <preview|production>')
    process.exit(2)
  }
} catch (error) {
  fail(error.message ?? String(error))
}
