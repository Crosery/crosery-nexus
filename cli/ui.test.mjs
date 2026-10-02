import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseGlyphs, createUi, displayWidth, pad, renderTable, stripAnsi, tokens, truncate, usd } from './lib/ui.mjs'

const sink = (isTTY = false) => {
  const chunks = []
  return { isTTY, columns: 0, write: chunk => { chunks.push(String(chunk)); return true }, text: () => chunks.join('') }
}

test('显示宽度：中文计 2 列，ASCII 计 1 列', () => {
  assert.equal(displayWidth('渠道 abc 你好'), 13)
  assert.equal(displayWidth('渠道abc你好'), 11)
  assert.equal(displayWidth(''), 0)
  assert.equal(displayWidth('\x1b[31m渠道\x1b[39m'), 4)
  assert.equal(displayWidth('sk-k1-1••••••••7031a'), 20)
})

test('pad / truncate 按显示宽度，截断用 … 或 ~', () => {
  assert.equal(pad('渠道', 6), '渠道  ')
  assert.equal(pad('ab', 4, 'right'), '  ab')
  assert.equal(truncate('渠道abc你好', 7), '渠道ab…')
  assert.equal(displayWidth(truncate('渠道abc你好', 7)), 7)
  assert.equal(truncate('渠道渠道', 5, '~'), '渠道~')
  assert.equal(truncate('short', 10), 'short')
})

test('表格按显示宽度对齐（中英混排每行同宽）', () => {
  const table = renderTable(['渠道', '状态'], [['codex', '启用'], ['中文渠道名', 'off']])
  const widths = table.split('\n').map(line => displayWidth(line))
  assert.ok(widths.every(width => width === widths[0]), table)
})

test('表格超宽时截断最宽列', () => {
  const table = renderTable(['名称', '说明'], [['a', 'x'.repeat(80)]], { maxWidth: 40 })
  for (const line of table.split('\n')) assert.ok(displayWidth(line) <= 40, line)
  assert.match(table, /…/)
})

test('ASCII 字形：CRADMIN_GLYPHS / CRAPI_GLYPHS / TERM=linux', () => {
  assert.equal(chooseGlyphs({ CRADMIN_GLYPHS: 'ascii' }), 'ascii')
  assert.equal(chooseGlyphs({ CRAPI_GLYPHS: 'ascii' }), 'ascii')
  assert.equal(chooseGlyphs({ TERM: 'linux' }), 'ascii')
  assert.equal(chooseGlyphs({ TERM: 'linux', CRADMIN_GLYPHS: 'unicode' }), 'unicode')
  assert.equal(chooseGlyphs({}), 'unicode')
  const out = sink()
  const ui = createUi({ stdout: out, stderr: sink(), env: { CRADMIN_GLYPHS: 'ascii' } })
  ui.table(['a'], [['b']])
  ui.success('ok')
  assert.doesNotMatch(out.text(), /[╭│✓]/)
  assert.match(out.text(), /\+-+\+/)
})

test('非 TTY 或 NO_COLOR 时不上色；TTY 才上色', () => {
  const plain = sink(false)
  createUi({ stdout: plain, stderr: sink(), env: {} }).success('完成')
  assert.equal(plain.text(), stripAnsi(plain.text()))
  const noColor = sink(true)
  createUi({ stdout: noColor, stderr: sink(), env: { NO_COLOR: '1' } }).success('完成')
  assert.equal(noColor.text(), stripAnsi(noColor.text()))
  const tty = sink(true)
  createUi({ stdout: tty, stderr: sink(), env: {} }).success('完成')
  assert.notEqual(tty.text(), stripAnsi(tty.text()))
})

test('--json 模式装饰行改写到 stderr，stdout 只留数据', () => {
  const out = sink()
  const err = sink()
  const ui = createUi({ stdout: out, stderr: err, env: {}, json: true })
  ui.success('完成')
  ui.section('标题')
  ui.data('{}')
  assert.equal(out.text(), '{}\n')
  assert.match(err.text(), /完成/)
})

test('数值格式', () => {
  assert.equal(usd(0), '$0')
  assert.equal(usd(1234.5), '$1,235')
  assert.equal(usd(12.345), '$12.35')
  assert.equal(usd(0.0042), '$0.0042')
  assert.equal(usd(null), '-')
  assert.equal(tokens(1234), '1.2K')
  assert.equal(tokens(3_400_000), '3.4M')
})

test('kv：超过 10 列的标签和值之间至少留一个空格', () => {
  const out = sink()
  const ui = createUi({ stdout: out, stderr: sink(), env: { NO_COLOR: '1' } })
  ui.kv('antigravity', '账号 2')
  ui.kv('codex', '账号 1')
  assert.equal(out.text(), '  antigravity 账号 2\n  codex     账号 1\n')
})
