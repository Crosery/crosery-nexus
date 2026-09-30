import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { upstreamRevision } from '../deploy/magpie/local.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await fs.realpath(process.env.MAGPIE_SOURCE || path.join(os.homedir(), '.agents/crosery/magpie/source'))
const runtime = path.resolve(process.env.MAGPIE_CONSOLE_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-console'))
if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== upstreamRevision ||
    execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error('The kernel requires the pinned, clean Magpie source')
}
execFileSync(process.execPath, [path.join(root, 'scripts/magpie-upstream.mjs'), 'verify', '--source', source], { stdio: 'inherit' })
await fs.mkdir(runtime, { recursive: true, mode: 0o700 })
await fs.mkdir(path.join(runtime, 'bin'), { recursive: true, mode: 0o700 })
const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crosery-kernel-build-'))
const Replace = {}
async function overlay(relative, transform) {
  const original = path.join(source, relative)
  const text = await fs.readFile(original, 'utf8')
  const replacement = path.join(overlayDir, relative.replaceAll('/', '-'))
  await fs.writeFile(replacement, transform(text))
  Replace[original] = replacement
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
  const command = path.join(overlayDir, 'main.go')
  await fs.copyFile(path.join(root, 'deploy/magpie/kernel/main.go'), command)
  Replace[path.join(source, 'crosery_kernel.go')] = command
  const overlayFile = path.join(overlayDir, 'overlay.json')
  await fs.writeFile(overlayFile, JSON.stringify({ Replace }))
  execFileSync('go', ['build', '-overlay', overlayFile, '-tags', 'nogui', '-trimpath', '-ldflags', `-X main.revision=${upstreamRevision}`,
    '-o', path.join(runtime, 'bin/magpie-kernel'), './crosery_kernel.go'], {
    cwd: source, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit',
  })
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(runtime, 'bin/MAGPIE-LICENSE.txt'))
  if (process.argv.includes('--test')) {
    execFileSync('go', ['test', '-overlay', overlayFile, '-tags', 'nogui',
      './internal/gateway', './internal/provider', './internal/usage'], {
      cwd: source, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit',
    })
    execFileSync('go', ['vet', '-overlay', overlayFile, '-tags', 'nogui', './crosery_kernel.go'], {
      cwd: source, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit',
    })
  }
  console.log(JSON.stringify({ engine: 'magpie', revision: upstreamRevision, binary: path.join(runtime, 'bin/magpie-kernel') }))
} finally {
  await fs.rm(overlayDir, { recursive: true, force: true })
}
