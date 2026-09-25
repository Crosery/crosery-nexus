import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { applyNginxUnlimitedPolicy } from './nginxUnlimitedApply.js'

const execFileAsync = promisify(execFile)
const policyPath = '/opt/crosery-api-console/data/nginx-unlimited-policy.json'
const statusPath = '/opt/crosery-api-console/data/nginx-unlimited-status.json'
const includePath = '/etc/nginx/generated/crosery-console-unlimited.conf'
const backupRoot = '/etc/nginx/backup/crosery-api-console'

async function run(command: string, args: string[]) {
  await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  })
}

try {
  const result = await applyNginxUnlimitedPolicy({
    policyPath,
    statusPath,
    includePath,
    backupRoot,
    runNginxTest: () => run('/usr/sbin/nginx', ['-t']),
    reloadNginx: () => run('/usr/bin/systemctl', ['reload', 'nginx.service']),
  })
  console.info(JSON.stringify({
    category: '[AUDIT]',
    event: 'nginx_unlimited_policy.apply',
    stage: 'root_worker',
    outcome: 'ok',
    changed: result.changed,
    unlimited_key_count: result.status.unlimitedKeyCount,
  }))
} catch (error) {
  console.error(JSON.stringify({
    category: '[ERROR]',
    event: 'nginx_unlimited_policy.apply_failed',
    stage: 'root_worker',
    code: error instanceof Error ? error.message : 'NGINX_UNLIMITED_APPLY_FAILED',
    outcome: 'error',
  }))
  process.exitCode = 1
}
