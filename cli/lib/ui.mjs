// 终端输出：颜色、字形、显示宽度（CJK 计 2 列）、表格、状态行、数值格式。对齐 crapi 的 ui 包。

const PALETTE = {
  brand: [[245, 165, 36], 33],
  accent: [[20, 184, 166], 36],
  muted: [[138, 143, 152], 90],
  ok: [[34, 197, 94], 32],
  warn: [[234, 179, 8], 33],
  err: [[239, 68, 68], 31],
  info: [[96, 165, 250], 34],
}

const GLYPHS = {
  unicode: { ok: '✓', fail: '✗', warn: '!', info: 'i', arrow: '→', dot: '●', bullet: '•', mark: '◆', sep: '│', ellipsis: '…', h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯', lt: '├', rt: '┤', tt: '┬', bt: '┴', x: '┼' },
  ascii: { ok: '+', fail: 'x', warn: '!', info: 'i', arrow: '->', dot: '*', bullet: '-', mark: '*', sep: '|', ellipsis: '~', h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', lt: '+', rt: '+', tt: '+', bt: '+', x: '+' },
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
export const stripAnsi = text => String(text).replace(ANSI, '')

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f]]
const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

function graphemeWidth(grapheme) {
  const cp = grapheme.codePointAt(0)
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (inRanges(cp, ZERO)) return 0
  if (inRanges(cp, WIDE)) return 2
  if (grapheme.includes('️')) return 2
  return 1
}

export function displayWidth(text) {
  let width = 0
  for (const { segment } of segmenter.segment(stripAnsi(text))) width += graphemeWidth(segment)
  return width
}

export function truncate(text, width, ellipsis = '…') {
  const plain = stripAnsi(text)
  if (displayWidth(plain) <= width) return plain
  const room = width - displayWidth(ellipsis)
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(plain)) {
    const w = graphemeWidth(segment)
    if (used + w > room) break
    out += segment
    used += w
  }
  return out + ellipsis
}

export function pad(text, width, align = 'left') {
  const gap = Math.max(0, width - displayWidth(text))
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(gap - Math.floor(gap / 2))
  return text + ' '.repeat(gap)
}

export function chooseGlyphs(env, platformTerm = env.TERM) {
  const forced = String(env.CRADMIN_GLYPHS || env.CRAPI_GLYPHS || '').toLowerCase()
  if (forced === 'ascii') return 'ascii'
  if (forced === 'unicode' || forced === 'utf8') return 'unicode'
  return platformTerm === 'linux' ? 'ascii' : 'unicode'
}

export function colorEnabled(stream, env, noColor = false) {
  if (noColor || env.NO_COLOR || env.TERM === 'dumb') return false
  return Boolean(stream?.isTTY)
}

function painter(enabled, depth) {
  return (tone, text, bold = false) => {
    if (!enabled || !tone || !PALETTE[tone]) return bold && enabled ? `\x1b[1m${text}\x1b[22m` : String(text)
    const [[r, g, b], basic] = PALETTE[tone]
    const open = depth >= 24 ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[${basic}m`
    return `${bold ? '\x1b[1m' : ''}${open}${text}\x1b[39m${bold ? '\x1b[22m' : ''}`
  }
}

/** 一个进程一份；`json` 模式下所有装饰行改写到 stderr，保证 stdout 只有 JSON。 */
export function createUi({ stdout, stderr, env = {}, noColor = false, json = false }) {
  const glyphMode = chooseGlyphs(env)
  const g = GLYPHS[glyphMode]
  const depthOf = stream => (typeof stream?.getColorDepth === 'function' ? stream.getColorDepth(env) : 4)
  const outColor = colorEnabled(json ? stderr : stdout, env, noColor)
  const errColor = colorEnabled(stderr, env, noColor)
  const paintOut = painter(outColor, depthOf(json ? stderr : stdout))
  const paintErr = painter(errColor, depthOf(stderr))
  const deco = json ? stderr : stdout
  const write = (stream, line = '') => stream.write(`${line}\n`)

  const ui = {
    g, glyphMode, json, color: outColor,
    paint: paintOut,
    paintErr,
    line: (text = '') => write(deco, text),
    /** 只给真正的数据输出（JSON、完整 Key）用 */
    data: text => write(stdout, text),
    success: msg => write(deco, `${paintOut('ok', g.ok)} ${msg}`),
    warn: msg => write(deco, `${paintOut('warn', g.warn)} ${msg}`),
    warnErr: msg => write(stderr, `${paintErr('warn', g.warn)} ${msg}`),
    fail: msg => write(stderr, `${paintErr('err', g.fail)} ${msg}`),
    note: msg => write(deco, `  ${paintOut('muted', msg)}`),
    noteErr: msg => write(stderr, `  ${paintErr('muted', msg)}`),
    section(title, hint = '') {
      write(deco)
      write(deco, `${paintOut('brand', g.mark)} ${paintOut(null, title, true)}${hint ? `  ${paintOut('muted', hint)}` : ''}`)
    },
    kv(label, value) {
      // 标签补到 10 列；超长标签（如 antigravity）至少留一个空格
      write(deco, `  ${paintOut('muted', pad(label, 10))}${displayWidth(label) >= 10 ? ' ' : ''}${value}`)
    },
    banner(title, subtitle) {
      const lines = [title, subtitle].filter(Boolean)
      const inner = Math.max(...lines.map(displayWidth)) + 4
      const border = text => paintOut('brand', text)
      write(deco, border(g.tl + g.h.repeat(inner) + g.tr))
      lines.forEach((text, index) => {
        const body = index === 0 ? paintOut(null, text, true) : paintOut('muted', text)
        write(deco, `${border(g.v)}  ${body}${' '.repeat(inner - 2 - displayWidth(text))}${border(g.v)}`)
      })
      write(deco, border(g.bl + g.h.repeat(inner) + g.br))
    },
    /**
     * 圆角灰边表格，表头品牌黄；单元格可以是字符串或 {text, tone}。align: 'left'|'right'|'center'。
     * 宽度超出终端时，从最宽的列开始截断（截断按显示宽度，末尾 …/~）。
     */
    table(headers, rows, { align = [], maxWidth = (stdout.columns || 0) } = {}) {
      write(deco, renderTable(headers, rows, { align, maxWidth, g, paint: paintOut }))
    },
    renderTable: (headers, rows, options = {}) => renderTable(headers, rows, { align: [], maxWidth: 0, ...options, g, paint: paintOut }),
  }
  return ui
}

const cellText = cell => (cell === null || cell === undefined ? '' : typeof cell === 'object' ? String(cell.text ?? '') : String(cell))
const cellTone = cell => (cell && typeof cell === 'object' ? cell.tone : null)

export function renderTable(headers, rows, { align = [], maxWidth = 0, g = GLYPHS.unicode, paint = (_tone, text) => String(text) } = {}) {
  const widths = headers.map((header, column) => Math.max(displayWidth(header), ...rows.map(row => displayWidth(cellText(row[column])))))
  const frame = 2 + 1 + widths.length * 3
  if (maxWidth > 0) {
    while (widths.reduce((a, b) => a + b, 0) + frame > maxWidth) {
      const widest = widths.indexOf(Math.max(...widths))
      if (widths[widest] <= 6) break
      widths[widest] -= 1
    }
  }
  const border = text => paint('muted', text)
  const rule = (left, mid, right) => '  ' + border(left + widths.map(width => g.h.repeat(width + 2)).join(mid) + right)
  const renderRow = (cells, header = false) => '  ' + border(g.v) + cells.map((cell, column) => {
    const text = truncate(cellText(cell), widths[column], g.ellipsis)
    const padded = pad(text, widths[column], header ? 'left' : align[column] || 'left')
    const styled = header ? paint('brand', padded, true) : cellTone(cell) ? paint(cellTone(cell), padded) : padded
    return ` ${styled} `
  }).join(border(g.v)) + border(g.v)
  const out = [rule(g.tl, g.tt, g.tr), renderRow(headers, true), rule(g.lt, g.x, g.rt)]
  for (const row of rows) out.push(renderRow(row))
  out.push(rule(g.bl, g.bt, g.br))
  return out.join('\n')
}

/* ────────── 数值与时间 ────────── */

export function usd(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-'
  const n = Number(value)
  if (n === 0) return '$0'
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`
  const small = n.toFixed(6).replace(/\.?0+$/, '')
  return small === '0' || small === '-0' ? '<$0.000001' : `$${small}`
}

export function tokens(value) {
  const n = Number(value) || 0
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

export const count = value => (Number(value) || 0).toLocaleString('en-US')

export function percent(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '-'
  return `${(Number(ratio) * 100).toFixed(digits)}%`
}

export function time(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  const two = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function clock(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
}
