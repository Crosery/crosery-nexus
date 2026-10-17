// 交互输入：所有提示写 stderr（stdout 被重定向时仍能交互）。
// TTY：每个问题一个 readline（答完即关，终端模式随之复位）；选择与确认走方向键界面（tui.mjs）。
// 非 TTY：一个常驻 readline + 行队列（测试与管道），确认仍是键入 y/N。
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { CancelError } from './args.mjs'
import { runConfirm, runList } from './tui.mjs'
import { createUi } from './ui.mjs'

export function createPrompter({ stdin, stderr, env = {}, noColor = false }) {
  const terminal = Boolean(stdin?.isTTY && stderr?.isTTY)
  // 方向键界面画在 stderr（和所有提示一样），配色与字形跟随 stderr
  const screen = createUi({ stdout: stderr, stderr, env, noColor })
  const tui = { stdin, stderr, paint: screen.paintErr, g: screen.g, ascii: screen.glyphMode === 'ascii' }
  let muted = false
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) stderr.write(chunk)
      callback()
    },
  })
  output.isTTY = terminal
  output.columns = stderr?.columns

  // 非 TTY 常驻模式
  let shared = null
  const queue = []
  const waiters = []
  let ended = false
  function sharedReader() {
    if (shared) return shared
    shared = readline.createInterface({ input: stdin, output, terminal: false })
    shared.on('line', line => {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(line)
      else queue.push(line)
    })
    shared.on('close', () => {
      ended = true
      while (waiters.length) waiters.shift().reject(new CancelError())
    })
    return shared
  }

  async function askShared(prompt) {
    sharedReader()
    stderr.write(prompt)
    if (queue.length) return queue.shift()
    if (ended) throw new CancelError()
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }

  function askTerminal(prompt, secret) {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input: stdin, output, terminal: true, historySize: 0 })
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (secret) { muted = false; stderr.write('\n') }
        rl.close()
        fn(value)
      }
      rl.on('line', line => finish(resolve, line))
      rl.on('SIGINT', () => { if (!secret) stderr.write('\n'); finish(reject, new CancelError()) })
      rl.on('close', () => finish(reject, new CancelError()))
      rl.setPrompt(prompt)
      rl.prompt()
      if (secret) muted = true
    })
  }

  const ask = (prompt, { secret = false } = {}) => (terminal ? askTerminal(prompt, secret) : askShared(prompt))

  return {
    terminal,
    ask,
    secret: prompt => ask(prompt, { secret: true }),
    /** 方向键单选（仅 terminal）：返回选中项的 value，Esc 返回 null；见 tui.runList。 */
    select: options => runList({ ...options, multiple: false }, tui),
    /** 方向键多选（仅 terminal）：返回勾选项 value 的数组，Esc 返回 null。 */
    multiSelect: options => runList({ ...options, multiple: true }, tui),
    /** 默认「否」。终端里按 y / n 或 ←/→ + Enter，其余环境键入 y/N。 */
    async confirm(question) {
      if (terminal) return runConfirm({ question }, tui)
      const answer = String(await ask(`${question} [y/N] `)).trim().toLowerCase()
      return answer === 'y' || answer === 'yes' || answer === '是'
    },
    close() {
      shared?.close()
      shared = null
    },
  }
}
