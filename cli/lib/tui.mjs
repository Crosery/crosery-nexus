// 终端里的方向键选择：单选 / 多选（直接打字过滤）/ 是否确认。交互对齐 crapi：↑↓ 移动、打字过滤、Enter 确认、Esc 返回。
// 只用 Node 内置模块。parseKeys / createListState / applyListKey / listLines 是纯函数，可单测；runList / runConfirm 是读 stdin、写 stderr 的薄外壳。
import { CancelError } from './args.mjs'
import { displayWidth, pad, stripAnsi, truncate } from './ui.mjs'

/* ───────────── 按键解析 ───────────── */

const CSI_FINAL = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shift-tab' }
const CSI_TILDE = { 1: 'home', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' }
const CONTROL = { '\x01': 'ctrl-a', '\x03': 'ctrl-c', '\x0e': 'down', '\x10': 'up', '\x15': 'ctrl-u' }

/**
 * 一段原始输入（raw 模式下一次 data）→ 按键序列 [{name, text?, raw}]。
 * name：up down left right home end pageup pagedown delete tab shift-tab enter escape backspace space ctrl-a ctrl-c ctrl-u char。
 * 单独一个 ESC 是 Esc 键；ESC 后紧跟字符是 Alt 组合键或不认识的序列，整体忽略。raw 用来把没处理完的输入退回 stdin。
 */
export function parseKeys(chunk) {
  const text = String(chunk)
  const keys = []
  let i = 0
  while (i < text.length) {
    const start = i
    const ch = text[i]
    const push = (name, extra = {}) => keys.push({ name, raw: text.slice(start, i), ...extra })
    i += 1
    if (ch === '\x1b') {
      if (i >= text.length) { push('escape'); continue }
      const lead = text[i]
      if (lead === '\x1b') { push('escape'); continue }
      if (lead === '[' || lead === 'O') {
        let j = i + 1
        while (j < text.length && !/[@-~]/.test(text[j])) j += 1
        const body = text.slice(i + 1, j)
        const final = text[j] ?? ''
        i = Math.min(text.length, j + 1)
        const name = final === '~' ? CSI_TILDE[Number.parseInt(body, 10)] : CSI_FINAL[final]
        push(name ?? 'ignored')
      } else {
        i += 1
        push('ignored')
      }
      continue
    }
    if (ch === '\r') { if (text[i] === '\n') i += 1; push('enter'); continue }
    if (ch === '\n') { push('enter'); continue }
    if (ch === '\t') { push('tab'); continue }
    if (ch === '\x7f' || ch === '\b') { push('backspace'); continue }
    if (ch === ' ') { push('space', { text: ' ' }); continue }
    if (CONTROL[ch]) { push(CONTROL[ch]); continue }
    if (ch < ' ' || (ch >= '\x7f' && ch < '\x9f')) { push('ignored'); continue }
    const codePoint = String.fromCodePoint(text.codePointAt(i - 1))
    i = start + codePoint.length
    push('char', { text: codePoint })
  }
  return keys.filter(key => key.name !== 'ignored')
}

/* ───────────── 列表状态机 ───────────── */

/**
 * items: [{label, desc?, value, search?, checked?}]；
 * multiple：空格勾选；filterable：直接打字过滤（默认超过 8 项才开，短菜单里打字不起作用）；
 * min：多选至少要选几项；pageSize：一屏最多显示几行。
 */
export function createListState({ items, multiple = false, filterable, initial, min = 0, pageSize = 12 }) {
  const state = {
    items,
    multiple,
    filterable: filterable ?? items.length > 8,
    min,
    pageSize: Math.max(1, pageSize),
    query: '',
    cursor: 0,
    top: 0,
    notice: '',
    checked: new Set(items.flatMap((item, index) => (item.checked ? [index] : []))),
  }
  const start = typeof initial === 'number' ? initial : items.findIndex(item => item.value === initial)
  state.cursor = Math.max(0, Math.min(start, items.length - 1))
  keepCursorVisible(state)
  return state
}

const haystack = item => stripAnsi(`${item.label} ${item.desc ?? ''} ${item.search ?? ''}`).toLowerCase()

/** 当前过滤结果在 items 里的下标；多个词用空格分开，要同时命中。 */
export function visibleIndexes(state) {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean)
  const all = state.items.map((_item, index) => index)
  return terms.length ? all.filter(index => terms.every(term => haystack(state.items[index]).includes(term))) : all
}

function keepCursorVisible(state) {
  const count = visibleIndexes(state).length
  state.cursor = Math.max(0, Math.min(state.cursor, count - 1))
  if (state.cursor < state.top) state.top = state.cursor
  if (state.cursor >= state.top + state.pageSize) state.top = state.cursor - state.pageSize + 1
  state.top = Math.max(0, Math.min(state.top, Math.max(0, count - state.pageSize)))
}

const refilter = state => { state.cursor = 0; state.top = 0; keepCursorVisible(state) }

/**
 * 处理一个按键，原地改状态。返回 null（继续）或 {type:'submit', value} / {type:'back'} / {type:'cancel'}。
 * Esc：先清掉过滤词，没有过滤词才返回上一级；Ctrl+C 取消整个菜单。
 */
export function applyListKey(state, key) {
  const visible = visibleIndexes(state)
  state.notice = ''
  const move = to => { state.cursor = to; keepCursorVisible(state) }
  switch (key.name) {
    case 'ctrl-c': return { type: 'cancel' }
    case 'escape':
      if (state.query) { state.query = ''; refilter(state); return null }
      return { type: 'back' }
    case 'up': move(state.cursor - 1); return null
    case 'down': move(state.cursor + 1); return null
    case 'pageup': move(state.cursor - state.pageSize); return null
    case 'pagedown': move(state.cursor + state.pageSize); return null
    case 'home': move(0); return null
    case 'end': move(visible.length - 1); return null
    case 'tab': move(state.cursor + 1 >= visible.length ? 0 : state.cursor + 1); return null
    case 'shift-tab': move(state.cursor <= 0 ? visible.length - 1 : state.cursor - 1); return null
    case 'backspace':
      if (state.query) { state.query = Array.from(state.query).slice(0, -1).join(''); refilter(state) }
      return null
    case 'ctrl-u':
      if (state.query) { state.query = ''; refilter(state) }
      return null
    case 'space':
      if (state.multiple) {
        const index = visible[state.cursor]
        if (index !== undefined) { if (state.checked.has(index)) state.checked.delete(index); else state.checked.add(index) }
      } else if (state.filterable && state.query) { state.query += ' '; refilter(state) }
      return null
    case 'ctrl-a':
      if (state.multiple && visible.length) {
        if (visible.every(index => state.checked.has(index))) visible.forEach(index => state.checked.delete(index))
        else visible.forEach(index => state.checked.add(index))
      }
      return null
    case 'char':
      if (state.filterable) { state.query += key.text; refilter(state) }
      return null
    case 'enter': {
      if (state.multiple) {
        if (state.checked.size < state.min) { state.notice = `至少选择 ${state.min} 项`; return null }
        return { type: 'submit', value: state.items.flatMap((item, index) => (state.checked.has(index) ? [item.value] : [])) }
      }
      const index = visible[state.cursor]
      if (index === undefined) { state.notice = '没有匹配项'; return null }
      return { type: 'submit', value: state.items[index].value }
    }
    default: return null
  }
}

/* ───────────── 渲染 ───────────── */

export const LIST_HINTS = {
  single: '↑/↓ 移动 · Enter 确认 · Esc 返回',
  singleFilter: '↑/↓ 移动 · 输入文字过滤 · Enter 确认 · Esc 返回',
  multi: '↑/↓ 移动 · 空格 勾选 · Ctrl+A 全选/取消 · 输入文字过滤 · Enter 确认 · Esc 返回',
}

/**
 * 当前画面的文本行（每行不超过 columns - 1 列）。theme: {paint(tone, text, bold), g, columns, ascii}。
 */
export function listLines(state, { title, hint, theme }) {
  const { paint, g, ascii } = theme
  const columns = Math.max(40, theme.columns || 80) - 1
  const cursorMark = ascii ? '>' : '▶'
  const lines = [`${paint('brand', g.mark)} ${paint(null, truncate(title, columns - 2), true)}`]
  const hintText = hint ?? (state.multiple ? LIST_HINTS.multi : state.filterable ? LIST_HINTS.singleFilter : LIST_HINTS.single)
  lines.push(`  ${paint('muted', truncate(hintText, columns - 2))}`)
  if (state.filterable) {
    lines.push(state.query
      ? `  ${paint('muted', '过滤')} ${truncate(state.query, columns - 10)}${paint('brand', '▌')}`
      : `  ${paint('muted', '过滤 输入文字…')}`)
  }

  const visible = visibleIndexes(state)
  const window = visible.slice(state.top, state.top + state.pageSize)
  const prefix = state.multiple ? 8 : 4
  const labelCap = Math.max(10, Math.floor((columns - prefix) * 0.7))
  const labelWidth = Math.min(labelCap, Math.max(0, ...window.map(index => displayWidth(stripAnsi(state.items[index].label)))))
  if (state.top > 0) lines.push(`  ${paint('muted', `${ascii ? '^' : '↑'} 上面还有 ${state.top} 项`)}`)
  if (!visible.length) lines.push(`    ${paint('muted', '没有匹配项，退格删除过滤词')}`)
  window.forEach((index, offset) => {
    const item = state.items[index]
    const current = state.top + offset === state.cursor
    const box = state.multiple ? `${state.checked.has(index) ? paint('ok', '[x]') : paint('muted', '[ ]')} ` : ''
    const label = truncate(item.label, labelWidth)
    const room = columns - prefix - labelWidth - 2
    const desc = item.desc && room > 4 ? `  ${paint('muted', truncate(item.desc, room))}` : ''
    const cell = desc ? pad(label, labelWidth) : label
    lines.push(`${current ? ` ${paint('brand', cursorMark)} ` : '   '} ${box}${current ? paint('brand', cell, true) : cell}${desc}`)
  })
  const below = visible.length - (state.top + window.length)
  if (below > 0) lines.push(`  ${paint('muted', `${ascii ? 'v' : '↓'} 下面还有 ${below} 项`)}`)

  const position = visible.length ? `第 ${state.cursor + 1} 项` : '无'
  const counts = state.multiple
    ? `已选 ${state.checked.size} / 共 ${state.items.length} 项${state.query ? ` · 匹配 ${visible.length}` : ''}`
    : `${state.query ? `匹配 ${visible.length} / ` : ''}共 ${state.items.length} 项 · ${position}`
  lines.push(`  ${paint('muted', counts)}`)
  if (state.notice) lines.push(`  ${paint('warn', `${g.warn} ${state.notice}`)}`)
  return lines
}

/* ───────────── 终端外壳 ───────────── */

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ERASE_BELOW = '\r\x1b[J'

/**
 * raw 模式下的一次交互：每次按键交给 onKey，返回 null 继续、返回对象结束；render() 给出当前画面的行。
 * 结束时擦掉画面、恢复终端；同一批输入里没处理完的按键退回 stdin，留给下一个提示。
 */
function interact({ stdin, stderr }, render, onKey) {
  return new Promise(resolve => {
    const wasRaw = Boolean(stdin.isRaw)
    let height = 0
    let finished = false
    const up = () => (height > 1 ? `\x1b[${height - 1}A` : '')
    const draw = () => {
      const lines = render()
      stderr.write(`${up()}${ERASE_BELOW}${lines.join('\n')}`)
      height = lines.length
    }
    const restoreTerminal = () => {
      try { stdin.setRawMode?.(wasRaw) } catch { /* 已关闭 */ }
      stderr.write(SHOW_CURSOR)
    }
    const finish = (result, leftover = '') => {
      if (finished) return
      finished = true
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stderr.off?.('resize', draw)
      process.off('exit', restoreTerminal)
      stderr.write(`${up()}${ERASE_BELOW}`)
      restoreTerminal()
      stdin.pause()
      if (leftover) stdin.unshift(leftover)
      resolve(result)
    }
    const onEnd = () => finish({ type: 'cancel' })
    const onData = chunk => {
      const keys = parseKeys(chunk)
      for (const [index, key] of keys.entries()) {
        const result = onKey(key)
        if (result) { finish(result, keys.slice(index + 1).map(item => item.raw).join('')); return }
      }
      draw()
    }
    process.once('exit', restoreTerminal)
    stdin.setRawMode?.(true)
    stdin.setEncoding?.('utf8')
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stderr.on?.('resize', draw)
    stderr.write(HIDE_CURSOR)
    draw()
    stdin.resume()
  }).then(result => {
    if (result.type === 'cancel') throw new CancelError()
    return result
  })
}

const pageSizeFor = (stderr, items) => {
  const rows = stderr.rows || 24
  return Math.max(5, Math.min(rows - 9, 16, items.length))
}

/**
 * 单选 / 多选。单选返回选中项的 value，多选返回勾选项 value 数组；Esc 返回 null；Ctrl+C 抛 CancelError。
 * options: {title, items, multiple?, filterable?, initial?, min?, hint?}。
 */
export async function runList(options, io) {
  const { stdin, stderr, paint, g, ascii } = io
  const state = createListState({ ...options, pageSize: options.pageSize ?? pageSizeFor(stderr, options.items) })
  const theme = () => ({ paint, g, ascii, columns: stderr.columns })
  const done = await interact(
    { stdin, stderr },
    () => listLines(state, { title: options.title, hint: options.hint, theme: theme() }),
    key => applyListKey(state, key),
  )
  if (done.type === 'back') return null
  return done.value
}

/** 是 / 否：←/→ 切换，y / n 直接决定，Enter 取当前项，Esc 当作否，Ctrl+C 抛 CancelError。默认否。 */
export async function runConfirm({ question, defaultYes = false }, io) {
  const { stdin, stderr, paint } = io
  let yes = defaultYes
  const done = await interact(
    { stdin, stderr },
    () => {
      const option = (label, on) => (on ? paint('brand', `[ ${label} ]`, true) : paint('muted', `  ${label}  `))
      return [`${paint('brand', '?')} ${question}  ${option('是', yes)} ${option('否', !yes)}  ${paint('muted', 'y/n · ←/→ 切换 · Enter 确认')}`]
    },
    key => {
      switch (key.name) {
        case 'ctrl-c': return { type: 'cancel' }
        case 'escape': return { type: 'submit', value: false }
        case 'enter': return { type: 'submit', value: yes }
        case 'left': case 'right': case 'tab': case 'shift-tab': yes = !yes; return null
        case 'char':
          if (/^[yY是]$/.test(key.text)) return { type: 'submit', value: true }
          if (/^[nN否]$/.test(key.text)) return { type: 'submit', value: false }
          return null
        default: return null
      }
    },
  )
  stderr.write(`${paint('muted', '?')} ${question} ${done.value ? '是' : '否'}\n`)
  return done.value
}
