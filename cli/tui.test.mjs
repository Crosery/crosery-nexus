// 方向键界面：按键解析、列表状态机、画面、终端外壳（假 TTY）、prompter 的确认。
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import { CancelError } from './lib/args.mjs'
import { createPrompter } from './lib/prompt.mjs'
import { applyListKey, createListState, listLines, parseKeys, runConfirm, runList, visibleIndexes } from './lib/tui.mjs'
import { createUi, displayWidth, stripAnsi } from './lib/ui.mjs'

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_C = '\x03'
const names = text => parseKeys(text).map(key => key.name)

test('按键解析：方向键、Esc、Enter、退格、控制键、多字节字符', () => {
  assert.deepEqual(names(UP + DOWN + RIGHT + LEFT), ['up', 'down', 'right', 'left'])
  assert.deepEqual(names('\x1bOA\x1bOB'), ['up', 'down'], 'application 模式的方向键')
  assert.deepEqual(names('\x1b[1;5A'), ['up'], '带修饰键的方向键按方向处理')
  assert.deepEqual(names('\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[3~'), ['pageup', 'pagedown', 'home', 'end', 'delete'])
  assert.deepEqual(names(ESC), ['escape'])
  assert.deepEqual(names(ESC + ESC), ['escape', 'escape'], '连按两次 Esc 是两个 Esc')
  assert.deepEqual(names('\r'), ['enter'])
  assert.deepEqual(names('\r\n'), ['enter'], 'CRLF 只算一次 Enter')
  assert.deepEqual(names('\n'), ['enter'])
  assert.deepEqual(names('\t\x1b[Z'), ['tab', 'shift-tab'])
  assert.deepEqual(names('\x7f\b'), ['backspace', 'backspace'])
  assert.deepEqual(names('\x03\x01\x15'), ['ctrl-c', 'ctrl-a', 'ctrl-u'])
  assert.deepEqual(names('\x0e\x10'), ['down', 'up'], 'Ctrl+N / Ctrl+P')
  assert.deepEqual(names('\x1bb'), [], 'Alt 组合键不当成 Esc')
  assert.deepEqual(names('\x1b[200~'), [], '不认识的序列整体忽略')
  assert.deepEqual(names('\x02\x07'), [], '其余控制字符忽略')

  const typed = parseKeys('a 渠😀')
  assert.deepEqual(typed.map(key => key.name), ['char', 'space', 'char', 'char'])
  assert.deepEqual(typed.filter(key => key.name === 'char').map(key => key.text), ['a', '渠', '😀'])
  assert.deepEqual(parseKeys('a\x1b[Bb').map(key => key.raw), ['a', '\x1b[B', 'b'], 'raw 拼起来就是原输入，用来把没处理的按键退回 stdin')
})

const items = ['alpha', 'beta', 'gamma', 'delta'].map(label => ({ label, value: label }))
const press = (state, ...keys) => {
  let done = null
  for (const key of keys) {
    done = applyListKey(state, typeof key === 'string' ? { name: key } : key)
    if (done) break
  }
  return done
}
const type = text => Array.from(text).map(char => ({ name: 'char', text: char }))

test('单选：上下移动不越界，Tab 首尾循环，Enter 取当前项', () => {
  const state = createListState({ items })
  press(state, 'up')
  assert.equal(state.cursor, 0)
  press(state, 'down', 'down')
  assert.deepEqual(press(state, 'enter'), { type: 'submit', value: 'gamma' })
  press(state, 'down', 'down', 'down')
  assert.equal(state.cursor, 3, '到底不再往下')
  press(state, 'tab')
  assert.equal(state.cursor, 0, 'Tab 在末项循环回首项')
  press(state, 'shift-tab')
  assert.equal(state.cursor, 3)
  press(state, 'home')
  assert.equal(state.cursor, 0)
  press(state, 'end')
  assert.equal(state.cursor, 3)
})

test('initial 可以是下标或 value；越界时落在合法位置', () => {
  assert.equal(createListState({ items, initial: 2 }).cursor, 2)
  assert.equal(createListState({ items, initial: 'delta' }).cursor, 3)
  assert.equal(createListState({ items, initial: 'nope' }).cursor, 0)
  assert.equal(createListState({ items, initial: 99 }).cursor, 3)
  assert.equal(createListState({ items: [], initial: 5 }).cursor, 0)
})

test('打字过滤：多个词要同时命中，光标回到首项；Esc 先清过滤词，再返回', () => {
  const state = createListState({ items, filterable: true })
  press(state, 'down', 'down', ...type('a'))
  assert.equal(state.cursor, 0, '过滤后光标回到首项')
  assert.deepEqual(visibleIndexes(state).map(index => items[index].label), ['alpha', 'beta', 'gamma', 'delta'])
  press(state, 'space', ...type('l'))
  assert.deepEqual(visibleIndexes(state).map(index => items[index].label), ['alpha', 'delta'], '「a l」要同时含 a 和 l')
  press(state, 'space', ...type('ph'))
  assert.equal(state.query, 'a l ph', '单选里空格是过滤词的一部分')
  assert.deepEqual(visibleIndexes(state).map(index => items[index].label), ['alpha'])
  assert.deepEqual(press(state, 'enter'), { type: 'submit', value: 'alpha' })

  assert.equal(press(state, 'escape'), null, '有过滤词时 Esc 只清过滤词')
  assert.equal(state.query, '')
  assert.deepEqual(press(state, 'escape'), { type: 'back' })
  press(state, ...type('zzz'))
  assert.deepEqual(press(state, 'enter'), null, '没有匹配项时 Enter 不选')
  assert.equal(state.notice, '没有匹配项')
  press(state, 'backspace')
  assert.equal(state.query, 'zz')
  press(state, 'ctrl-u')
  assert.equal(state.query, '')
})

test('过滤匹配标签、说明和 search 字段，忽略颜色码和大小写', () => {
  const state = createListState({
    items: [{ label: '\x1b[1mAPI Key\x1b[22m', desc: 'keys', value: 1 }, { label: '总览', desc: 'status', value: 2, search: 'overview' }],
    filterable: true,
  })
  press(state, ...type('KEYS'))
  assert.deepEqual(visibleIndexes(state), [0])
  press(state, 'ctrl-u', ...type('overview'))
  assert.deepEqual(visibleIndexes(state), [1])
})

test('短菜单默认不开过滤：打字不起作用', () => {
  const state = createListState({ items })
  assert.equal(state.filterable, false)
  press(state, ...type('b'))
  assert.equal(state.query, '')
  assert.equal(createListState({ items: Array.from({ length: 9 }, (_, index) => ({ label: `m${index}`, value: index })) }).filterable, true)
})

test('多选：空格勾选，Ctrl+A 只动当前可见项，min 不够时提示，结果按原顺序', () => {
  const state = createListState({ items, multiple: true, min: 1, filterable: true })
  assert.equal(press(state, 'enter'), null)
  assert.equal(state.notice, '至少选择 1 项')
  press(state, 'down', 'space', 'down', 'down', 'space')
  assert.deepEqual(press(state, 'enter'), { type: 'submit', value: ['beta', 'delta'] })

  press(state, 'ctrl-a')
  assert.deepEqual(press(state, 'enter'), { type: 'submit', value: ['alpha', 'beta', 'gamma', 'delta'] }, '没全选时 Ctrl+A 全选')
  press(state, 'ctrl-a')
  assert.equal(state.checked.size, 0, '全选后再按 Ctrl+A 全部取消')

  press(state, ...type('ta'))
  assert.deepEqual(visibleIndexes(state).map(index => items[index].label), ['beta', 'delta'])
  press(state, 'ctrl-a')
  assert.deepEqual([...state.checked].sort(), [1, 3], '过滤时 Ctrl+A 只勾可见的两项')
  press(state, 'escape')
  assert.deepEqual(press(state, 'enter'), { type: 'submit', value: ['beta', 'delta'] }, '清掉过滤词后勾选仍在')
})

test('多选：初始勾选来自 checked；空格在没有匹配项时不动', () => {
  const state = createListState({ items: items.map((item, index) => ({ ...item, checked: index % 2 === 0 })), multiple: true, filterable: true })
  assert.deepEqual(press(state, 'enter'), { type: 'submit', value: ['alpha', 'gamma'] })
  press(state, ...type('zzz'), 'space')
  assert.equal(state.checked.size, 2)
})

test('Ctrl+C 取消；Esc 不是取消', () => {
  assert.deepEqual(press(createListState({ items }), 'ctrl-c'), { type: 'cancel' })
  assert.deepEqual(press(createListState({ items }), 'escape'), { type: 'back' })
})

test('长列表滚动：光标始终在窗口里，翻页键按页走', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ label: `m${index}`, value: index }))
  const state = createListState({ items: many, pageSize: 5 })
  for (let step = 0; step < 7; step += 1) press(state, 'down')
  assert.equal(state.cursor, 7)
  assert.equal(state.top, 3, '光标刚好落在窗口最后一行')
  press(state, 'pagedown')
  assert.equal(state.cursor, 12)
  assert.ok(state.cursor >= state.top && state.cursor < state.top + 5)
  press(state, 'end')
  assert.equal(state.cursor, 29)
  assert.equal(state.top, 25)
  press(state, 'pageup')
  assert.equal(state.cursor, 24)
  press(state, 'home')
  assert.deepEqual([state.cursor, state.top], [0, 0])
})

const plainTheme = (columns = 60, ascii = false) => ({ paint: (_tone, text) => text, g: createUi({ stdout: { write() {} }, stderr: { write() {} }, env: { CRADMIN_GLYPHS: ascii ? 'ascii' : 'unicode' } }).g, columns, ascii })

test('画面：标题、提示、光标行、说明列、页脚；每行不超过终端宽度', () => {
  const state = createListState({
    items: [{ label: '渠道与模型', desc: 'channels', value: 1 }, { label: 'API Key', desc: 'keys', value: 2 }, { label: '退出', value: 'quit' }],
    filterable: false,
  })
  const lines = listLines(state, { title: '请选择功能', hint: '↑/↓ 移动 · Enter 进入 · Esc 退出', theme: plainTheme() })
  assert.equal(lines[0], '◆ 请选择功能')
  assert.equal(lines[1], '  ↑/↓ 移动 · Enter 进入 · Esc 退出')
  assert.match(lines[2], /^ ▶  渠道与模型\s+channels$/)
  assert.match(lines[3], /^ {4}API Key {5}\s*keys$/)
  assert.equal(lines.at(-1), '  共 3 项 · 第 1 项')
  for (const line of lines) assert.ok(displayWidth(line) <= 59, line)
})

test('画面：ASCII 字形、多选复选框、过滤提示与行数统计', () => {
  const state = createListState({ items, multiple: true, filterable: true })
  press(state, 'space', 'down', ...type('a'))
  const lines = listLines(state, { title: '选择分组', theme: plainTheme(60, true) }).map(stripAnsi)
  assert.equal(lines[0], '* 选择分组')
  assert.match(lines[1], /空格 勾选/)
  assert.match(lines[2], /^ {2}过滤 a▌$/)
  assert.match(lines[3], /^ > {2}\[x\] alpha$/)
  assert.match(lines[4], /^ {4}\[ \] beta$/)
  assert.equal(lines.at(-1), '  已选 1 / 共 4 项 · 匹配 4')
})

test('画面：没有匹配项、滚动提示、提醒行', () => {
  const state = createListState({ items, filterable: true })
  press(state, ...type('zzz'), 'enter')
  const empty = listLines(state, { title: 't', theme: plainTheme() })
  assert.ok(empty.some(line => line.includes('没有匹配项，退格删除过滤词')))
  assert.ok(empty.some(line => line.includes('! 没有匹配项')))
  assert.equal(empty.at(-2), '  匹配 0 / 共 4 项 · 无')

  const many = Array.from({ length: 30 }, (_, index) => ({ label: `m${index}`, value: index }))
  const long = createListState({ items: many, pageSize: 5 })
  for (let step = 0; step < 9; step += 1) press(long, 'down')
  const lines = listLines(long, { title: 't', theme: plainTheme() })
  assert.ok(lines.some(line => line.includes('↑ 上面还有 5 项')))
  assert.ok(lines.some(line => line.includes('↓ 下面还有 20 项')))
  assert.equal(lines.filter(line => /m\d+/.test(line) && !line.includes('还有')).length, 5)
})

test('画面：超长中文标签按显示宽度截断，不顶出终端宽度', () => {
  const state = createListState({ items: [{ label: '很长的中文标签'.repeat(8), desc: '同样很长的说明文字'.repeat(4), value: 1 }], filterable: false })
  for (const columns of [40, 60, 120]) {
    for (const line of listLines(state, { title: '标题'.repeat(30), hint: '提示'.repeat(30), theme: plainTheme(columns) })) {
      assert.ok(displayWidth(line) <= columns - 1, `${columns} 列：${displayWidth(line)} ${line}`)
    }
  }
})

/** 假 TTY：stdin 是可写的 PassThrough（isTTY、setRawMode 可观察），stderr 收集所有输出。 */
function fakeTty({ columns = 80, rows = 24 } = {}) {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.rawModes = []
  stdin.setRawMode = mode => { stdin.isRaw = Boolean(mode); stdin.rawModes.push(Boolean(mode)); return stdin }
  const chunks = []
  const stderr = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } })
  Object.assign(stderr, { isTTY: true, columns, rows })
  const screen = createUi({ stdout: stderr, stderr, env: { NO_COLOR: '1' } })
  return { stdin, stderr, text: () => chunks.join(''), io: { stdin, stderr, paint: screen.paintErr, g: screen.g, ascii: false } }
}

test('runList 单选：按键进、选中后擦掉画面并恢复终端', async () => {
  const exitListeners = process.listenerCount('exit')
  const tty = fakeTty()
  const picked = runList({ title: '选择渠道', items }, tty.io)
  tty.stdin.write(DOWN + ENTER)
  assert.equal(await picked, 'beta')
  assert.deepEqual(tty.stdin.rawModes, [true, false], '进入 raw 模式，结束时恢复')
  assert.equal(tty.stdin.isPaused(), true)
  const out = tty.text()
  assert.ok(out.startsWith('\x1b[?25l'), '先隐藏光标')
  assert.ok(out.endsWith('\x1b[?25h'), '最后一定把光标显示回来')
  assert.ok(stripAnsi(out).includes('选择渠道') && out.includes('▶'))
  assert.ok(out.endsWith('\r\x1b[J\x1b[?25h'), '结束时擦掉画面再显示光标')
  assert.equal(process.listenerCount('exit'), exitListeners, '不留 exit 监听')
})

test('runList：Esc 返回 null；Ctrl+C 抛 CancelError；输入结束也算取消', async () => {
  const back = fakeTty()
  const pending = runList({ title: 't', items }, back.io)
  back.stdin.write(ESC)
  assert.equal(await pending, null)

  const cancel = fakeTty()
  const cancelled = runList({ title: 't', items }, cancel.io)
  cancel.stdin.write(CTRL_C)
  await assert.rejects(cancelled, CancelError)
  assert.deepEqual(cancel.stdin.rawModes, [true, false])
  assert.ok(cancel.text().endsWith('\x1b[?25h'))

  const ended = fakeTty()
  const closed = runList({ title: 't', items }, ended.io)
  ended.stdin.end()
  await assert.rejects(closed, CancelError)
})

test('runList：同一批输入里没处理完的按键退回 stdin，留给下一个提示', async () => {
  const tty = fakeTty()
  const first = runList({ title: '一', items: items.slice(0, 2) }, tty.io)
  tty.stdin.write('\rb\r')
  assert.equal(await first, 'alpha')
  const second = await runList({ title: '二', items, filterable: true }, tty.io)
  assert.equal(second, 'beta', '后面的 b + Enter 被第二个提示读到')
})

test('runList 多选：空格勾选、Enter 提交', async () => {
  const tty = fakeTty()
  const picked = runList({ title: '选择分组', items, multiple: true, min: 1 }, tty.io)
  tty.stdin.write(`${ENTER}`)
  tty.stdin.write(` ${DOWN}${DOWN} ${ENTER}`)
  assert.deepEqual(await picked, ['alpha', 'gamma'])
  assert.ok(stripAnsi(tty.text()).includes('至少选择 1 项'), '一个都没选时 Enter 给出提示、不提交')
})

test('runList：窗口尺寸跟终端行数走，画面高度不超过终端', async () => {
  const many = Array.from({ length: 50 }, (_, index) => ({ label: `m${index}`, value: index }))
  const tty = fakeTty({ rows: 14 })
  const picked = runList({ title: 't', items: many }, tty.io)
  tty.stdin.write(`${ESC}`)
  await picked
  const out = tty.text()
  const start = out.indexOf('\x1b[J') + 3
  const frame = out.slice(start, out.indexOf('\x1b[', start))
  assert.ok(frame.split('\n').length <= 13, `画面 ${frame.split('\n').length} 行`)
})

test('runConfirm：y / n 直接决定，Enter 取当前项（默认否），←/→ 切换，Esc 当作否', async () => {
  const run = async keys => {
    const tty = fakeTty()
    const answer = runConfirm({ question: '确认执行？' }, tty.io)
    tty.stdin.write(keys)
    return { answer: await answer, tty }
  }
  assert.equal((await run('y')).answer, true)
  assert.equal((await run('Y')).answer, true)
  assert.equal((await run('n')).answer, false)
  assert.equal((await run(ENTER)).answer, false, '默认否')
  assert.equal((await run(LEFT + ENTER)).answer, true)
  assert.equal((await run(RIGHT + ENTER)).answer, true)
  assert.equal((await run(RIGHT + RIGHT + ENTER)).answer, false)
  assert.equal((await run(ESC)).answer, false)
  assert.equal((await run('x' + 'y')).answer, true, '其它键忽略')
  const done = await run('y')
  assert.match(stripAnsi(done.tty.text()), /\? 确认执行？ 是\n$/, '决定之后留一行记录')
  assert.deepEqual(done.tty.stdin.rawModes, [true, false])

  const tty = fakeTty()
  const cancelled = runConfirm({ question: '确认执行？' }, tty.io)
  tty.stdin.write(CTRL_C)
  await assert.rejects(cancelled, CancelError)
})

test('runConfirm：defaultYes 时 Enter 为是', async () => {
  const tty = fakeTty()
  const answer = runConfirm({ question: '继续？', defaultYes: true }, tty.io)
  tty.stdin.write(ENTER)
  assert.equal(await answer, true)
})

test('prompter：终端里确认走按键，select / multiSelect 可用；非终端仍是键入 y/N', async () => {
  const tty = fakeTty()
  const prompter = createPrompter({ stdin: tty.stdin, stderr: tty.stderr, env: { NO_COLOR: '1' } })
  assert.equal(prompter.terminal, true)
  const confirmed = prompter.confirm('确认执行？')
  tty.stdin.write('y')
  assert.equal(await confirmed, true)

  const single = prompter.select({ title: '选', items })
  tty.stdin.write(DOWN + ENTER)
  assert.equal(await single, 'beta')

  const multi = prompter.multiSelect({ title: '选', items })
  tty.stdin.write(` ${DOWN}${ENTER}`)
  assert.deepEqual(await multi, ['alpha'])

  const piped = new PassThrough()
  const stderr = new PassThrough()
  const plain = createPrompter({ stdin: piped, stderr })
  assert.equal(plain.terminal, false)
  const typed = plain.confirm('确认执行？')
  piped.write('y\n')
  assert.equal(await typed, true)
  plain.close()
})
