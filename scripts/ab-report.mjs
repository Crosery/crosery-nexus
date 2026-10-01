#!/usr/bin/env node
/**
 * A/B 偏好留痕汇总（只读）。
 *
 * 数据源：`POST /api/ab/preference` 追加写的 JSONL
 *   默认 `<DATA_DIR || data>/ab-preferences.jsonl`（可用 `--file` 覆盖）。
 *
 * 用法：
 *   node scripts/ab-report.mjs                 # 人类可读汇总
 *   node scripts/ab-report.mjs --json          # 机器可读（给别的工具用）
 *   node scripts/ab-report.mjs --limit 5       # 每个流程最多列 5 条理由
 *   node scripts/ab-report.mjs --file /tmp/x.jsonl
 *
 * 退出码：0 = 正常（含「还没有票」）；1 = 参数错误或文件不可读。
 * 只做聚合，不写任何文件；打印内容来自用户自由文本，已由服务端脱敏。
 */

import fs from 'node:fs'
import path from 'node:path'

const FLOW_IDS = ['keys-access', 'integration-rtk', 'dashboard-overview']
const FLOW_TITLES = {
  'keys-access': '① API Key 列表：筛选 / 搜索 / 删除确认',
  'integration-rtk': '② 接入与 RTK 配置',
  'dashboard-overview': '③ 运行概览 Dashboard 首屏',
}
const CHOICES = ['a', 'b', 'neither']
const CHOICE_LABEL = { a: '选 A（迁移前）', b: '选 B（迁移后）', neither: '都不行' }

function parseArgs(argv) {
  const options = { file: '', json: false, limit: 5 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--file') options.file = argv[++index] || ''
    else if (arg === '--limit') options.limit = Math.max(0, Number(argv[++index]) || 0)
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error(`未知参数：${arg}（用 --help 看用法）`)
      process.exit(1)
    }
  }
  return options
}

function resolveFile(options) {
  if (options.file) return path.resolve(options.file)
  const dataDir = process.env.DATA_DIR || path.resolve('data')
  return path.join(dataDir, 'ab-preferences.jsonl')
}

function readRecords(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const records = []
  const malformed = []
  raw.split('\n').forEach((line, index) => {
    const text = line.trim()
    if (!text) return
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') records.push(parsed)
      else malformed.push(index + 1)
    } catch {
      malformed.push(index + 1)
    }
  })
  return { records, malformed }
}

function summarize(records, limit) {
  const flows = new Map()
  for (const id of FLOW_IDS) flows.set(id, { id, title: FLOW_TITLES[id], votes: { a: 0, b: 0, neither: 0 }, reasons: [], blockers: [], redacted: 0, unknownChoice: 0 })
  const unknownFlows = []
  let firstAt = null
  let lastAt = null

  for (const record of records) {
    const bucket = flows.get(record.flow)
    if (!bucket) {
      unknownFlows.push(record.flow ?? '(无 flow 字段)')
      continue
    }
    if (CHOICES.includes(record.choice)) bucket.votes[record.choice] += 1
    else bucket.unknownChoice += 1
    if (record.redacted) bucket.redacted += 1
    const at = typeof record.at === 'string' ? record.at : null
    if (at && (!firstAt || at < firstAt)) firstAt = at
    if (at && (!lastAt || at > lastAt)) lastAt = at
    if (typeof record.note === 'string' && record.note.trim()) {
      bucket.reasons.push({ at, choice: record.choice, note: record.note.trim() })
    }
    if (typeof record.blocker === 'string' && record.blocker.trim()) {
      bucket.blockers.push({ at, blocker: record.blocker.trim() })
    }
  }

  return {
    total: records.length,
    firstAt,
    lastAt,
    flows: [...flows.values()].map((bucket) => ({
      ...bucket,
      reasons: bucket.reasons.slice(-limit),
      blockers: bucket.blockers.slice(-limit),
    })),
    unknownFlows,
  }
}

function printHuman(summary, file, malformed) {
  console.log(`A/B 偏好留痕汇总 · 文件：${file}`)
  if (summary.total === 0) {
    console.log('还没有任何投票。把 http://127.0.0.1:8791/ab 发给用户自己走一遍即可，不需要打断他。')
    return
  }
  console.log(`共 ${summary.total} 票｜时间范围 ${summary.firstAt || '?'} → ${summary.lastAt || '?'}`)
  console.log('')
  for (const flow of summary.flows) {
    const votes = flow.votes
    const decided = votes.a + votes.b
    const rate = decided ? `（A:B = ${Math.round((votes.a / decided) * 100)}% : ${Math.round((votes.b / decided) * 100)}%）` : ''
    console.log(`【${flow.title}】  样本量 ${flow.votes.a + votes.b + flow.votes.neither}`)
    console.log(`  A ${votes.a} · B ${votes.b} · 都不行 ${votes.neither} ${rate}`)
    if (flow.unknownChoice) console.log(`  ⚠️ 无法识别的 choice：${flow.unknownChoice} 条`)
    if (flow.redacted) console.log(`  ⚠️ 有 ${flow.redacted} 条理由里出现疑似密钥/长串，已被服务端替换为「[已隐去疑似密钥]」`)
    if (flow.reasons.length === 0) console.log('  理由：（无）')
    else {
      console.log('  理由：')
      for (const item of flow.reasons) console.log(`    - [${CHOICE_LABEL[item.choice] || item.choice || '?'}] ${item.note}`)
    }
    if (flow.blockers.length) {
      console.log('  卡点：')
      for (const item of flow.blockers) console.log(`    - ${item.blocker}`)
    }
    console.log('')
  }
  if (summary.unknownFlows.length) console.log(`⚠️ 未知 flow 的记录 ${summary.unknownFlows.length} 条：${[...new Set(summary.unknownFlows)].join(', ')}`)
  if (malformed.length) console.log(`⚠️ 解析失败的行：${malformed.length} 行（行号 ${malformed.slice(0, 10).join(', ')}${malformed.length > 10 ? ' …' : ''}）`)
  console.log('提醒：以上是主观偏好，样本量可能只有 1 人，不得外推成「所有用户都觉得 B 更好」。')
}

function printHelp() {
  console.log('用法：node scripts/ab-report.mjs [--file <jsonl>] [--limit <n>] [--json]')
  console.log('  默认文件：$DATA_DIR/ab-preferences.jsonl 或 ./data/ab-preferences.jsonl')
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const file = resolveFile(options)
if (!fs.existsSync(file)) {
  if (options.json) console.log(JSON.stringify({ file, total: 0, flows: [], missing: true }, null, 2))
  else console.log(`还没有投票记录（文件不存在）：${file}\n把 http://127.0.0.1:8791/ab 发给用户自己走一遍即可，不需要打断他。`)
  process.exit(0)
}

let read
try {
  read = readRecords(file)
} catch (error) {
  console.error(`读取失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const summary = summarize(read.records, options.limit)
if (options.json) console.log(JSON.stringify({ file, malformed: read.malformed.length, ...summary }, null, 2))
else printHuman(summary, file, read.malformed)
