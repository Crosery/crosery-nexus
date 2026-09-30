import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAGPIE_API_REVISION, MAGPIE_API_ROUTES, MAGPIE_LOGIN_AGENTS } from '../packages/contracts/magpie-upstream.generated.js'
import type { MagpieUpstreamStatus } from '../packages/contracts/magpie-upstream.js'

const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const list = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 2000 || value.some(item => typeof item !== 'string' || item.length > 500)) {
    throw new Error('Invalid upstream diff')
  }
  return value
}
const optionalTag = (value: unknown): string | null => typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]*)$/.test(value) ? value : null

export function readMagpieUpstreamStatus(activeRevision: string, filename = path.join(
  process.env.MAGPIE_UPSTREAM_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-upstream'), 'status.json',
)): MagpieUpstreamStatus {
  const result: MagpieUpstreamStatus = {
    status: 'not_checked', contractRevision: MAGPIE_API_REVISION, candidateRevision: null, checkedAt: null,
    latestRelease: null, rtkRelease: null,
    routes: {
      inference: MAGPIE_API_ROUTES.filter(route => route.surface === 'inference').length,
      management: MAGPIE_API_ROUTES.filter(route => route.surface === 'management').length,
      rtk: MAGPIE_API_ROUTES.filter(route => route.path.startsWith('/api/library/rtk')).length,
    },
    loginAgents: [...MAGPIE_LOGIN_AGENTS],
    changes: { addedRoutes: [], removedRoutes: [], changedRoutes: [], schemaCount: 0, implementationFileCount: 0, addedLoginAgents: [], removedLoginAgents: [] },
    oauthConnected: false, rtkConnected: false,
  }
  if (activeRevision !== MAGPIE_API_REVISION) {
    result.status = 'baseline_mismatch'
    return result
  }
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new Error('Invalid status file')
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (value.version !== 1 || !['unchanged', 'review_required', 'error'].includes(value.status) ||
        value.baselineRevision !== MAGPIE_API_REVISION || !revision(value.candidateRevision) ||
        typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) throw new Error('Invalid upstream status')
    const diff = value.diff
    result.changes = {
      addedRoutes: list(diff.addedRoutes), removedRoutes: list(diff.removedRoutes), changedRoutes: list(diff.changedRoutes),
      schemaCount: list(diff.changedSchemas).length, implementationFileCount: list(diff.implementationFiles).length,
      addedLoginAgents: list(diff.addedLoginAgents), removedLoginAgents: list(diff.removedLoginAgents),
    }
    result.status = value.status
    result.candidateRevision = value.candidateRevision
    result.checkedAt = value.checkedAt
    result.latestRelease = optionalTag(value.latestRelease)
    result.rtkRelease = optionalTag(value.rtkRelease)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) result.status = 'error'
  }
  return result
}
