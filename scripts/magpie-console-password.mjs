import { execFileSync } from 'node:child_process'

export function consolePasswordEnvironment(manifest, { platform = process.platform, execute = execFileSync } = {}) {
  const reference = manifest.consolePasswordKeychain
  if (reference !== undefined) {
    if (manifest.consolePasswordFile !== undefined) throw new Error('Choose one Console password reference')
    if (platform !== 'darwin') throw new Error('Console Keychain passwords require macOS')
    if (!reference || typeof reference.service !== 'string' || !reference.service.trim()
      || typeof reference.account !== 'string' || !reference.account.trim()) {
      throw new Error('Console Keychain reference requires a service and account')
    }
    let password
    try {
      password = execute('/usr/bin/security', [
        'find-generic-password', '-s', reference.service, '-a', reference.account, '-w',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 })
        .replace(/[\r\n]+$/u, '')
      if (!password || password.includes('\0')) throw new Error('Invalid password')
    } catch {
      // Child-process errors can include captured credential output.
      throw new Error('Unable to read the local Console password from Keychain')
    }
    return { CONSOLE_PASSWORD: password }
  }
  if (typeof manifest.consolePasswordFile !== 'string' || !manifest.consolePasswordFile.trim()) {
    throw new Error('A Console password reference is required')
  }
  return { CONSOLE_PASSWORD_FILE: manifest.consolePasswordFile }
}
