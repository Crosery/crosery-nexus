// 发布规则（纯函数，scripts/release.mjs 调用，release-policy.test.mjs 覆盖）。
// 模型：stage 上的提交打 vX.Y.Z-rc.N → 预发布；预发布部署成功并验收通过后，同一提交打 vX.Y.Z → 正式。

export const ENVIRONMENTS = {
  preview: { branch: 'stage', tag: 'rc' },
  production: { branch: 'main', tag: 'final' },
}

const NUM = '(0|[1-9][0-9]*)'
const FINAL_RE = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}$`)
const RC_RE = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}-rc\\.([1-9][0-9]*)$`)

export function parseReleaseTag(tag) {
  const rc = RC_RE.exec(tag)
  if (rc) return { version: `${rc[1]}.${rc[2]}.${rc[3]}`, rc: Number(rc[4]) }
  const final = FINAL_RE.exec(tag)
  if (final) return { version: `${final[1]}.${final[2]}.${final[3]}`, rc: null }
  return null
}

export function environment(env) {
  const spec = ENVIRONMENTS[env]
  if (!spec) throw new Error(`未知环境 ${env}（只有 ${Object.keys(ENVIRONMENTS).join(' / ')}）`)
  return spec
}

/** 预发布只收 vX.Y.Z-rc.N；正式只收 vX.Y.Z；X.Y.Z 必须等于该提交 package.json 的 version。 */
export function checkTag(env, tag, packageVersion) {
  const spec = environment(env)
  const parsed = parseReleaseTag(tag)
  if (!parsed) return [`tag ${tag} 不是 vX.Y.Z 或 vX.Y.Z-rc.N（不带前导 0）`]
  const reasons = []
  if (spec.tag === 'rc' && parsed.rc === null) reasons.push(`预发布只接受 vX.Y.Z-rc.N，收到正式 tag ${tag}`)
  if (spec.tag === 'final' && parsed.rc !== null) reasons.push(`正式只接受 vX.Y.Z，收到预发布 tag ${tag}`)
  if (parsed.version !== packageVersion) reasons.push(`tag 版本 ${parsed.version} ≠ 该提交 package.json 的 version ${packageVersion}`)
  return reasons
}

/** 发布目录名：时间在前便于排序，tag 在后便于辨认。 */
export function releaseIdFor(tag, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${stamp}-${tag}`
}

export function parseRecords(text) {
  const records = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (record && typeof record === 'object') records.push(record)
    } catch {
      // 半行（写入时断电）不作为证据
    }
  }
  return records
}

/**
 * 正式发布的前置证据，任一缺失即拒绝：
 * 1. 同一提交上有同一 X.Y.Z 的 rc tag；
 * 2. 预发布有该提交、来自这些 rc tag 之一的成功部署记录；
 * 3. 该次部署之后有针对同一发布目录、含网关真实请求的验收通过记录；
 * 4. 预发布此刻运行的（主机上的 RELEASE.json 与公网 /api/public/release）都是这个提交。
 */
export function productionEvidence({ tag, commit, tagsOnCommit, previewRecords, previewHostCommit, previewPublicCommit }) {
  const reasons = []
  const parsed = parseReleaseTag(tag)
  if (!parsed || parsed.rc !== null) return { ok: false, reasons: [`正式只接受 vX.Y.Z，收到 ${tag}`], deploy: null, accept: null }
  const rcTags = tagsOnCommit.filter((candidate) => {
    const rc = parseReleaseTag(candidate)
    return rc && rc.rc !== null && rc.version === parsed.version
  })
  if (!rcTags.length) reasons.push(`提交 ${commit.slice(0, 12)} 上没有 v${parsed.version}-rc.N`)
  const deploys = previewRecords.filter((record) => record.action === 'deploy' && record.result === 'success'
    && record.commit === commit && rcTags.includes(record.tag))
  const deploy = deploys.at(-1) ?? null
  if (!deploy) reasons.push(`预发布没有该提交来自 ${rcTags.join('/') || 'rc tag'} 的成功部署记录`)
  const accept = deploy
    ? previewRecords.filter((record) => record.action === 'accept' && record.result === 'success' && record.commit === commit
      && record.releaseId === deploy.releaseId && record.api === 'passed' && Date.parse(record.at) >= Date.parse(deploy.at)).at(-1) ?? null
    : null
  if (deploy && !accept) reasons.push(`预发布部署 ${deploy.releaseId} 之后没有含网关请求的验收通过记录`)
  if (previewHostCommit !== commit) reasons.push(`预发布主机当前运行 ${short(previewHostCommit)}，不是 ${commit.slice(0, 12)}`)
  if (previewPublicCommit !== commit) reasons.push(`预发布公网发布身份是 ${short(previewPublicCommit)}，不是 ${commit.slice(0, 12)}`)
  return { ok: reasons.length === 0, reasons, deploy, accept }
}

const short = (value) => (typeof value === 'string' && value ? value.slice(0, 12) : '（无）')

/** 回滚目标：当前发布目录对应的最近一次成功部署所记录的上一个目录。 */
export function rollbackTarget(records, currentPath) {
  const deploy = records.filter((record) => (record.action === 'deploy' || record.action === 'rollback')
    && record.result === 'success' && record.path === currentPath).at(-1)
  return deploy?.previous && deploy.previous !== currentPath ? deploy.previous : null
}

/** KEY=VALUE；# 注释与空行忽略；值两端成对的引号去掉。 */
export function parseEnvFile(text) {
  const env = {}
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) throw new Error(`env 行格式不对：${line}`)
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`env 键名不合法：${key}`)
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    env[key] = value
  }
  return env
}

/** 仓库 env 文件只放非密钥：键名像密钥的一律拒绝。 */
export function secretLikeKeys(env) {
  return Object.keys(env).filter((key) => /(PASSWORD|SECRET|TOKEN|_KEY$|^KEY$|PRESETS|CREDENTIAL)/.test(key) && !key.endsWith('_FILE'))
}

const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/

/**
 * 仓库公开：入库的 env 文件不得带密钥、发布目标、IP 或外部地址（只允许本机回环 URL）。
 * 这些都放目标机 .env 或本机不入库的 <env>.release.local。
 */
export function publicEnvProblems(env) {
  const problems = secretLikeKeys(env).map((key) => `${key} 像密钥`)
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('RELEASE_')) problems.push(`${key} 是发布目标，应放 deploy/env/<env>.release.local`)
    const ips = (value.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).filter((ip) => ip !== '127.0.0.1' && ip !== '0.0.0.0')
    if (ips.length) problems.push(`${key} 含 IP 地址`)
    if (/^https?:\/\//.test(value) && !LOOPBACK_URL.test(value)) problems.push(`${key} 含外部地址`)
  }
  return problems
}

/** 发布包里不放的跟踪文件（QA 交付物与本地状态）。 */
export const NEVER_SHIP = [/^docs\/qa\//, /^\.env$/, /^\.env\.(?!example$)/, /^node_modules\//, /^data\//, /(^|\/)\.DS_Store$/, /\.log$/]

export function shippable(file) {
  return !NEVER_SHIP.some((pattern) => pattern.test(file))
}
