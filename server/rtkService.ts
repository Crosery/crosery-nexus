import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type RTKGainStats = {
  commands: number
  input: number
  saved: number
  pct: number
}

export type RTKDayStats = {
  date: string
  commands: number
  input: number
  saved: number
  pct: number
}

export type RTKAgent = {
  id: string
  name: string
  icon: string
  on: boolean
  blocked?: string
}

export type RTKView = {
  connected: boolean
  path: string | null
  version: string | null
  gain: RTKGainStats | null
  days: RTKDayStats[]
  latest: string | null
  agents: RTKAgent[]
  url: string
  install?: string
  error?: string
}

export const RTK_URL = 'https://www.rtk-ai.app'

export function findRTKBinary(): string | null {
  const custom = process.env.RTK_BIN
  if (custom && fs.existsSync(custom)) return custom

  const candidates = [
    '/Users/crosery/.local/bin/rtk',
    path.join(os.homedir(), '.local/bin/rtk'),
    path.join(os.homedir(), '.cargo/bin/rtk'),
    '/usr/local/bin/rtk',
    '/opt/homebrew/bin/rtk',
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // ignore
    }
  }
  return null
}

function fileContains(filePath: string, search: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    const content = fs.readFileSync(filePath, 'utf8')
    return content.includes(search)
  } catch {
    return false
  }
}

export function detectAgentHooks(): RTKAgent[] {
  const home = os.homedir()
  const agents: RTKAgent[] = []

  // 1. Codex
  const codexDir = path.join(home, '.codex')
  if (fs.existsSync(codexDir)) {
    const hasHook = fileContains(path.join(codexDir, 'hooks.json'), 'rtk hook codex') ||
      fs.existsSync(path.join(codexDir, 'RTK.md')) ||
      fileContains(path.join(codexDir, 'AGENTS.md'), 'RTK.md')
    agents.push({
      id: 'codex',
      name: 'Codex',
      icon: 'openai',
      on: hasHook,
    })
  }

  // 2. Claude Code
  const claudeDir = path.join(home, '.claude')
  if (fs.existsSync(claudeDir)) {
    const hasHook = fileContains(path.join(claudeDir, 'settings.json'), 'rtk hook claude') ||
      fs.existsSync(path.join(claudeDir, 'RTK.md'))
    agents.push({
      id: 'claude',
      name: 'Claude Code',
      icon: 'anthropic',
      on: hasHook,
    })
  }

  // 3. Gemini CLI
  const geminiDir = path.join(home, '.gemini')
  if (fs.existsSync(geminiDir)) {
    const hasHook = fileContains(path.join(geminiDir, 'settings.json'), 'rtk-hook-gemini')
    agents.push({
      id: 'gemini',
      name: 'Gemini CLI',
      icon: 'google',
      on: hasHook,
    })
  }

  // 4. Cursor
  const cursorDir = path.join(home, '.cursor')
  if (fs.existsSync(cursorDir)) {
    const hasHook = fileContains(path.join(cursorDir, 'hooks.json'), 'rtk hook cursor')
    agents.push({
      id: 'cursor',
      name: 'Cursor',
      icon: 'cursor',
      on: hasHook,
    })
  }

  // 5. Oh My Pi (omp)
  const ompDir = path.join(home, '.omp')
  if (fs.existsSync(ompDir)) {
    const hasHook = fs.existsSync(path.join(ompDir, 'agent/extensions/rtk.ts'))
    agents.push({
      id: 'omp',
      name: 'Oh My Pi',
      icon: 'pi',
      on: hasHook,
    })
  }

  // 6. Copilot
  const copilotDir = path.join(home, '.copilot')
  if (fs.existsSync(copilotDir)) {
    const hasHook = fs.existsSync(path.join(copilotDir, 'hooks/rtk-rewrite.json'))
    agents.push({
      id: 'copilot',
      name: 'GitHub Copilot',
      icon: 'github',
      on: hasHook,
    })
  }

  return agents
}

export async function getRTKStats(binPath: string): Promise<{ version: string | null; gain: RTKGainStats | null; days: RTKDayStats[] }> {
  let version: string | null = null
  let gain: RTKGainStats | null = null
  const days: RTKDayStats[] = []

  try {
    const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 5000 })
    const match = /rtk\s+([v0-9.]+)/i.exec(stdout.trim())
    version = match ? match[1] : stdout.trim()
  } catch {
    // version query failed
  }

  try {
    const env = { ...process.env }
    const { stdout } = await execFileAsync(binPath, ['gain', '--daily', '--format', 'json'], {
      timeout: 10000,
      env,
    })
    const parsed = JSON.parse(stdout) as {
      summary?: {
        total_commands?: number
        total_input?: number
        total_saved?: number
        avg_savings_pct?: number
      }
      daily?: Array<{
        date?: string
        commands?: number
        input_tokens?: number
        saved_tokens?: number
        savings_pct?: number
      }>
    }
    if (parsed.summary) {
      gain = {
        commands: Number(parsed.summary.total_commands) || 0,
        input: Number(parsed.summary.total_input) || 0,
        saved: Number(parsed.summary.total_saved) || 0,
        pct: Number(parsed.summary.avg_savings_pct) || 0,
      }
    }
    if (Array.isArray(parsed.daily)) {
      for (const d of parsed.daily) {
        if (!d.date) continue
        days.push({
          date: d.date,
          commands: Number(d.commands) || 0,
          input: Number(d.input_tokens) || 0,
          saved: Number(d.saved_tokens) || 0,
          pct: Number(d.savings_pct) || 0,
        })
      }
      days.sort((a, b) => a.date.localeCompare(b.date))
    }
  } catch {
    try {
      const { stdout } = await execFileAsync(binPath, ['gain', '--daily', '--format', 'json'], {
        timeout: 10000,
        env: { ...process.env, HOME: '/tmp' },
      })
      const parsed = JSON.parse(stdout)
      if (parsed.summary) {
        gain = {
          commands: Number(parsed.summary.total_commands) || 0,
          input: Number(parsed.summary.total_input) || 0,
          saved: Number(parsed.summary.total_saved) || 0,
          pct: Number(parsed.summary.avg_savings_pct) || 0,
        }
      }
    } catch {
      gain = { commands: 0, input: 0, saved: 0, pct: 0 }
    }
  }

  return { version, gain, days }
}

export async function readRTKStatus(): Promise<RTKView> {
  const bin = findRTKBinary()
  const agents = detectAgentHooks()

  if (!bin) {
    return {
      connected: false,
      path: null,
      version: null,
      gain: null,
      days: [],
      latest: 'v0.50.0',
      agents,
      url: RTK_URL,
      install: 'curl -fsSL https://www.rtk-ai.app/install.sh | sh',
    }
  }

  const { version, gain, days } = await getRTKStats(bin)

  return {
    connected: true,
    path: bin,
    version: version || '0.50.0',
    gain,
    days,
    latest: 'v0.50.0',
    agents,
    url: RTK_URL,
  }
}

export async function setRTKAgentHook(agentId: string, on: boolean): Promise<RTKView> {
  const bin = findRTKBinary()
  const home = os.homedir()

  if (agentId === 'codex') {
    const codexDir = path.join(home, '.codex')
    const hooksFile = path.join(codexDir, 'hooks.json')
    if (fs.existsSync(codexDir)) {
      if (on) {
        let hooks: Record<string, unknown> = {}
        try {
          if (fs.existsSync(hooksFile)) hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'))
        } catch { /* ignore */ }
        hooks.hooks = hooks.hooks || {}
        ;(hooks.hooks as Record<string, unknown>).PreToolUse = [
          { command: 'rtk hook codex' },
        ]
        fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2))
      } else {
        try {
          if (fs.existsSync(hooksFile)) {
            const raw = fs.readFileSync(hooksFile, 'utf8')
            const cleaned = raw.replace(/"command":\s*"rtk hook codex"/g, '"command": ""')
            fs.writeFileSync(hooksFile, cleaned)
          }
        } catch { /* ignore */ }
      }
    }
  } else if (agentId === 'claude') {
    const claudeDir = path.join(home, '.claude')
    const settingsFile = path.join(claudeDir, 'settings.json')
    if (fs.existsSync(claudeDir)) {
      if (on) {
        let settings: Record<string, unknown> = {}
        try {
          if (fs.existsSync(settingsFile)) settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
        } catch { /* ignore */ }
        settings.hooks = settings.hooks || {}
        ;(settings.hooks as Record<string, unknown>).PreToolUse = [
          { command: 'rtk hook claude' },
        ]
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
      } else {
        try {
          if (fs.existsSync(settingsFile)) {
            const raw = fs.readFileSync(settingsFile, 'utf8')
            const cleaned = raw.replace(/"command":\s*"rtk hook claude"/g, '"command": ""')
            fs.writeFileSync(settingsFile, cleaned)
          }
        } catch { /* ignore */ }
      }
    }
  }

  if (bin) {
    try {
      if (on) {
        await execFileAsync(bin, ['init', '-g', `--${agentId}`], { timeout: 10000 })
      } else {
        await execFileAsync(bin, ['init', '--uninstall'], { timeout: 10000 })
      }
    } catch {
      // hook file updated
    }
  }

  return readRTKStatus()
}
