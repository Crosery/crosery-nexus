import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { main } from './cradmin.mjs'
import { listValue, numberValue, parseCommandArgs, splitCommand } from './lib/args.mjs'

const sink = () => {
  const chunks = []
  return { isTTY: false, columns: 0, write: chunk => { chunks.push(String(chunk)); return true }, text: () => chunks.join('') }
}

async function run(argv) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, {
    env: { NO_COLOR: '1', CRADMIN_HOME: '/nonexistent-cradmin-home', CRADMIN_KEYCHAIN: 'off', CRADMIN_SESSION_CACHE: 'off' },
    stdin: Readable.from([]), stdout, stderr, interactive: false, cwd: '/tmp',
    fetch: () => { throw new Error('参数测试不应联网') },
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

test('splitCommand：命令可以出现在全局参数之后，大小写不敏感', () => {
  assert.deepEqual(splitCommand(['--json', 'KEYS', 'ls']), { command: 'keys', rest: ['--json', 'ls'] })
  assert.deepEqual(splitCommand(['--base', 'http://x', 'status']), { command: 'status', rest: ['--base', 'http://x'] })
  assert.equal(splitCommand(['--json']).command, '')
})

test('parseCommandArgs：flag 与位置参数交错、-y 短名、可重复 flag', () => {
  const { values, positionals } = parseCommandArgs(['models', 'codex', '-y', '--only', 'a*', '--only', 'b'], { only: { type: 'string', multiple: true } })
  assert.deepEqual(positionals, ['models', 'codex'])
  assert.equal(values.yes, true)
  assert.deepEqual(listValue(values.only), ['a*', 'b'])
  assert.deepEqual(listValue(['a,b', ' c ']), ['a', 'b', 'c'])
})

test('未知 flag / 缺值 → UsageError（退出码 2）', () => {
  assert.throws(() => parseCommandArgs(['--nope'], {}), error => error.exitCode === 2 && /未知参数：--nope/.test(error.message))
  assert.throws(() => parseCommandArgs(['--base'], {}), error => error.exitCode === 2 && /需要一个值/.test(error.message))
  assert.throws(() => numberValue('x', '--concurrency', { integer: true, min: 0, max: 500 }), error => error.exitCode === 2)
  assert.equal(numberValue('4', '--concurrency', { integer: true, min: 0, max: 500 }), 4)
})

test('main：未知命令退出 2 并在 stderr 打总帮助', async () => {
  const result = await run(['bogus'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /未知命令：bogus/)
  assert.match(result.stderr, /用法/)
  assert.equal(result.stdout, '')
})

test('main：未知 flag 退出 2 并给出 -h 提示', async () => {
  const result = await run(['keys', 'ls', '--bogus'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /未知参数：--bogus/)
  assert.match(result.stderr, /cradmin keys -h/)
})

test('main：-h 退出 0；非交互无参数打印总帮助退出 0', async () => {
  for (const argv of [['-h'], ['keys', '-h'], ['channels', '--help'], []]) {
    const result = await run(argv)
    assert.equal(result.code, 0, argv.join(' '))
    assert.match(result.stdout, /cradmin/)
  }
  const keysHelp = await run(['keys', '-h'])
  assert.match(keysHelp.stdout, /^cradmin keys <动作>/)
})

test('main：version 不联网', async () => {
  const result = await run(['version', '--json'])
  assert.equal(result.code, 0)
  assert.equal(typeof JSON.parse(result.stdout).cradmin, 'string')
})

test('main：动作错误与缺参数退出 2', async () => {
  assert.equal((await run(['keys', 'frobnicate'])).code, 2)
  assert.equal((await run(['channels', 'models'])).code, 2)
})
