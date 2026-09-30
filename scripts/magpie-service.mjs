import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultRuntime } from '../deploy/magpie/local.mjs'

if (process.platform !== 'darwin') throw new Error('This service installer is macOS-only; use magpie-local.mjs start on other hosts')
const label = 'com.crosery.magpie-local'
const domain = `gui/${process.getuid()}`
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist')
const cli = fileURLToPath(new URL('./magpie-local.mjs', import.meta.url))
const runtime = defaultRuntime
const xml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
const [command] = process.argv.slice(2)
if (command === 'install') {
  await fs.access(path.join(runtime, 'manifest.json'))
  await fs.access(path.join(runtime, 'bin/magpie'))
  await fs.mkdir(path.dirname(plistPath), { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(cli)}</string><string>start</string></array>
<key>WorkingDirectory</key><string>${xml(path.dirname(path.dirname(cli)))}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(runtime, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(runtime, 'service-error.log'))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH)}</string></dict>
</dict></plist>
`
  await fs.writeFile(plistPath, plist, { flag: 'wx', mode: 0o600 })
  execFileSync('plutil', ['-lint', plistPath], { stdio: 'inherit' })
  execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' })
  console.log('Installed local-only Magpie service; no agent/CPA/production configuration changed')
} else if (command === 'status') {
  execFileSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'inherit' })
} else if (command === 'stop') {
  execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'inherit' })
  console.log('Stopped service. All data and the original Magpie instance are retained.')
} else if (command === 'start') {
  execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' })
} else throw new Error('Usage: node scripts/magpie-service.mjs install|status|stop|start')
