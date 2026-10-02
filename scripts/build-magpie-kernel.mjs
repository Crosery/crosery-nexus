import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { upstreamRevision } from '../deploy/magpie/local.mjs'

// Usage: node scripts/build-magpie-kernel.mjs [--source <pinned clean checkout>] [--out <dir>] [--test]
//        [--candidate <candidates/<rev>-<digest> dir> --out <staging dir> [--allow-catalog-drift]]
// --out writes the binary somewhere other than the runtime's bin (a staging dir); the running binary is untouched.
// --candidate (auto-update rehearsal) pins to that candidate's contract instead of deploy/magpie/upstream/api.json:
// the source must be its revision, its artifacts must regenerate byte-identically, and the account catalog must not drift.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const source = await fs.realpath(arg('--source') || process.env.MAGPIE_SOURCE || path.join(os.homedir(), '.agents/crosery/magpie/source'))
const runtime = path.resolve(process.env.MAGPIE_CONSOLE_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-console'))
const candidate = arg('--candidate') ? path.resolve(arg('--candidate')) : null
if (candidate && (!arg('--out') || path.resolve(arg('--out')) === path.join(runtime, 'bin'))) {
  throw new Error('A candidate build needs --out <staging dir>; it never writes the running kernel')
}
const out = path.resolve(arg('--out') || path.join(runtime, 'bin'))
const contractFile = candidate ? path.join(candidate, 'api.json') : path.join(root, 'deploy/magpie/upstream/api.json')
const contract = JSON.parse(await fs.readFile(contractFile, 'utf8'))
const pinned = candidate ? contract.revision : upstreamRevision
if (!/^[a-f0-9]{40}$/.test(pinned) ||
    execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pinned ||
    execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error('The kernel requires the pinned, clean Magpie source')
}
execFileSync(process.execPath, [path.join(root, 'scripts/magpie-upstream.mjs'), 'verify', '--source', source, ...(candidate ? ['--artifacts', candidate] : [])], { stdio: 'inherit' })
// --allow-catalog-drift (candidate only): a rehearsal that is already held for catalog drift still compiles and tests
// the overlay, to report everything at once; the pipeline never marks such a build eligible.
const allowDrift = Boolean(candidate) && process.argv.includes('--allow-catalog-drift')
if (!allowDrift) {
  execFileSync(process.execPath, [path.join(root, 'scripts/magpie-catalog.mjs'), ...(candidate
    ? ['diff', '--source', source, '--contract', contractFile, '--fail-on-drift']
    : ['verify', '--source', source])], { stdio: 'inherit' })
}
if (!contract.loginAgents.every(agent => /^[a-z0-9-]+$/.test(agent))) throw new Error('Unexpected login agent id in the contract')
await fs.mkdir(out, { recursive: true, mode: 0o700 })
const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crosery-kernel-build-'))
const Replace = {}
async function overlay(relative, transform) {
  const original = path.join(source, relative)
  const text = await fs.readFile(original, 'utf8')
  const replacement = path.join(overlayDir, relative.replaceAll('/', '-'))
  let replaced
  try { replaced = transform(text) } catch (error) { throw new Error(`${error.message} (${relative})`) }
  await fs.writeFile(replacement, replaced)
  Replace[original] = replacement
}
async function addFile(relative, text) {
  const target = path.join(source, relative)
  if (await fs.access(target).then(() => true, () => false)) throw new Error(`Pinned source already has ${relative}; review the overlay`)
  const replacement = path.join(overlayDir, relative.replaceAll('/', '-'))
  await fs.writeFile(replacement, text)
  Replace[target] = replacement
}
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Pinned kernel seam changed; review the overlay')
  return text.replace(before, after)
}
try {
  await overlay('internal/provider/provider.go', text => {
    text = replaceOnce(text, '"strings"', '"strings"\n\t"sync"')
    return replaceOnce(text, 'func load() file {', `var croseryMu sync.RWMutex
var croseryFile *file

func SetCroseryProviders(ps []Provider) {
	croseryMu.Lock()
	croseryFile = &file{Providers: ps}
	croseryMu.Unlock()
	catalog.Touched()
}

func load() file {
	croseryMu.RLock()
	if croseryFile != nil {
		f := *croseryFile
		croseryMu.RUnlock()
		return f
	}
	croseryMu.RUnlock()`)
  })
  // The kernel's accounts live in files under its own HOME; HOME isolation does not cover the
  // macOS login keychain, so every keychain read/write Magpie would do is switched off here.
  for (const [relative, seam] of [
    ['internal/provider/account.go', 'var claudeKeychain = runtime.GOOS == "darwin"'],
    ['internal/provider/cursor_usage.go', 'var cursorKeychain = runtime.GOOS == "darwin"'],
    ['internal/provider/copilot_cli.go', 'var copilotCLISecret = func(account string) string {'],
  ]) {
    if ((await fs.readFile(path.join(source, relative), 'utf8')).split(seam).length !== 2) throw new Error('Pinned keychain seam changed; review the overlay')
  }
  await addFile('internal/provider/crosery_keychain.go', `package provider

// Console kernel: never the macOS login keychain. Claude Code's sign-in is
// then ~/.claude/.credentials.json under the kernel HOME, so the owner's own
// Claude Code, Cursor and Copilot sign-ins never show up here or get overwritten.
func init() {
	claudeKeychain = false
	cursorKeychain = false
	copilotCLISecret = func(string) string { return "" }
}
`)
  // One choke point for every program Magpie starts (proc's package doc): the kernel refuses some by name.
  await overlay('internal/proc/proc.go', text => {
    text = replaceOnce(text, 'cmd := exec.Command(name, args...)\n\thide(cmd)', 'cmd := exec.Command(name, args...)\n\tcroseryGuard(cmd, name)\n\thide(cmd)')
    return replaceOnce(text, 'cmd.WaitDelay = waitDelay\n\thide(cmd)', 'cmd.WaitDelay = waitDelay\n\tcroseryGuard(cmd, name)\n\thide(cmd)')
  })
  await addFile('internal/proc/crosery_guard.go', `package proc

import (
	"errors"
	"os/exec"
)

// CroseryDeny, set once by the console kernel before it serves, names
// programs that must not run; such a command fails at Start, unstarted.
var CroseryDeny func(name string) bool

var errCroseryDenied = errors.New("this program is disabled in the console kernel")

func croseryGuard(cmd *exec.Cmd, name string) {
	if CroseryDeny != nil && CroseryDeny(name) {
		cmd.Err = errCroseryDenied
	}
}
`)
  await overlay('internal/usage/usage.go', text => {
    text = replaceOnce(text, 'type Record struct {', 'type Record struct {\n\tRequestID string `json:"rid,omitempty"`')
    return replaceOnce(text, 'func Append(r Record) {', `var CroserySink func(Record)

func Append(r Record) {
	if CroserySink != nil {
		CroserySink(r)
		return
	}`)
  })
  for (const relative of ['internal/gateway/gateway.go', 'internal/gateway/draw.go', 'internal/gateway/codex_backend.go']) {
    await overlay(relative, text => {
      if (!text.includes('Session: sessionOf(r.Header)')) throw new Error('Missing request accounting seam')
      return text.replaceAll('Session: sessionOf(r.Header)', 'RequestID: r.Header.Get("X-Crosery-Request-Id"), Session: sessionOf(r.Header)')
    })
  }
  // settings.Save truncates then writes; a request reading the file mid-write gets all defaults, so
  // redaction would be off for it. The console writes settings (kernel settings.go): write a temp file, rename.
  await overlay('internal/settings/settings.go', text => replaceOnce(text, "return os.WriteFile(Path(), append(b, '\\n'), 0o644)", `tmp, err := os.CreateTemp(Dir(), ".settings-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), Path())`))
  // deploy/magpie/kernel/<name>.go becomes <source>/crosery_kernel[_<name>].go, built as one command-line package.
  const kernelDir = path.join(root, 'deploy/magpie/kernel')
  const files = { build: [], test: [] }
  for (const name of (await fs.readdir(kernelDir)).filter(name => name.endsWith('.go')).sort()) {
    const target = name === 'main.go' ? 'crosery_kernel.go' : `crosery_kernel_${name}`
    await addFile(target, await fs.readFile(path.join(kernelDir, name), 'utf8'))
    files[name.endsWith('_test.go') ? 'test' : 'build'].push(`./${target}`)
  }
  const overlayFile = path.join(overlayDir, 'overlay.json')
  await fs.writeFile(overlayFile, JSON.stringify({ Replace }))
  const go = (args, options = {}) => execFileSync('go', args, { cwd: source, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit', ...options })
  if (process.argv.includes('--test')) {
    go(['vet', '-overlay', overlayFile, '-tags', 'nogui', ...files.build, ...files.test])
    go(['test', '-overlay', overlayFile, '-tags', 'nogui', '-count=1', ...files.build, ...files.test])
    go(['test', '-overlay', overlayFile, '-tags', 'nogui', './internal/gateway', './internal/provider', './internal/usage', './internal/proc', './internal/settings', './internal/redact'])
  }
  const ldflags = `-X main.revision=${pinned} -X main.loginAgents=${contract.loginAgents.join(',')}`
  go(['build', '-overlay', overlayFile, '-tags', 'nogui', '-trimpath', '-ldflags', ldflags, '-o', path.join(out, 'magpie-kernel'), ...files.build])
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(out, 'MAGPIE-LICENSE.txt'))
  console.log(JSON.stringify({ engine: 'magpie', revision: pinned, binary: path.join(out, 'magpie-kernel'), loginAgents: contract.loginAgents.length, ...(candidate ? { candidate: true } : {}) }))
} finally {
  await fs.rm(overlayDir, { recursive: true, force: true })
}
